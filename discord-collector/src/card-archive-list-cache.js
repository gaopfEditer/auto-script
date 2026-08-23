/**
 * 卡片归档列表服务端缓存：archiveCardToClient 只算一次，多前端分发。
 * 支持 sinceId 增量追加。
 */
import { archiveCardToClient, resolveCardChannelName, resolveSourcePlatform, normalizeCardSourceType } from "./card-archive-service.js";

/**
 * @param {string[] | undefined} sourceTypes
 * @param {string | undefined} sourceType
 */
function normalizeArchiveSourceTypes(sourceTypes, sourceType) {
  const fromArr = Array.isArray(sourceTypes)
    ? sourceTypes.map((s) => String(s).trim().toLowerCase()).filter(Boolean)
    : [];
  if (fromArr.length) return [...new Set(fromArr)];
  const single = String(sourceType ?? "").trim().toLowerCase();
  return single ? [single] : [];
}

/**
 * @param {unknown} cardSourceType
 * @param {string[]} sourceTypes
 */
export function archiveCardMatchesSourceTypes(cardSourceType, sourceTypes) {
  const list = normalizeArchiveSourceTypes(sourceTypes);
  if (!list.length) return true;
  const st = normalizeCardSourceType(cardSourceType);
  const platform = resolveSourcePlatform(st);
  return list.some((want) => st === want || platform === want);
}

/**
 * @param {{
 *   channelId?: string,
 *   status?: string,
 *   sourceType?: string,
 *   sourceTypes?: string[],
 *   symbol?: string,
 *   fromMs?: number,
 *   toMs?: number,
 *   limit?: number,
 * }} filters
 */
export function archiveListFilterKey(filters) {
  const lim = Math.min(500, Math.max(1, Number(filters.limit) || 50));
  const srcKey = normalizeArchiveSourceTypes(filters.sourceTypes, filters.sourceType).sort().join(",");
  return [
    srcKey,
    String(filters.channelId ?? "").trim(),
    String(filters.symbol ?? "").trim().toUpperCase(),
    String(filters.status ?? "").trim(),
    Number(filters.fromMs) || 0,
    Number(filters.toMs) || 0,
    lim,
  ].join("|");
}

/**
 * @param {Record<string, unknown>} card
 * @param {{
 *   channelId?: string,
 *   status?: string,
 *   sourceType?: string,
 *   sourceTypes?: string[],
 *   symbol?: string,
 *   fromMs?: number,
 *   toMs?: number,
 * }} filters
 */
export function archiveCardMatchesListFilters(card, filters) {
  if (!card || typeof card !== "object") return false;
  const ch = String(filters.channelId ?? "").trim();
  if (ch && String(card.channelId ?? "").trim() !== ch) return false;
  const st = String(filters.status ?? "").trim();
  if (st && String(card.status ?? "").trim() !== st) return false;
  const srcList = normalizeArchiveSourceTypes(filters.sourceTypes, filters.sourceType);
  if (srcList.length && !archiveCardMatchesSourceTypes(card.sourceType, srcList)) return false;
  const sym = String(filters.symbol ?? "").trim().toUpperCase();
  if (sym) {
    const cs = String(card.symbol ?? "").trim().toUpperCase();
    const bare = sym.replace(/USDT$/, "");
    const csBare = cs.replace(/USDT$/, "");
    if (cs !== sym && cs !== bare && csBare !== bare && !cs.startsWith(bare)) return false;
  }
  const t = cardSignalTimeMs(card);
  const fromMs = Number(filters.fromMs);
  const toMs = Number(filters.toMs);
  if (Number.isFinite(fromMs) && fromMs > 0 && t < fromMs) return false;
  if (Number.isFinite(toMs) && toMs > 0 && t > toMs) return false;
  return true;
}

/** @param {Record<string, unknown>} card */
function cardSignalTimeMs(card) {
  const raw = card.signalAt ?? card.createdAt ?? card.created_at;
  const ms = new Date(String(raw ?? "")).getTime();
  return Number.isFinite(ms) ? ms : 0;
}

/** @param {ReturnType<typeof archiveCardToClient>[]} cards */
function sortArchiveCardsDesc(cards) {
  cards.sort((a, b) => {
    const ta = cardSignalTimeMs(a);
    const tb = cardSignalTimeMs(b);
    if (tb !== ta) return tb - ta;
    return Number(b.id) - Number(a.id);
  });
}

/**
 * @param {ReturnType<typeof archiveCardToClient>[]} cards
 * @param {number} limit
 */
function trimArchiveCards(cards, limit) {
  const lim = Math.min(500, Math.max(1, limit));
  if (cards.length > lim) cards.length = lim;
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} [log]
 */
export function createCardArchiveListCache(store, log) {
  /** @type {Map<string, { filters: Record<string, unknown>, cards: ReturnType<typeof archiveCardToClient>[], maxId: number, builtAt: number }>} */
  const buckets = new Map();

  /** @type {Map<string, { channels: Array<{ channelId: string, channelName: string, count: number }>, builtAt: number }>} */
  const channelBuckets = new Map();

  /**
   * @param {{
   *   channelId?: string,
   *   status?: string,
   *   sourceType?: string,
   *   symbol?: string,
   *   fromMs?: number,
   *   toMs?: number,
   *   limit?: number,
   * }} filters
   */
  function channelFilterKey(filters) {
    const srcKey = normalizeArchiveSourceTypes(filters.sourceTypes, filters.sourceType).sort().join(",");
    return [
      srcKey,
      String(filters.symbol ?? "").trim().toUpperCase(),
      String(filters.status ?? "").trim(),
      Number(filters.fromMs) || 0,
      Number(filters.toMs) || 0,
    ].join("|");
  }

  /**
   * @param {ReturnType<typeof archiveCardToClient>} card
   * @param {{
   *   channelId?: string,
   *   status?: string,
   *   sourceType?: string,
   *   symbol?: string,
   *   fromMs?: number,
   *   toMs?: number,
   *   limit?: number,
   * }} filters
   */
  function upsertInBucket(card, filters) {
    const key = archiveListFilterKey(filters);
    let bucket = buckets.get(key);
    if (!bucket) {
      bucket = {
        filters: { ...filters },
        cards: [],
        maxId: 0,
        builtAt: Date.now(),
      };
      buckets.set(key, bucket);
    }
    const id = Number(card.id);
    if (!Number.isFinite(id) || id <= 0) return;
    const idx = bucket.cards.findIndex((c) => Number(c.id) === id);
    if (idx >= 0) bucket.cards[idx] = card;
    else bucket.cards.push(card);
    sortArchiveCardsDesc(bucket.cards);
    trimArchiveCards(bucket.cards, Number(filters.limit) || 200);
    bucket.maxId = Math.max(bucket.maxId, id, ...bucket.cards.map((c) => Number(c.id) || 0));
    bucket.builtAt = Date.now();
    channelBuckets.clear();
  }

  /**
   * @param {number} cardId
   */
  function removeFromBuckets(cardId) {
    const id = Number(cardId);
    if (!Number.isFinite(id) || id <= 0) return;
    for (const bucket of buckets.values()) {
      const next = bucket.cards.filter((c) => Number(c.id) !== id);
      if (next.length !== bucket.cards.length) {
        bucket.cards = next;
        bucket.maxId = next.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0);
        bucket.builtAt = Date.now();
      }
    }
    channelBuckets.clear();
  }

  /**
   * @param {ReturnType<typeof archiveCardToClient>} card
   */
  function onClientCardChanged(card) {
    if (!card || typeof card !== "object") return;
    for (const bucket of buckets.values()) {
      if (archiveCardMatchesListFilters(card, bucket.filters)) {
        upsertInBucket(card, bucket.filters);
      }
    }
  }

  /**
   * @param {Record<string, unknown>} row
   */
  function onRowChanged(row) {
    if (!row) return;
    try {
      onClientCardChanged(archiveCardToClient(row));
    } catch (e) {
      log?.warn?.(`卡片列表缓存更新失败: ${/** @type {Error} */ (e).message}`);
    }
  }

  /**
   * @param {{
   *   channelId?: string,
   *   status?: string,
   *   sourceType?: string,
   *   symbol?: string,
   *   fromMs?: number,
   *   toMs?: number,
   *   limit?: number,
   * }} filters
   * @param {{ sinceId?: number, force?: boolean }} [opts]
   */
  async function list(filters, opts = {}) {
    const lim = Math.min(500, Math.max(1, Number(filters.limit) || 50));
    const normalized = { ...filters, limit: lim };
    const key = archiveListFilterKey(normalized);
    const sinceId = Number(opts.sinceId);
    const force = Boolean(opts.force);

    if (force) {
      buckets.delete(key);
    }

    const bucket = buckets.get(key);

    if (Number.isFinite(sinceId) && sinceId > 0 && bucket && !force) {
      if (sinceId >= bucket.maxId) {
        return {
          cards: [],
          maxId: bucket.maxId,
          total: bucket.cards.length,
          incremental: true,
          cached: true,
        };
      }
      const rows = await store.listSignalCards({
        ...normalized,
        sinceId,
        limit: Math.min(100, lim),
      }) ?? [];
      if (!rows.length) {
        return {
          cards: [],
          maxId: bucket.maxId,
          total: bucket.cards.length,
          incremental: true,
          cached: true,
        };
      }
      const newCards = rows.map((r) => archiveCardToClient(r));
      const existingIds = new Set(bucket.cards.map((c) => Number(c.id)));
      /** @type {ReturnType<typeof archiveCardToClient>[]} */
      const appended = [];
      for (const c of newCards) {
        const id = Number(c.id);
        if (!existingIds.has(id)) {
          appended.push(c);
          existingIds.add(id);
        } else {
          const idx = bucket.cards.findIndex((x) => Number(x.id) === id);
          if (idx >= 0) bucket.cards[idx] = c;
        }
      }
      if (appended.length) bucket.cards.push(...appended);
      sortArchiveCardsDesc(bucket.cards);
      trimArchiveCards(bucket.cards, lim);
      bucket.maxId = Math.max(
        bucket.maxId,
        ...bucket.cards.map((c) => Number(c.id) || 0),
        ...newCards.map((c) => Number(c.id) || 0)
      );
      bucket.builtAt = Date.now();
      return {
        cards: appended,
        maxId: bucket.maxId,
        total: bucket.cards.length,
        incremental: true,
        cached: true,
      };
    }

    if (bucket && !force) {
      return {
        cards: bucket.cards,
        maxId: bucket.maxId,
        total: bucket.cards.length,
        incremental: false,
        cached: true,
      };
    }

    const rows = (await store.listSignalCards(normalized)) ?? [];
    const cards = rows.map((r) => archiveCardToClient(r));
    const maxId = cards.reduce((m, c) => Math.max(m, Number(c.id) || 0), 0);
    buckets.set(key, {
      filters: { ...normalized },
      cards,
      maxId,
      builtAt: Date.now(),
    });
    channelBuckets.clear();
    log?.info?.(
      `卡片列表缓存重建 key=${key.slice(0, 48)}… count=${cards.length} maxId=${maxId}`
    );
    return {
      cards,
      maxId,
      total: cards.length,
      incremental: false,
      cached: false,
    };
  }

  /**
   * @param {{
   *   status?: string,
   *   sourceType?: string,
   *   symbol?: string,
   *   fromMs?: number,
   *   toMs?: number,
   * }} filters
   * @param {{ force?: boolean }} [opts]
   */
  async function listChannels(filters, opts = {}) {
    const key = channelFilterKey(filters);
    if (opts.force) channelBuckets.delete(key);
    const hit = channelBuckets.get(key);
    if (hit && !opts.force) {
      return { channels: hit.channels, cached: true };
    }
    const rows = (await store.listSignalCardChannels(filters)) ?? [];
    const channels = rows.map((r) => ({
      channelId: String(r.channel_id ?? ""),
      channelName: resolveCardChannelName(r.channel_id, r.channel_name),
      count: Number(r.cnt ?? 0),
    }));
    channelBuckets.set(key, { channels, builtAt: Date.now() });
    return { channels, cached: false };
  }

  function clear() {
    buckets.clear();
    channelBuckets.clear();
  }

  return {
    list,
    listChannels,
    onClientCardChanged,
    onRowChanged,
    removeFromBuckets,
    clear,
  };
}
