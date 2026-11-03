/** @typedef {"week"|"month1"|"month2"|"month3"|"month4"} BackfillPeriod */

const LS_PREFIX = "manual-stats-kv-backfill-v1:";
const LS_SELECTED = "manual-stats-kv-backfill-selected-v1";

/** @returns {string[]} */
export function loadSelectedChannelIdsLocal() {
  try {
    const raw = localStorage.getItem(LS_SELECTED);
    if (!raw) return [];
    const j = JSON.parse(raw);
    return Array.isArray(j) ? j.map(String) : [];
  } catch {
    return [];
  }
}

/** @param {string[]} ids */
export function saveSelectedChannelIdsLocal(ids) {
  try {
    localStorage.setItem(LS_SELECTED, JSON.stringify(ids));
  } catch {
    /* ignore */
  }
}

export const BACKFILL_PERIOD_OPTIONS = [
  { id: "week", label: "近 1 周" },
  { id: "month1", label: "近 1 月" },
  { id: "month2", label: "近 2 月" },
  { id: "month3", label: "近 3 月" },
  { id: "month4", label: "近 4 月" },
];

/** @param {BackfillPeriod} period */
export function backfillCacheKey(period) {
  return `${LS_PREFIX}${period}`;
}

/** @param {BackfillPeriod} period @param {unknown} payload */
export function saveBackfillCacheLocal(period, payload) {
  try {
    localStorage.setItem(backfillCacheKey(period), JSON.stringify({ savedAt: Date.now(), payload }));
  } catch {
    /* quota */
  }
}

/** @param {BackfillPeriod} period */
export function loadBackfillCacheLocal(period) {
  try {
    const raw = localStorage.getItem(backfillCacheKey(period));
    if (!raw) return null;
    const j = JSON.parse(raw);
    return j?.payload ?? null;
  } catch {
    return null;
  }
}

export async function fetchKolvipManualBackfillConfig() {
  const res = await fetch("/api/local/kolvip-backfill/config", { cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/** @param {BackfillPeriod} period @param {string | null} [runId] */
export async function fetchKolvipManualBackfillResults(period, runId = null) {
  const q = new URLSearchParams({ period });
  if (runId) q.set("runId", runId);
  const res = await fetch(`/api/local/kolvip-backfill/results?${q}`, { cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/** @param {BackfillPeriod} period */
export async function fetchKolvipManualBackfillHistory(period) {
  const res = await fetch(
    `/api/local/kolvip-backfill/history?period=${encodeURIComponent(period)}`,
    { cache: "no-store" },
  );
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

export async function fetchKolvipManualBackfillStatus() {
  const res = await fetch("/api/local/kolvip-backfill/status", { cache: "no-store" });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/**
 * @param {BackfillPeriod} period
 * @param {string[]} channelIds
 */
export async function runKolvipManualBackfill(period, channelIds) {
  const res = await fetch("/api/local/kolvip-backfill/run", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      period,
      channelIds,
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

/** @param {Record<string, unknown>} card */
export function backfillCardDigest(card) {
  const d = String(card.digest ?? "").trim();
  if (d) return d;
  const at = String(card.signalAt ?? card.at ?? "").trim();
  const sym = String(card.symbol ?? "").trim();
  return `${at}|${sym}|${String(card.phase ?? "")}`;
}

export async function rebacktestKolvipManualBackfill(period, runId = null, opts = {}) {
  const res = await fetch("/api/local/kolvip-backfill/rebacktest", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      period,
      runId: runId || undefined,
      skipBacktestCache: Boolean(opts.skipCache),
    }),
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}

export async function stopKolvipManualBackfill() {
  const res = await fetch("/api/local/kolvip-backfill/stop", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `HTTP ${res.status}`);
  return body;
}
