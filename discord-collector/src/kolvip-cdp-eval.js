/**
 * 巨鲸映射频道 eval 汇总（口径与 card-eval-api 一致）。
 */
import { archiveCardToClient, resolveCardChannelName } from "./card-archive-service.js";
import { aggregateMetrics, classifyCardEval } from "./card-eval-api.js";
import { getKolvipChannelMappings } from "./kolvip-cdp-config.js";

/**
 * @param {unknown[]} rows
 */
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
 * @param {ReturnType<typeof archiveCardToClient>[]} cards
 */
export function summarizeKolvipChannelEval(cards) {
  const metrics = aggregateMetrics(cards);
  const decided = (metrics.winCount || 0) + (metrics.lossCount || 0);
  let notEnteredCount = 0;
  for (const card of cards) {
    if (!classifyCardEval(card).entered) notEnteredCount += 1;
  }
  /** @type {'win_rate' | 'insufficient_sample' | 'fetching'} */
  let displayState = "fetching";
  if (decided > 0) displayState = "win_rate";
  else if (cards.length > 0) displayState = "insufficient_sample";
  return {
    pushedCount: cards.length,
    notEnteredCount,
    metrics,
    displayState,
    decided,
  };
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {{ fromMs: number, toMs: number }} range
 */
export async function buildKolvipEvalSummary(store, range) {
  const mappings = getKolvipChannelMappings();
  const mappedIds = new Set(mappings.map((m) => m.discordChannelId));
  const rows = await store.listCardsForEval({
    fromMs: range.fromMs,
    toMs: range.toMs,
    limit: 4000,
  });
  const cards = rowsToCards(rows);
  /** @type {Map<string, typeof cards>} */
  const byChannel = new Map();
  for (const card of cards) {
    const cid = String(card.channelId ?? "").trim();
    if (!cid || !mappedIds.has(cid)) continue;
    if (!byChannel.has(cid)) byChannel.set(cid, []);
    byChannel.get(cid)?.push(card);
  }

  const channels = mappings.map((m) => {
    const list = byChannel.get(m.discordChannelId) || [];
    const summary = summarizeKolvipChannelEval(list);
    return {
      logicName: m.logicName,
      kolvipChannelId: m.kolvipChannelId,
      discordChannelId: m.discordChannelId,
      parser: m.parser,
      channelName: resolveCardChannelName(m.discordChannelId, m.logicName),
      ...summary,
    };
  });

  return {
    fromMs: range.fromMs,
    toMs: range.toMs,
    note: "口径与 GET /api/v1/cards/eval/summary 一致；按 Discord channelId 合并 kolvip_cdp 与 Gateway 源",
    channels,
  };
}
