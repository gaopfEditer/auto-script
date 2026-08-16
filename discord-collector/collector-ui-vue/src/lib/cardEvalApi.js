import { readJsonResponse } from "./httpJson.js";

/** @typedef {{
 *   cardCount: number,
 *   winCount: number,
 *   lossCount: number,
 *   pendingCount: number,
 *   winRate: number|null,
 *   totalPnlPct: number,
 *   avgPnlPct: number|null,
 *   tp1Hits: number,
 *   tp2Hits: number,
 *   tp3Hits: number,
 * }} EvalMetrics */

/** @typedef {EvalMetrics & { channelId: string, channelName: string }} EvalChannelRow */

/** @returns {EvalMetrics} */
export function emptyEvalMetrics() {
  return {
    cardCount: 0,
    winCount: 0,
    lossCount: 0,
    pendingCount: 0,
    winRate: null,
    totalPnlPct: 0,
    avgPnlPct: null,
    tp1Hits: 0,
    tp2Hits: 0,
    tp3Hits: 0,
  };
}

/**
 * @param {Response} res
 * @param {string} fallback
 */
async function readJson(res, fallback) {
  return readJsonResponse(res, fallback);
}

/**
 * @param {{ range?: string, from?: string, to?: string }} [opts]
 */
export async function fetchEvalSummary(opts = {}) {
  const q = new URLSearchParams();
  q.set("range", opts.range || "1d");
  if (opts.from) q.set("from", opts.from);
  if (opts.to) q.set("to", opts.to);
  const res = await fetch(`/api/cards/eval/summary?${q}`);
  const j = await readJson(res, "加载评估汇总失败");
  if (!j || typeof j !== "object" || !j.ok) {
    throw new Error((j && j.error) || "加载评估汇总失败");
  }
  return {
    range: String(j.range ?? opts.range ?? "1d"),
    fromMs: Number(j.fromMs) || 0,
    toMs: Number(j.toMs) || 0,
    note: typeof j.note === "string" ? j.note : "",
    overall: j.overall && typeof j.overall === "object" ? j.overall : emptyEvalMetrics(),
    channels: Array.isArray(j.channels) ? j.channels : [],
  };
}

/**
 * @param {string} channelId
 * @param {{ range?: string, from?: string, to?: string }} [opts]
 */
export async function fetchEvalChannel(channelId, opts = {}) {
  const id = channelId ? encodeURIComponent(channelId) : "none";
  const q = new URLSearchParams();
  q.set("range", opts.range || "1d");
  if (opts.from) q.set("from", opts.from);
  if (opts.to) q.set("to", opts.to);
  const res = await fetch(`/api/cards/eval/channels/${id}?${q}`);
  const j = await readJson(res, "加载频道评估失败");
  if (!j || typeof j !== "object" || !j.ok) {
    throw new Error((j && j.error) || "加载频道评估失败");
  }
  return {
    ...j,
    metrics: j.metrics && typeof j.metrics === "object" ? j.metrics : emptyEvalMetrics(),
    cards: Array.isArray(j.cards) ? j.cards : [],
  };
}

/** @typedef {{
 *   channelId: string,
 *   channelName?: string,
 *   hasTpStrategy: boolean,
 *   today: { tpCount: number, slCount: number, pendingCount: number, enteredCount: number },
 *   lastWeek: { winRate: number|null, winCount: number, lossCount: number, decided: number } | null,
 * }} ChannelStripRow */

/** Show 频道列表：当日止盈/止损 + 上周胜率 */
export async function fetchChannelStripStats() {
  const res = await fetch("/api/cards/eval/channel-strip");
  const j = await readJson(res, "加载频道条统计失败");
  if (!j || typeof j !== "object" || !j.ok) {
    throw new Error((j && j.error) || "加载频道条统计失败");
  }
  /** @type {Record<string, ChannelStripRow>} */
  const byId = {};
  for (const ch of Array.isArray(j.channels) ? j.channels : []) {
    const id = String(ch?.channelId ?? "").trim();
    if (!id) continue;
    byId[id] = {
      channelId: id,
      channelName: typeof ch.channelName === "string" ? ch.channelName : "",
      hasTpStrategy: Boolean(ch.hasTpStrategy),
      today: {
        tpCount: Number(ch.today?.tpCount) || 0,
        slCount: Number(ch.today?.slCount) || 0,
        pendingCount: Number(ch.today?.pendingCount) || 0,
        enteredCount: Number(ch.today?.enteredCount) || 0,
      },
      lastWeek: ch.lastWeek
        ? {
            winRate: ch.lastWeek.winRate == null ? null : Number(ch.lastWeek.winRate),
            winCount: Number(ch.lastWeek.winCount) || 0,
            lossCount: Number(ch.lastWeek.lossCount) || 0,
            decided: Number(ch.lastWeek.decided) || 0,
          }
        : null,
    };
  }
  return { byId, today: j.today, lastWeek: j.lastWeek };
}
