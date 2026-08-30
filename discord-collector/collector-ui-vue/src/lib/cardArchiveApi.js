/** @typedef {{
 *   id: number,
 *   uid: string,
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

import { readOkJson } from "./httpJson.js";
import { buildArchivePeriodQuery, normalizeArchiveSourceList } from "./cardArchiveFilters.js";

export { buildArchivePeriodQuery } from "./cardArchiveFilters.js";

/** @param {{ source?: string, sources?: string[], onlySources?: string[], symbol?: string, status?: string, channelId?: string, days?: number, from?: string, to?: string, limit?: number, sinceId?: number, refresh?: boolean }} [opts] */
export async function fetchArchiveCards(opts = {}) {
  const q = new URLSearchParams();
  const sources = opts.onlySources?.length
    ? [...new Set(opts.onlySources.map((s) => String(s ?? "").trim().toLowerCase()).filter(Boolean))]
    : opts.sources?.length
      ? normalizeArchiveSourceList(opts.sources)
      : opts.source
        ? normalizeArchiveSourceList([opts.source])
        : [];
  if (sources.length) q.set("sources", sources.join(","));
  if (opts.symbol) q.set("symbol", opts.symbol);
  if (opts.status) q.set("status", opts.status);
  if (opts.channelId) q.set("channelId", opts.channelId);
  if (opts.days) q.set("days", String(opts.days));
  if (opts.from) q.set("from", opts.from);
  if (opts.to) q.set("to", opts.to);
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.sinceId && opts.sinceId > 0) q.set("sinceId", String(opts.sinceId));
  if (opts.refresh) q.set("refresh", "1");
  const res = await fetch(`/api/cards?${q}`);
  const j = await readOkJson(res, "加载卡片失败");
  return {
    cards: j.cards ?? [],
    fromMs: j.fromMs,
    toMs: j.toMs,
    total: j.total ?? j.cards?.length ?? 0,
    maxId: Number(j.maxId) || 0,
    cached: Boolean(j.cached),
    incremental: Boolean(j.incremental),
  };
}

/** @param {import("./cardArchiveApi.js").ArchiveCard} card */
export function canDeleteArchiveCard(card) {
  const st = String(card?.sourceType ?? "").trim().toLowerCase();
  if (!st || st === "discord") return false;
  const platform = st.includes(":") ? st.split(":").pop() : st;
  return platform !== "discord";
}

/** @param {number} id */
export async function deleteArchiveCard(id) {
  const res = await fetch(`/api/cards/${id}`, { method: "DELETE" });
  const j = await readOkJson(res, "删除卡片失败");
  return j;
}

/** @param {number[]} cardIds */
export async function deleteArchiveCards(cardIds) {
  const res = await fetch("/api/cards/batch-delete", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardIds }),
  });
  const j = await readOkJson(res, "批量删除卡片失败");
  return j;
}

/** @param {number} id */
export async function fetchArchiveCard(id) {
  const res = await fetch(`/api/cards/${id}`);
  const j = await readOkJson(res, "加载卡片失败");
  return /** @type {ArchiveCard} */ (j.card);
}

/** @param {Record<string, unknown>} body */
export async function archiveYoutubeCard(body) {
  const res = await fetch("/api/cards/from-youtube", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await readOkJson(res, "YouTube 卡片归档失败");
  return /** @type {ArchiveCard} */ (j.card);
}

export async function fetchCardSources() {
  const res = await fetch("/api/cards/sources");
  const j = await readOkJson(res, "加载来源失败");
  return /** @type {string[]} */ (j.sources ?? []);
}

/** @param {{ source?: string, sources?: string[], symbol?: string, status?: string, days?: number, from?: string, to?: string, refresh?: boolean }} [opts] */
export async function fetchCardChannels(opts = {}) {
  const q = new URLSearchParams();
  const sources = opts.sources?.length
    ? normalizeArchiveSourceList(opts.sources)
    : opts.source
      ? normalizeArchiveSourceList([opts.source])
      : [];
  if (sources.length) q.set("sources", sources.join(","));
  if (opts.symbol) q.set("symbol", opts.symbol);
  if (opts.status) q.set("status", opts.status);
  if (opts.days) q.set("days", String(opts.days));
  if (opts.from) q.set("from", opts.from);
  if (opts.to) q.set("to", opts.to);
  if (opts.refresh) q.set("refresh", "1");
  const res = await fetch(`/api/cards/channels?${q}`);
  const j = await readOkJson(res, "加载频道失败");
  return /** @type {ArchiveChannelOption[]} */ (j.channels ?? []);
}

/** @param {{ source?: string, symbol?: string, channelId?: string, days?: number, from?: string, to?: string, limit?: number, cardIds?: number[] }} [opts] */
export async function liquidateArchiveCards(opts = {}) {
  const res = await fetch("/api/cards/liquidate", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(opts),
  });
  const j = await readOkJson(res, "卡片清算失败");
  return j;
}

/** @param {number[]} cardIds */
export async function clearArchiveCardLiquidation(cardIds) {
  const res = await fetch("/api/cards/clear-liquidation", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardIds }),
  });
  const j = await readOkJson(res, "清空结算失败");
  return j;
}

/**
 * Local 手动统计建卡
 * @param {{
 *   bloggerName: string,
 *   symbol: string,
 *   direction: string,
 *   date?: string,
 *   signalAt?: string,
 *   entry?: string,
 *   stopLoss?: string,
 *   targets?: string[],
 *   note?: string,
 *   liquidate?: boolean,
 * }} body
 */
export async function createManualStatsCard(body) {
  const res = await fetch("/api/cards/manual", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await readOkJson(res, "创建手动统计失败");
  return {
    card: /** @type {ArchiveCard} */ (j.card),
    liquidation: j.liquidation ?? null,
  };
}

/**
 * @param {number} id
 * @param {Record<string, unknown>} body
 */
export async function updateManualStatsCard(id, body) {
  const res = await fetch(`/api/cards/manual/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await readOkJson(res, "更新手动统计失败");
  return {
    card: /** @type {ArchiveCard} */ (j.card),
    liquidation: j.liquidation ?? null,
  };
}
