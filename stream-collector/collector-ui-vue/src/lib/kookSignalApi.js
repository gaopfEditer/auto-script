/**
 * 发车信号标记 + 结果核验 API 客户端。
 */
import { entryTypeLabel } from "./kookSignalConstants.js";

/**
 * @typedef {{
 *   messageId: string;
 *   guildId: string;
 *   channelId: string;
 *   markNote?: string | null;
 *   hitTakeProfit?: boolean | null;
 *   hitStopLoss?: boolean | null;
 *   entryType?: 'precise' | 'near_miss' | 'near_stop_loss' | 'bad_entry_no_sl' | 'none' | null;
 *   entryOffset?: number | null;
 *   reviewNote?: string | null;
 * }} SignalReviewForm
 */

/** @param {unknown} row */
export function normalizeSignalRow(row) {
  const o = /** @type {Record<string, unknown>} */ (row ?? {});
  return {
    messageId: String(o.message_id ?? o.messageId ?? ""),
    guildId: String(o.guild_id ?? o.guildId ?? ""),
    channelId: String(o.channel_id ?? o.channelId ?? ""),
    markNote: o.mark_note != null ? String(o.mark_note) : o.markNote != null ? String(o.markNote) : "",
    markedAt: o.marked_at ?? o.markedAt ?? null,
    hitTakeProfit: triFromDb(o.hit_take_profit ?? o.hitTakeProfit),
    hitStopLoss: triFromDb(o.hit_stop_loss ?? o.hitStopLoss),
    entryType: parseEntryType(o.entry_type ?? o.entryType),
    entryOffset: o.entry_offset != null ? Number(o.entry_offset) : o.entryOffset != null ? Number(o.entryOffset) : null,
    reviewNote: o.review_note != null ? String(o.review_note) : o.reviewNote != null ? String(o.reviewNote) : "",
    content: o.content != null ? String(o.content) : "",
    createAtMs: Number(o.create_at_ms ?? o.createAtMs) || 0,
  };
}

/** @param {unknown} v @returns {boolean | null} */
function triFromDb(v) {
  if (v === null || v === undefined || v === "") return null;
  if (v === 1 || v === true || v === "1") return true;
  if (v === 0 || v === false || v === "0") return false;
  return null;
}

const ENTRY_TYPES = new Set([
  "precise",
  "near_miss",
  "near_stop_loss",
  "bad_entry_no_sl",
  "none",
]);

/** @param {unknown} v */
function parseEntryType(v) {
  const s = String(v ?? "").trim();
  return ENTRY_TYPES.has(s) ? /** @type {import('./kookSignalConstants.js').KOOK_ENTRY_TYPE_OPTIONS[number]['value']} */ (s) : null;
}

/** @param {{ guildId: string, channelId?: string, fromMs?: number, toMs?: number }} q */
export async function fetchSignals(q) {
  const p = new URLSearchParams({ guildId: q.guildId });
  if (q.channelId) p.set("channelId", q.channelId);
  if (q.fromMs != null) p.set("fromMs", String(q.fromMs));
  if (q.toMs != null) p.set("toMs", String(q.toMs));
  const r = await fetch(`/api/kook/signals?${p}`);
  const j = /** @type {{ ok?: boolean, rows?: unknown[], error?: string }} */ (await r.json().catch(() => ({})));
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return (j.rows ?? []).map(normalizeSignalRow);
}

/** @param {string[]} messageIds */
export async function fetchSignalsByMessageIds(messageIds) {
  const ids = messageIds.filter(Boolean);
  if (!ids.length) return [];
  const p = new URLSearchParams({ messageIds: ids.join(",") });
  const r = await fetch(`/api/kook/signals?${p}`);
  const j = /** @type {{ ok?: boolean, rows?: unknown[], error?: string }} */ (await r.json().catch(() => ({})));
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return (j.rows ?? []).map(normalizeSignalRow);
}

/** @param {{ messageId: string, guildId: string, channelId: string, note?: string }} body */
export async function markSignal(body) {
  const r = await fetch("/api/kook/signals/mark", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const j = /** @type {{ ok?: boolean, error?: string }} */ (await r.json().catch(() => ({})));
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
}

/** @param {string} messageId */
export async function unmarkSignal(messageId) {
  const r = await fetch(`/api/kook/signals/mark/${encodeURIComponent(messageId)}`, { method: "DELETE" });
  const j = /** @type {{ ok?: boolean, error?: string }} */ (await r.json().catch(() => ({})));
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
}

/** @param {SignalReviewForm} form */
export async function saveSignalReview(form) {
  const r = await fetch("/api/kook/signals/review", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      messageId: form.messageId,
      guildId: form.guildId,
      channelId: form.channelId,
      hitTakeProfit: form.hitTakeProfit,
      hitStopLoss: form.hitStopLoss,
      entryType: form.entryType,
      entryOffset: form.entryType === "near_miss" ? form.entryOffset : null,
      reviewNote: form.reviewNote ?? "",
    }),
  });
  const j = /** @type {{ ok?: boolean, review?: unknown, error?: string }} */ (await r.json().catch(() => ({})));
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return normalizeSignalRow(j.review ?? form);
}

/** @param {{ guildId?: string, fromMs?: number, toMs?: number }} q */
export async function fetchSignalSummariesByGuild(q = {}) {
  const p = new URLSearchParams();
  if (q.guildId) p.set("guildId", q.guildId);
  if (q.fromMs != null) p.set("fromMs", String(q.fromMs));
  if (q.toMs != null) p.set("toMs", String(q.toMs));
  const qs = p.toString();
  const r = await fetch(`/api/kook/signals/summary${qs ? `?${qs}` : ""}`);
  const j = /** @type {{ ok?: boolean, summaries?: Record<string, unknown>[], error?: string }} */ (
    await r.json().catch(() => ({}))
  );
  if (!r.ok || !j.ok) throw new Error(j.error || `HTTP ${r.status}`);
  return j.summaries ?? [];
}

/** @param {ReturnType<typeof normalizeSignalRow> | null | undefined} sig */
export function reviewStatusLabel(sig) {
  if (!sig) return "";
  const parts = [];
  if (sig.hitTakeProfit === true) parts.push("止盈");
  if (sig.hitStopLoss === true) parts.push("止损");
  const entryLbl = entryTypeLabel(sig.entryType);
  if (entryLbl) {
    if (sig.entryType === "near_miss" && sig.entryOffset != null && !Number.isNaN(sig.entryOffset)) {
      parts.push(`${entryLbl} Δ${sig.entryOffset}`);
    } else {
      parts.push(entryLbl);
    }
  }
  return parts.join(" · ");
}
