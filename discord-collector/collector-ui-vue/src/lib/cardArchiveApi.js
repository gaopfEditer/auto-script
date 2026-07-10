/** @typedef {{
 *   id: number,
 *   messageId: string,
 *   channelId: string,
 *   channelName: string,
 *   guildId: string,
 *   rawContent: string,
 *   parsedJson: Record<string, unknown> | null,
 *   cardsByStyle: Record<string, string>,
 *   status: string,
 *   source: string,
 *   sourceType: string,
 *   sourceRef: string | null,
 *   symbol: string,
 *   assetClass: string,
 *   verifyMode: string,
 *   cardFields: {
 *     title?: string,
 *     description?: string,
 *     color?: number,
 *     fields?: Array<{ name: string, value: string, inline?: boolean }>,
 *     footer?: { text?: string },
 *     timestamp?: string,
 *   } | null,
 *   signalAt: string | null,
 *   verify3h: Record<string, unknown> | null,
 *   verify1m: Record<string, unknown> | null,
 *   proximity: Record<string, unknown> | null,
 *   backtest: Record<string, unknown> | null,
 *   note: string,
 *   execution: import("./signalExecution.js").SignalExecution,
 *   createdAt: string,
 *   updatedAt: string,
 * }} ArchiveCard */

/** @typedef {{ channelId: string, channelName: string, count: number }} ArchiveChannelOption */

/** @param {string | number} period */
export function buildArchivePeriodQuery(period) {
  if (period === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return { from: start.toISOString() };
  }
  const d = Number(period);
  if (Number.isFinite(d) && d > 0) return { days: d };
  return { days: 3650 };
}

/** @param {{ source?: string, symbol?: string, status?: string, channelId?: string, days?: number, from?: string, to?: string, limit?: number }} [opts] */
export async function fetchArchiveCards(opts = {}) {
  const q = new URLSearchParams();
  if (opts.source) q.set("source", opts.source);
  if (opts.symbol) q.set("symbol", opts.symbol);
  if (opts.status) q.set("status", opts.status);
  if (opts.channelId) q.set("channelId", opts.channelId);
  if (opts.days) q.set("days", String(opts.days));
  if (opts.from) q.set("from", opts.from);
  if (opts.to) q.set("to", opts.to);
  if (opts.limit) q.set("limit", String(opts.limit));
  const res = await fetch(`/api/cards?${q}`);
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "加载卡片失败");
  return /** @type {{ cards: ArchiveCard[], fromMs: number, toMs: number, total: number }} */ ({
    cards: j.cards ?? [],
    fromMs: j.fromMs,
    toMs: j.toMs,
    total: j.total ?? j.cards?.length ?? 0,
  });
}

/** @param {number} id */
export async function fetchArchiveCard(id) {
  const res = await fetch(`/api/cards/${id}`);
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "加载卡片失败");
  return /** @type {ArchiveCard} */ (j.card);
}

/** @param {Record<string, unknown>} body */
export async function archiveYoutubeCard(body) {
  const res = await fetch("/api/cards/from-youtube", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "YouTube 卡片归档失败");
  return /** @type {ArchiveCard} */ (j.card);
}

export async function fetchCardSources() {
  const res = await fetch("/api/cards/sources");
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "加载来源失败");
  return /** @type {string[]} */ (j.sources ?? []);
}

/** @param {{ source?: string, symbol?: string, status?: string, days?: number, from?: string, to?: string }} [opts] */
export async function fetchCardChannels(opts = {}) {
  const q = new URLSearchParams();
  if (opts.source) q.set("source", opts.source);
  if (opts.symbol) q.set("symbol", opts.symbol);
  if (opts.status) q.set("status", opts.status);
  if (opts.days) q.set("days", String(opts.days));
  if (opts.from) q.set("from", opts.from);
  if (opts.to) q.set("to", opts.to);
  const res = await fetch(`/api/cards/channels?${q}`);
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "加载频道失败");
  return /** @type {ArchiveChannelOption[]} */ (j.channels ?? []);
}

/** @param {number} id */
export async function runArchiveCardBacktest(id) {
  const res = await fetch(`/api/cards/${id}/backtest`, { method: "POST" });
  const j = await res.json();
  if (!j.ok) throw new Error(j.error || "回测失败");
  return /** @type {{ card: ArchiveCard, backtest: Record<string, unknown> }} */ ({
    card: j.card,
    backtest: j.backtest,
  });
}
