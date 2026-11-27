/**
 * Shared card fields for 8787 / task-os CDP run_end meta.
 * Kept in a tiny module so notify callers can share helpers without a cycle.
 */

/** ISO8601 open time for task-os CDP bubble: signalAt, else createdAt. */
export function isoCardOpenedAt(card) {
  const raw = card?.signalAt || card?.createdAt || "";
  const s = String(raw ?? "").trim();
  if (!s) return "";
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? s : d.toISOString();
}

/** Channel display name for 8787 / run_end meta. */
export function cardChannelName(card) {
  return String(card?.channelName ?? card?.channel ?? "").trim();
}
