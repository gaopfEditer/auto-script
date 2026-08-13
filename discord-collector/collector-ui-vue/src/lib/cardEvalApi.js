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

/**
 * @param {{ range?: string, from?: string, to?: string }} [opts]
 */
export async function fetchEvalSummary(opts = {}) {
  const q = new URLSearchParams();
  q.set("range", opts.range || "1d");
  if (opts.from) q.set("from", opts.from);
  if (opts.to) q.set("to", opts.to);
  const res = await fetch(`/api/cards/eval/summary?${q}`);
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "加载评估汇总失败");
  return /** @type {{
    range: string,
    fromMs: number,
    toMs: number,
    note?: string,
    overall: EvalMetrics,
    channels: EvalChannelRow[],
  }} */ (j);
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
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "加载频道评估失败");
  return j;
}
