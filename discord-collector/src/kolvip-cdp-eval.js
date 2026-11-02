/**
 * 巨鲸 eval 汇总：精选（跟单映射）+ 全站备选（扫描频道，按胜率排序）。
 */
import { archiveCardToClient, resolveCardChannelName } from "./card-archive-service.js";
import { aggregateMetrics, classifyCardEval } from "./card-eval-api.js";
import {
  getKolvipChannelMappings,
  getKolvipMappedDiscordChannelIds,
} from "./kolvip-cdp-config.js";
import { parseKolvipScanVirtualChannelId, kolvipScanVirtualChannelId } from "./kolvip-scan-config.js";
import { loadKolvipCatalogCache } from "./kolvip-api-catalog.js";

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
  const mappedDiscordIds = getKolvipMappedDiscordChannelIds();
  const catalog = await loadKolvipCatalogCache();
  const nameByKolvipId = new Map(
    (catalog.channels || []).map((c) => [String(c.kolvipChannelId), String(c.name)])
  );

  const rows = await store.listCardsForEval({
    fromMs: range.fromMs,
    toMs: range.toMs,
    limit: 8000,
  });
  const cards = rowsToCards(rows);

  /** @type {Map<string, typeof cards>} */
  const byDiscordChannel = new Map();
  /** @type {Map<string, typeof cards>} */
  const byKolvipScanId = new Map();

  for (const card of cards) {
    const cid = String(card.channelId ?? "").trim();
    if (!cid) continue;
    if (mappedDiscordIds.has(cid)) {
      if (!byDiscordChannel.has(cid)) byDiscordChannel.set(cid, []);
      byDiscordChannel.get(cid)?.push(card);
      continue;
    }
    const scanKid = parseKolvipScanVirtualChannelId(cid);
    if (scanKid) {
      if (!byKolvipScanId.has(scanKid)) byKolvipScanId.set(scanKid, []);
      byKolvipScanId.get(scanKid)?.push(card);
    }
  }

  const curated = mappings.map((m) => {
    const list = byDiscordChannel.get(m.discordChannelId) || [];
    const summary = summarizeKolvipChannelEval(list);
    return {
      section: "curated",
      logicName: m.logicName,
      kolvipChannelId: m.kolvipChannelId,
      discordChannelId: m.discordChannelId,
      parser: m.parser,
      channelName: resolveCardChannelName(m.discordChannelId, m.logicName),
      ...summary,
    };
  });

  /** @type {Array<Record<string, unknown>>} */
  const candidates = [];
  for (const [kid, list] of byKolvipScanId.entries()) {
    const summary = summarizeKolvipChannelEval(list);
    candidates.push({
      section: "candidate",
      logicName: nameByKolvipId.get(kid) || `kolvip-${kid}`,
      kolvipChannelId: kid,
      discordChannelId: kolvipScanVirtualChannelId(kid),
      channelName: nameByKolvipId.get(kid) || `kolvip-${kid}`,
      ...summary,
    });
  }

  candidates.sort((a, b) => {
    const ar = a.metrics && typeof a.metrics === "object" ? Number(a.metrics.winRate) : -1;
    const br = b.metrics && typeof b.metrics === "object" ? Number(b.metrics.winRate) : -1;
    const aDec = Number(a.decided) || 0;
    const bDec = Number(b.decided) || 0;
    if (Number.isFinite(ar) && Number.isFinite(br) && ar !== br) return br - ar;
    return bDec - aDec;
  });

  return {
    fromMs: range.fromMs,
    toMs: range.toMs,
    note:
      "口径与 GET /api/v1/cards/eval/summary 一致；精选=Discord 映射跟单频道，备选=kolvip-scan-* 虚拟频道（回溯建卡+清算，不推 TG）",
    curated,
    candidates,
    channels: curated,
    catalogUpdatedAt: catalog.updatedAt || null,
  };
}
