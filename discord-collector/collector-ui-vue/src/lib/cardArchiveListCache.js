/**
 * 卡片归档 grid-panel 前端缓存 + 增量拉取。
 */
import { compareCardsByTimeDesc } from "./discordSignalApi.js";
import { buildArchivePeriodQuery, archiveSourcesCacheKey } from "./cardArchiveFilters.js";

const STORAGE_PREFIX = "dc_archive_cards_v1:";

/**
 * @param {Record<string, unknown>} opts
 */
export function archiveListClientKey(opts) {
  const period = buildArchivePeriodQuery(opts.period ?? opts.days ?? "");
  const sources = opts.sources
    ? archiveSourcesCacheKey(/** @type {string[]} */ (opts.sources))
    : String(opts.source ?? "").trim();
  return [
    sources,
    String(opts.channelId ?? "").trim(),
    String(opts.symbol ?? "").trim().toUpperCase(),
    String(opts.status ?? "").trim(),
    period.from ?? "",
    period.to ?? "",
    String(opts.limit ?? 200),
  ].join("|");
}

/**
 * @param {import("./cardArchiveApi.js").ArchiveCard[]} cards
 */
export function mergeArchiveCards(cards) {
  /** @type {Map<number, import("./cardArchiveApi.js").ArchiveCard>} */
  const map = new Map();
  for (const c of cards) {
    const id = Number(c.id);
    if (Number.isFinite(id) && id > 0) map.set(id, c);
  }
  const out = [...map.values()];
  out.sort(compareCardsByTimeDesc);
  return out;
}

/**
 * @param {import("./cardArchiveApi.js").ArchiveCard[]} cards
 */
export function archiveCardsMaxId(cards) {
  let max = 0;
  for (const c of cards) {
    const id = Number(c.id);
    if (Number.isFinite(id) && id > max) max = id;
  }
  return max;
}

/**
 * @param {string} key
 */
export function readArchiveListCache(key) {
  try {
    const raw = sessionStorage.getItem(STORAGE_PREFIX + key);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.cards)) return null;
    return {
      cards: /** @type {import("./cardArchiveApi.js").ArchiveCard[]} */ (j.cards),
      maxId: Number(j.maxId) || archiveCardsMaxId(j.cards),
      savedAt: Number(j.savedAt) || 0,
    };
  } catch {
    return null;
  }
}

/**
 * @param {string} key
 * @param {import("./cardArchiveApi.js").ArchiveCard[]} cards
 * @param {number} [maxId]
 */
export function writeArchiveListCache(key, cards, maxId) {
  try {
    const merged = mergeArchiveCards(cards);
    const payload = {
      cards: merged,
      maxId: maxId || archiveCardsMaxId(merged),
      savedAt: Date.now(),
    };
    sessionStorage.setItem(STORAGE_PREFIX + key, JSON.stringify(payload));
    return payload;
  } catch {
    return { cards: mergeArchiveCards(cards), maxId: archiveCardsMaxId(cards), savedAt: Date.now() };
  }
}

/**
 * @param {string} key
 */
export function clearArchiveListCache(key) {
  try {
    sessionStorage.removeItem(STORAGE_PREFIX + key);
  } catch {
    /* ignore */
  }
}

const CHANNEL_PREFIX = "dc_archive_channels_v1:";

/**
 * @param {Record<string, unknown>} opts
 */
export function readArchiveChannelsCache(key) {
  try {
    const raw = sessionStorage.getItem(CHANNEL_PREFIX + key);
    if (!raw) return null;
    const j = JSON.parse(raw);
    if (!j || !Array.isArray(j.channels)) return null;
    return /** @type {import("./cardArchiveApi.js").ArchiveChannelOption[]} */ (j.channels);
  } catch {
    return null;
  }
}

/**
 * @param {string} key
 * @param {import("./cardArchiveApi.js").ArchiveChannelOption[]} channels
 */
export function writeArchiveChannelsCache(key, channels) {
  try {
    sessionStorage.setItem(CHANNEL_PREFIX + key, JSON.stringify({ channels, savedAt: Date.now() }));
  } catch {
    /* ignore */
  }
}
