/**
 * 巨鲸频道胜率概览（复用 card-eval 聚合口径）。
 */
import { archiveCardToClient, resolveCardChannelName } from "./card-archive-service.js";
import { aggregateMetrics } from "./card-eval-api.js";
import { getKolvipChannelMappings } from "./kolvip-cdp-config.js";

/** @param {unknown[]} rows */
function rowsToCards(rows) {
  /** @type {ReturnType<typeof archiveCardToClient>[]} */
  const cards = [];
  for (const r of rows) {
    try {
      cards.push(archiveCardToClient(/** @type {Record<string, unknown>} */ (r)));
    } catch {
      /* ignore */
    }
  }
  return cards;
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {{ days?: number, minSample?: number }} [opts]
 */
export async function buildKolvipChannelEvalOverview(store, opts = {}) {
  const days = Math.min(90, Math.max(7, Number(opts.days) || 30));
  const minSample = Math.max(1, Number(opts.minSample) || 3);
  const toMs = Date.now();
  const fromMs = toMs - days * 86400000;
  const mappings = getKolvipChannelMappings();

  if (!store.listCardsForEval) {
    return {
      ok: true,
      fromMs,
      toMs,
      days,
      minSample,
      note: "offline store",
      channels: mappings.map((m) => ({
        logicName: m.logicName,
        kolvipChannelId: m.kolvipChannelId,
        discordChannelId: m.discordChannelId,
        parser: m.parser,
        sampleStatus: "offline",
        metrics: aggregateMetrics([]),
      })),
    };
  }

  const rows = await store.listCardsForEval({
    fromMs,
    toMs,
    limit: 5000,
  });
  const cards = rowsToCards(rows);
  /** @type {Map<string, typeof cards>} */
  const byDiscord = new Map();
  for (const card of cards) {
    const cid = String(card.channelId ?? "").trim();
    if (!cid) continue;
    if (!byDiscord.has(cid)) byDiscord.set(cid, []);
    byDiscord.get(cid)?.push(card);
  }

  const channels = mappings.map((m) => {
    const list = byDiscord.get(m.discordChannelId) ?? [];
    const metrics = aggregateMetrics(list);
    const decided = metrics.winCount + metrics.lossCount;
    let sampleStatus = "ok";
    if (decided < minSample && metrics.cardCount < minSample) {
      sampleStatus = metrics.cardCount === 0 ? "insufficient_sample" : "insufficient_sample";
    }
    if (decided >= minSample || metrics.cardCount >= minSample) {
      sampleStatus = "ok";
    }
    return {
      logicName: m.logicName,
      kolvipChannelId: m.kolvipChannelId,
      discordChannelId: m.discordChannelId,
      parser: m.parser,
      channelName: resolveCardChannelName(m.discordChannelId, m.logicName),
      sampleStatus,
      metrics,
    };
  });

  return {
    ok: true,
    fromMs,
    toMs,
    days,
    minSample,
    note: "胜率口径与 /eval 一致：已入场计入；任意 TP=赢；先 SL=输",
    overall: aggregateMetrics(cards.filter((c) => mappings.some((m) => m.discordChannelId === c.channelId))),
    channels,
  };
}
