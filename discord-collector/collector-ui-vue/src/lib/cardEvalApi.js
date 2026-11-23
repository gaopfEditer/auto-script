import { readJsonResponse } from "./httpJson.js";

/** @typedef {{
 *   bloggerName?: string,
 *   winRate: number|null,
 *   totalR: number|null,
 *   avgR?: number|null,
 *   pl?: number|null,
 *   count?: number,
 *   wins?: number,
 *   losses?: number,
 * }} KolvipSigMetrics */

/** @typedef {{
 *   cardCount: number,
 *   winCount: number,
 *   lossCount: number,
 *   pendingCount: number,
 *   winRate: number|null,
 *   totalPnlPct: number|null,
 *   avgPnlPct: number|null,
 *   tp1Hits: number,
 *   tp2Hits: number,
 *   tp3Hits: number,
 *   sig?: KolvipSigMetrics,
 *   pnlDisplaySource?: string,
 *   pnlDisplayUnit?: "R" | "pct_margin",
 *   pathPnlReliable?: boolean,
 *   pathTotalPnlPctRaw?: number|null,
 *   noteLocalPath?: string|null,
 *   sigAggregateR?: number|null,
 *   sigBloggerCount?: number,
 *   sigWinCount?: number,
 *   sigLossCount?: number,
 *   localPath?: EvalMetrics & { pathPnlReliable?: boolean },
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

/** @param {EvalChannelRow[]} rows */
export function aggregateEvalChannelRows(rows) {
  const m = emptyEvalMetrics();
  for (const r of rows) {
    m.cardCount += Number(r.cardCount) || 0;
    m.winCount += Number(r.winCount) || 0;
    m.lossCount += Number(r.lossCount) || 0;
    m.pendingCount += Number(r.pendingCount) || 0;
    m.totalPnlPct += Number(r.totalPnlPct) || 0;
    m.tp1Hits += Number(r.tp1Hits) || 0;
    m.tp2Hits += Number(r.tp2Hits) || 0;
    m.tp3Hits += Number(r.tp3Hits) || 0;
  }
  const decided = m.winCount + m.lossCount;
  m.winRate = decided > 0 ? (m.winCount / decided) * 100 : null;
  m.avgPnlPct = m.cardCount > 0 ? m.totalPnlPct / m.cardCount : null;
  return m;
}

/**
 * @param {Response} res
 * @param {string} fallback
 */
async function readJson(res, fallback) {
  return readJsonResponse(res, fallback);
}

/**
 * @param {{ range?: string, from?: string, to?: string, days?: number, source?: string, channelId?: string, symbol?: string }} [opts]
 */
export async function fetchEvalSummary(opts = {}) {
  const q = new URLSearchParams();
  if (opts.source) q.set("source", opts.source);
  if (opts.channelId) q.set("channelId", opts.channelId);
  if (opts.symbol) q.set("symbol", opts.symbol);
  if (opts.days) q.set("days", String(opts.days));
  if (opts.from) q.set("from", opts.from);
  if (opts.to) q.set("to", opts.to);
  if (opts.range) q.set("range", opts.range);
  const res = await fetch(`/api/cards/eval/summary?${q}`);
  const j = await readJson(res, "加载评估汇总失败");
  if (!j || typeof j !== "object" || !j.ok) {
    throw new Error((j && j.error) || "加载评估汇总失败");
  }
  const kolvipEval =
    j.kolvipEval && typeof j.kolvipEval === "object"
      ? {
          label: typeof j.kolvipEval.label === "string" ? j.kolvipEval.label : "巨鲸信号频道",
          topN: Number(j.kolvipEval.topN) || 20,
          rankedChannelIds: Array.isArray(j.kolvipEval.rankedChannelIds)
            ? j.kolvipEval.rankedChannelIds.map(String)
            : [],
          dailyTopOverview: Array.isArray(j.kolvipEval.dailyTopOverview)
            ? j.kolvipEval.dailyTopOverview
            : [],
          sigRange: typeof j.kolvipEval.sigRange === "string" ? j.kolvipEval.sigRange : null,
          sigAvailable: Boolean(j.kolvipEval.sigAvailable),
          sigRankRows: Array.isArray(j.kolvipEval.sigRankRows) ? j.kolvipEval.sigRankRows : [],
          kolvipWeb:
            j.kolvipEval.kolvipWeb && typeof j.kolvipEval.kolvipWeb === "object" ? j.kolvipEval.kolvipWeb : null,
        }
      : {
          label: "巨鲸信号频道",
          topN: 20,
          rankedChannelIds: [],
          dailyTopOverview: [],
          sigRange: null,
          sigAvailable: false,
          sigRankRows: [],
          kolvipWeb: null,
        };
  return {
    fromMs: Number(j.fromMs) || 0,
    toMs: Number(j.toMs) || 0,
    note: typeof j.note === "string" ? j.note : "",
    overall: j.overall && typeof j.overall === "object" ? j.overall : emptyEvalMetrics(),
    channels: Array.isArray(j.channels) ? j.channels : [],
    kolvipEval,
  };
}

/**
 * @param {string} channelId
 * @param {{ range?: string, from?: string, to?: string }} [opts]
 */
export async function fetchEvalChannel(channelId, opts = {}) {
  const id = channelId ? encodeURIComponent(channelId) : "none";
  const q = new URLSearchParams();
  if (opts.source) q.set("source", opts.source);
  if (opts.symbol) q.set("symbol", opts.symbol);
  if (opts.days) q.set("days", String(opts.days));
  if (opts.range && !opts.from && !opts.days) q.set("range", String(opts.range));
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
    kolvipSig: j.kolvipSig && typeof j.kolvipSig === "object" ? j.kolvipSig : null,
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
