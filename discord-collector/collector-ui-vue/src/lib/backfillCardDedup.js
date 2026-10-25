/** 与 src/backfill-card-dedup.js 同逻辑（前端展示/本地缓存） */
import { isPollutedBackfillCard } from "./backfillCardQuality.js";

const DEFAULT_WINDOW_MS = 20 * 60 * 1000;

/** @param {Array<Record<string, unknown>>} cards */
function filterQuality(cards) {
  return (cards ?? []).filter((c) => c && !isPollutedBackfillCard(c));
}

/** @param {Record<string, unknown>} card */
export function backfillDedupKey(card) {
  const sym = String(card.symbol ?? "").trim().toUpperCase();
  const dir = String(card.directionNorm ?? card.direction ?? "")
    .trim()
    .toLowerCase();
  const phase = String(card.phase ?? "full").trim().toLowerCase();
  return `${sym}|${dir}|${phase}`;
}

/**
 * @param {Array<Record<string, unknown>>} cards
 * @param {number} [windowMs]
 */
export function dedupeBackfillCards(cards, windowMs = DEFAULT_WINDOW_MS) {
  const cleaned = filterQuality(cards ?? []);
  if (cleaned.length < 2) return cleaned;

  const sorted = [...cleaned].sort((a, b) => {
    const ta = Date.parse(String(a.signalAt ?? a.at ?? ""));
    const tb = Date.parse(String(b.signalAt ?? b.at ?? ""));
    if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
    if (!Number.isFinite(ta)) return 1;
    if (!Number.isFinite(tb)) return -1;
    return ta - tb;
  });

  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  /** @type {Map<string, number>} */
  const clusterStartMs = new Map();

  for (const card of sorted) {
    const key = backfillDedupKey(card);
    const t = Date.parse(String(card.signalAt ?? card.at ?? ""));
    if (!Number.isFinite(t)) {
      out.push(card);
      continue;
    }
    const start = clusterStartMs.get(key);
    if (start != null && t - start < windowMs) continue;
    clusterStartMs.set(key, t);
    out.push(card);
  }
  return out;
}
