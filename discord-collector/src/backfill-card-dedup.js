/**
 * 回溯卡片：同群同 symbol+方向+阶段，20 分钟内只保留最早一条（可配置）。
 */
import { config } from "./config.js";
import { filterQualityBackfillCards } from "./backfill-card-quality.js";

export function backfillDedupWindowMs() {
  const n = Number(config.telegramBackfillDedupWindowMs);
  return Number.isFinite(n) && n > 0 ? n : 20 * 60 * 1000;
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
export function dedupeBackfillCards(cards, windowMs = backfillDedupWindowMs()) {
  const cleaned = filterQualityBackfillCards(cards ?? []);
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
    if (start != null && t - start < windowMs) {
      continue;
    }
    clusterStartMs.set(key, t);
    out.push(card);
  }
  return out;
}

/**
 * @param {Record<string, unknown>} group
 * @param {number} [windowMs]
 */
export function dedupeBackfillGroupCards(group, windowMs) {
  if (!group || typeof group !== "object") return group;
  const win = windowMs ?? backfillDedupWindowMs();

  let changed = false;
  /** @type {Record<string, unknown>} */
  const next = { ...group };

  if (Array.isArray(group.backtestItems) && group.backtestItems.length) {
    const deduped = dedupeBackfillCards(
      /** @type {Array<Record<string, unknown>>} */ (group.backtestItems),
      win,
    );
    if (deduped.length !== group.backtestItems.length) {
      next.backtestItems = deduped;
      changed = true;
    }
  }
  if (Array.isArray(group.cards) && group.cards.length) {
    const deduped = dedupeBackfillCards(
      /** @type {Array<Record<string, unknown>>} */ (group.cards),
      win,
    );
    if (deduped.length !== group.cards.length) {
      next.cards = deduped;
      changed = true;
    }
  }

  if (!changed) return group;
  const rawN = Math.max(
    Array.isArray(group.backtestItems) ? group.backtestItems.length : 0,
    Array.isArray(group.cards) ? group.cards.length : 0,
  );
  const newN = Math.max(
    Array.isArray(next.backtestItems) ? next.backtestItems.length : 0,
    Array.isArray(next.cards) ? next.cards.length : 0,
  );
  next.dedupDropped = rawN - newN;
  next.cardEmitCount = newN;
  next.parsedSignalCount = newN;
  return next;
}
