export async function fetchTodayAutotradePnl() {
  const res = await fetch("/api/local/today-autotrade-pnl", { cache: "no-store" });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j?.ok === false) {
    throw new Error(j?.error || `HTTP ${res.status}`);
  }
  return j;
}

/**
 * @param {{
 *   dayLabel?: string,
 *   sumPnlUsdt?: number,
 *   rows: Record<string, unknown>[],
 *   platforms?: string[],
 * }} payload
 */
/** @param {number} cardId */
export async function markTodayPnlOpenCard(cardId) {
  const res = await fetch("/api/local/today-autotrade-pnl/mark-open", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ cardId }),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok && j?.ok !== false && !j?.skipped) {
    throw new Error(j?.error || `HTTP ${res.status}`);
  }
  return j;
}

export async function publishTodayPnlSelection(payload) {
  const res = await fetch("/api/local/today-autotrade-pnl/publish", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j?.ok === false) {
    throw new Error(j?.error || `HTTP ${res.status}`);
  }
  return j;
}