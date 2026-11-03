/**
 * 巨鲸手动回溯（manual-stats）：按周期 + 勾选频道拉取/ingest，不写 inline 盈亏。
 * 限速：频道间 KOLVIP_API_CHANNEL_DELAY_MS；同频道翻页 KOLVIP_MANUAL_BACKFILL_PAGE_DELAY_MS。
 */
import { config } from "./config.js";
import {
  DISCORD_BACKFILL_PERIODS,
  normalizeDiscordBackfillPeriod,
  stripBackfillGroupPnl,
} from "./discord-backfill-engine.js";
import { extractSymbolFromPayload } from "./card-fields.js";
import { normalizeBackfillDirection } from "./backfill-batch-eval.js";
import { dedupeBackfillGroupCards } from "./backfill-card-dedup.js";
import { executionFromParsed } from "./discord-signal-execution.js";
import { resolveCardSignalAt } from "./discord-signal-card-service.js";
import { cardRowParsed } from "./discord-signal-staged-trade.js";
import {
  getKolvipChannelMappings,
  getKolvipMappedKolvipChannelIds,
  getKolvipMappingByKolvipId,
} from "./kolvip-cdp-config.js";
import { kolvipApiFetchChannelMessages, KolvipApiError } from "./kolvip-api-client.js";
import { buildKolvipApiClient } from "./kolvip-api-fetch.js";
import { kolvipApiRawToDomMessage } from "./kolvip-api-message.js";
import {
  loadKolvipCatalogCache,
  listKolvipBrowseChannels,
} from "./kolvip-api-catalog.js";
import { ingestKolvipMessageBatch } from "./kolvip-ingest.js";
import { kolvipScanVirtualChannelId } from "./kolvip-scan-config.js";
import { createLogger } from "./logger.js";

const log = createLogger("kolvip-manual-backfill");

export const KOLVIP_BACKFILL_PERIODS = DISCORD_BACKFILL_PERIODS;
export const normalizeKolvipBackfillPeriod = normalizeDiscordBackfillPeriod;

export function kolvipBackfillPeriodBounds(period) {
  const key = normalizeKolvipBackfillPeriod(period);
  const days = KOLVIP_BACKFILL_PERIODS[key]?.days ?? 7;
  const toMs = Date.now();
  const fromMs = toMs - days * 86400000;
  return { period: key, days, fromMs, toMs };
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

function pageDelayMs() {
  const env = Number(process.env.KOLVIP_MANUAL_BACKFILL_PAGE_DELAY_MS);
  if (Number.isFinite(env) && env >= 0) return env;
  return Math.max(800, Number(config.kolvipApiChannelDelayMs) || 800);
}

function channelDelayMs() {
  return Math.max(0, Number(config.kolvipApiChannelDelayMs) || 800);
}

function maxPagesPerChannel() {
  const env = Number(process.env.KOLVIP_MANUAL_BACKFILL_MAX_PAGES);
  if (Number.isFinite(env) && env > 0) return Math.min(80, env);
  return 40;
}

function batchSize() {
  return Math.min(150, Math.max(10, Number(config.kolvipBackfillBatchSize) || 40));
}

/**
 * 配置频道列表：精选映射（logicName）优先，再并入目录 browse 频道。
 * @returns {Promise<Array<{ channelId: string, name: string, curated: boolean, discordChannelId?: string, note?: string }>>}
 */
export async function loadKolvipManualBackfillGroups() {
  const curatedIds = getKolvipMappedKolvipChannelIds();
  /** @type {Map<string, { channelId: string, name: string, curated: boolean, discordChannelId?: string, note?: string }>} */
  const byId = new Map();
  for (const m of getKolvipChannelMappings()) {
    byId.set(String(m.kolvipChannelId), {
      channelId: String(m.kolvipChannelId),
      name: m.logicName,
      curated: true,
      discordChannelId: m.discordChannelId,
      note: "精选跟单",
    });
  }
  try {
    const catalog = await loadKolvipCatalogCache();
    for (const ch of listKolvipBrowseChannels(catalog)) {
      const kid = String(ch.kolvipChannelId);
      if (byId.has(kid)) {
        const cur = byId.get(kid);
        // 保留 logicName；目录名写入 note
        if (ch.name && cur.name !== ch.name) {
          cur.note = cur.note ? `${cur.note} · ${ch.name}` : ch.name;
        }
        continue;
      }
      byId.set(kid, {
        channelId: kid,
        name: String(ch.name || `ch-${kid}`),
        curated: curatedIds.has(kid),
        discordChannelId: kolvipScanVirtualChannelId(kid),
        note: "全站备选",
      });
    }
  } catch (e) {
    log.warn(`加载巨鲸目录失败（仍返回精选）: ${String(/** @type {Error} */ (e).message ?? e)}`);
  }
  const groups = [...byId.values()];
  groups.sort((a, b) => {
    if (a.curated !== b.curated) return a.curated ? -1 : 1;
    return String(a.name).localeCompare(String(b.name), "zh");
  });
  return groups;
}

/**
 * @param {Record<string, unknown>} row
 * @param {string} channelId discord/virtual channel id
 */
function signalCardRowToBackfillCard(row, channelId) {
  const parsed = cardRowParsed(row);
  if (!parsed) return null;
  const execution = executionFromParsed(parsed);
  const sym = extractSymbolFromPayload(parsed, execution);
  const dirNorm = normalizeBackfillDirection(parsed.direction ?? execution.direction);
  const phase = String(parsed.signalPhase ?? "full");
  if (phase === "tpsl") return null;
  if (!sym || !dirNorm) return null;
  const signalAt = String(resolveCardSignalAt(row) ?? "").trim();
  if (!signalAt) return null;
  const entry = execution.planned?.entryPrice ?? parsed.entry ?? "";
  const stopLoss = execution.planned?.stopLossPrice ?? parsed.stopLoss ?? "";
  const targets = execution.planned?.takeProfitPrices ?? parsed.targets ?? [];
  const preview = String(row.raw_content ?? row.rawContent ?? "").slice(0, 160);
  const messageId = String(row.message_id ?? row.messageId ?? row.id ?? "").trim();
  return {
    phase,
    symbol: sym,
    direction: parsed.direction ?? execution.direction,
    directionNorm: dirNorm,
    messageId,
    signalAt,
    entry: String(entry ?? "").trim() || null,
    stopLoss: String(stopLoss ?? "").trim() || null,
    targets,
    preview,
    digest: `${signalAt}|${sym}|${phase}`,
    cardPayload: {
      symbol: sym,
      direction: dirNorm,
      entry,
      stopLoss,
      targets,
      signalAt,
      body: preview,
      channelId,
      messageId,
      signalCardId: row.id,
      parser: parsed.parser,
    },
  };
}

/**
 * @param {import("./store.js").StoreLike} store
 * @param {string} discordChannelId
 * @param {number} fromMs
 * @param {number} toMs
 */
async function loadBackfillCardsFromStore(store, discordChannelId, fromMs, toMs) {
  if (!store?.listSignalCards) return [];
  const rows = await store.listSignalCards({
    channelId: discordChannelId,
    fromMs: fromMs > 0 ? fromMs : undefined,
    toMs: toMs > 0 ? toMs : undefined,
    limit: 500,
  });
  /** @type {Array<Record<string, unknown>>} */
  const cards = [];
  /** @type {Record<string, number>} */
  const symbols = {};
  for (const row of rows ?? []) {
    const c = signalCardRowToBackfillCard(row, discordChannelId);
    if (!c) continue;
    cards.push(c);
    const sym = String(c.symbol ?? "");
    if (sym) symbols[sym] = (symbols[sym] ?? 0) + 1;
  }
  return { cards, symbols, messageCount: rows?.length ?? 0 };
}

/**
 * 拉取单频道历史（向更早翻页），ingest 但不清算；返回 Discord 风格 group。
 * @param {{
 *   store: import("./store.js").StoreLike,
 *   signalCards: NonNullable<Parameters<typeof ingestKolvipMessageBatch>[0]['signalCards']>,
 *   client: { baseUrl: string, wtoken: string, timeoutMs?: number },
 *   group: { channelId: string, name: string, curated?: boolean, discordChannelId?: string },
 *   fromMs: number,
 *   toMs: number,
 *   shouldAbort?: () => boolean,
 *   onProgress?: (patch: Record<string, unknown>) => void,
 * }} opts
 */
export async function pullAndIngestKolvipChannel(opts) {
  const kid = String(opts.group.channelId).trim();
  const mapping = getKolvipMappingByKolvipId(kid);
  const curated = Boolean(opts.group.curated ?? mapping);
  const name = String(opts.group.name || mapping?.logicName || kid);
  const discordChannelId =
    String(opts.group.discordChannelId || "").trim() ||
    (mapping ? mapping.discordChannelId : kolvipScanVirtualChannelId(kid));

  let beforeId = 0;
  let pagesDone = 0;
  let fetchedTotal = 0;
  let cardsCreated = 0;
  let sourceUpgraded = 0;
  let hitPastWindow = false;
  const maxPages = maxPagesPerChannel();
  const limit = batchSize();
  const delayPage = pageDelayMs();

  opts.onProgress?.({ channelId: kid, name, phase: "start" });

  for (let page = 0; page < maxPages; page += 1) {
    if (opts.shouldAbort?.()) throw new Error("用户停止");
    if (page > 0 && delayPage > 0) await sleepMs(delayPage);

    opts.onProgress?.({
      channelId: kid,
      name,
      phase: "fetch",
      pagesDone,
      beforeId,
    });

    let raw;
    try {
      raw = await kolvipApiFetchChannelMessages(opts.client, kid, { beforeId, limit });
    } catch (e) {
      const msg = e instanceof KolvipApiError ? e.message : String(/** @type {Error} */ (e).message ?? e);
      return {
        channelId: kid,
        name,
        curated,
        discordChannelId,
        ok: false,
        error: msg,
        scrollPages: pagesDone,
        messageCount: fetchedTotal,
        tradeLikeCount: 0,
        parsedSignalCount: 0,
        cardEmitCount: 0,
        symbols: {},
        samples: [],
        cards: [],
        cardsCreated,
      };
    }

    const dom = (raw ?? [])
      .map((r) => kolvipApiRawToDomMessage(r))
      .filter((m) => m.dataId)
      .sort((a, b) => Number(a.dataId) - Number(b.dataId));

    if (!dom.length) break;

    pagesDone += 1;
    fetchedTotal += dom.length;

    const inWindow = dom.filter((m) => {
      const ms = Date.parse(m.timeTitle || "");
      if (!Number.isFinite(ms)) return true;
      if (opts.fromMs > 0 && ms < opts.fromMs) return false;
      if (opts.toMs > 0 && ms > opts.toMs) return false;
      return true;
    });

    const oldest = dom[0];
    const oldestMs = Date.parse(oldest.timeTitle || "");
    if (Number.isFinite(oldestMs) && oldestMs < opts.fromMs) {
      hitPastWindow = true;
    }

    if (inWindow.length) {
      opts.onProgress?.({
        channelId: kid,
        name,
        phase: "ingest",
        pagesDone,
        messageTotal: inWindow.length,
      });
      const ingestResult = await ingestKolvipMessageBatch({
        kolvipChannelId: kid,
        channelName: name,
        messages: inWindow,
        mode: "backfill",
        curated,
        signalCards: opts.signalCards,
        store: opts.store,
        log,
        skipLiquidation: true,
      });
      cardsCreated += ingestResult.cardsCreated;
      sourceUpgraded += ingestResult.sourceUpgraded || 0;
    }

    beforeId = Number(oldest.dataId) || beforeId;
    if (hitPastWindow || dom.length < limit) break;
    if (opts.shouldAbort?.()) throw new Error("用户停止");
  }

  opts.onProgress?.({ channelId: kid, name, phase: "parse", pagesDone, cardsCreated });

  const loaded = await loadBackfillCardsFromStore(
    opts.store,
    discordChannelId,
    opts.fromMs,
    opts.toMs,
  );
  const samples = loaded.cards.slice(0, 8).map((c) => ({
    phase: c.phase,
    symbol: c.symbol,
    direction: c.direction,
    preview: c.preview,
    messageId: c.messageId,
    signalAt: c.signalAt,
  }));

  const group = dedupeBackfillGroupCards({
    channelId: kid,
    name,
    curated,
    discordChannelId,
    ok: true,
    error: null,
    scrollPages: pagesDone,
    messageCount: fetchedTotal,
    tradeLikeCount: loaded.cards.length,
    parsedSignalCount: loaded.cards.length,
    cardEmitCount: loaded.cards.length,
    cardsCreated,
    sourceUpgraded,
    symbols: loaded.symbols,
    samples,
    cards: loaded.cards,
  });
  return stripBackfillGroupPnl(group);
}

/**
 * @param {{
 *   store: import("./store.js").StoreLike,
 *   signalCards: NonNullable<Parameters<typeof ingestKolvipMessageBatch>[0]['signalCards']>,
 *   groups: Array<{ channelId: string, name: string, curated?: boolean, discordChannelId?: string }>,
 *   period: string,
 *   shouldAbort?: () => boolean,
 *   onProgress?: (patch: Record<string, unknown>) => void,
 * }} opts
 */
export async function runKolvipManualBackfillScan(opts) {
  const { period: periodKey, days, fromMs, toMs } = kolvipBackfillPeriodBounds(opts.period);
  const { client } = await buildKolvipApiClient(log);
  /** @type {Array<Record<string, unknown>>} */
  const results = [];
  const chDelay = channelDelayMs();

  for (let i = 0; i < opts.groups.length; i += 1) {
    if (opts.shouldAbort?.()) throw new Error("用户停止");
    if (i > 0 && chDelay > 0) await sleepMs(chDelay);
    const g = opts.groups[i];
    try {
      const row = await pullAndIngestKolvipChannel({
        store: opts.store,
        signalCards: opts.signalCards,
        client,
        group: g,
        fromMs,
        toMs,
        shouldAbort: opts.shouldAbort,
        onProgress: opts.onProgress,
      });
      results.push(row);
      log.info(
        `巨鲸手动回溯 ${g.name} ch=${g.channelId}: pages=${row.scrollPages ?? 0} cards=${row.parsedSignalCount ?? 0}`,
      );
    } catch (e) {
      if (String(/** @type {Error} */ (e).message ?? e) === "用户停止") throw e;
      results.push({
        channelId: String(g.channelId),
        name: String(g.name ?? g.channelId),
        ok: false,
        error: String(/** @type {Error} */ (e).message ?? e),
        messageCount: 0,
        tradeLikeCount: 0,
        parsedSignalCount: 0,
        cardEmitCount: 0,
        symbols: {},
        samples: [],
        cards: [],
      });
    }
  }

  const ranking = [...results].sort(
    (a, b) =>
      Number(b.cardEmitCount ?? b.parsedSignalCount ?? 0) -
        Number(a.cardEmitCount ?? a.parsedSignalCount ?? 0) ||
      Number(b.tradeLikeCount ?? 0) - Number(a.tradeLikeCount ?? 0),
  );

  return {
    ok: true,
    replayMode: "kolvip_api_ingest",
    parseOnly: true,
    period: periodKey,
    periodDays: days,
    fromMs,
    toMs,
    generatedAt: new Date().toISOString(),
    groupCount: results.length,
    groups: results,
    ranking,
    backtestEnrichedAt: undefined,
    throttle: {
      channelDelayMs: chDelay,
      pageDelayMs: pageDelayMs(),
      maxPages: maxPagesPerChannel(),
      batchSize: batchSize(),
    },
  };
}
