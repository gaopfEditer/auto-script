/** @typedef {{
 *   id: number,
 *   messageId: string,
 *   channelId: string,
 *   guildId: string,
 *   rawContent: string,
 *   parsedJson: Record<string, unknown>,
 *   cardsByStyle: Record<string, string>,
 *   status: string,
 *   expiresAt: string | null,
 *   telegramSentAt: string | null,
 *   note: string,
 *   execution: import("./signalExecution.js").SignalExecution,
 *   source: string,
 *   isManual: boolean,
 *   signalAt: string | null,
 *   createdAt: string,
 *   updatedAt: string,
 * }} SignalCard */

import { configureEvalLeverage } from "./signalExecution.js";

/** @param {Record<string, unknown> | null | undefined} card */
export function formatCardTime(card) {
  const raw = card?.signalAt ?? card?.createdAt;
  if (!raw) return "";
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? String(raw) : d.toLocaleString("zh-CN");
}

let cachedConfig = /** @type {{ channelIds: string[], styles: Record<string, { label: string }>, channels: Record<string, unknown>, evalLeverage?: { major: number, altcoin: number }, cardNotifications?: { desktop: boolean, position: string } } | null} */ (
  null
);

export async function fetchSignalConfig() {
  if (cachedConfig) return cachedConfig;
  const r = await fetch("/api/discord/signal-config");
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "signal-config failed");
  if (j.evalLeverage) configureEvalLeverage(j.evalLeverage);
  cachedConfig = {
    channelIds: Array.isArray(j.channelIds) ? j.channelIds.map(String) : [],
    styles: j.styles ?? {},
    channels: j.channels ?? {},
    evalLeverage: j.evalLeverage ?? undefined,
    cardNotifications: j.cardNotifications ?? undefined,
  };
  return cachedConfig;
}

/** @param {string} channelId */
export function isSignalChannelId(channelId, config) {
  return config.channelIds.includes(String(channelId ?? ""));
}

/** @param {string} channelId @param {{ status?: string, limit?: number, days?: number, from?: string, to?: string }} [opts] */
export async function fetchSignalCards(channelId, opts = {}) {
  const q = new URLSearchParams({ channel_id: channelId, limit: String(opts.limit ?? 50) });
  if (opts.status) q.set("status", opts.status);
  if (opts.days) q.set("days", String(opts.days));
  if (opts.from) q.set("from", opts.from);
  if (opts.to) q.set("to", opts.to);
  const r = await fetch(`/api/discord/signal-cards?${q}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "fetch cards failed");
  return /** @type {SignalCard[]} */ (j.cards ?? []);
}

/** @param {{ days?: number, from?: string, to?: string }} [opts] */
export async function fetchSignalOverview(opts = {}) {
  const q = new URLSearchParams();
  if (opts.days) q.set("days", String(opts.days));
  if (opts.from) q.set("from", opts.from);
  if (opts.to) q.set("to", opts.to);
  const r = await fetch(`/api/discord/signal-overview?${q}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "fetch overview failed");
  return j;
}

/** @param {string} channelId @param {{ days?: number, from?: string, to?: string, limit?: number }} [opts] */
export async function fetchSignalHistory(channelId, opts = {}) {
  const q = new URLSearchParams({ channel_id: channelId, limit: String(opts.limit ?? 200) });
  if (opts.days) q.set("days", String(opts.days));
  if (opts.from) q.set("from", opts.from);
  if (opts.to) q.set("to", opts.to);
  const r = await fetch(`/api/discord/signal-history?${q}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "fetch history failed");
  return j;
}

/**
 * @param {number} id
 * @param {{ status?: string, expiresAt?: string | null, cardsByStyle?: Record<string, string>, note?: string | null, execution?: import("./signalExecution.js").SignalExecution }} patch
 */
export async function updateSignalCard(id, patch) {
  const body = { ...patch };
  if (patch.execution) body.execution = patch.execution;
  const r = await fetch(`/api/discord/signal-cards/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "update card failed");
  return /** @type {SignalCard} */ (j.card);
}

/**
 * @param {{
 *   channelId: string,
 *   guildId?: string,
 *   symbol: string,
 *   direction?: string,
 *   entryPrice?: string,
 *   takeProfitPrices?: string[] | string,
 *   stopLossPrice?: string,
 *   outcome?: string,
 *   note?: string,
 * }} payload
 */
export async function createSignalCard(payload) {
  const r = await fetch("/api/discord/signal-cards", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "create card failed");
  return /** @type {SignalCard} */ (j.card);
}

/** @param {number} id @param {string} [styleId] */
export async function resendSignalTelegram(id, styleId) {
  const r = await fetch(`/api/discord/signal-cards/${id}/telegram`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(styleId ? { styleId } : {}),
  });
  const j = await r.json();
  if (!j.ok && !j.skipped) throw new Error(j.error || "telegram failed");
  return j;
}
