/**
 * Telegram 群组页：跟单仓位加成回放（本地工具）。
 * 盈亏模拟按单笔 ±100% × 当时仓位（U），与 aggregateMetrics 实际 pnlPct 无关。
 */

/** @typedef {{
 *   basePosition: number,
 *   winBumpPct: number,
 *   lossCutPct: number,
 *   minPosition: number,
 * }} CopySizingParams */

/** @typedef {'win' | 'loss'} CopySizingOutcome */

/** @typedef {{
 *   id?: string,
 *   symbol?: string,
 *   signalAt?: string,
 *   outcome: CopySizingOutcome,
 *   settledAtMs: number,
 * }} CopySizingTradeInput */

/** @typedef {CopySizingTradeInput & {
 *   position: number,
 *   simulatedPnl: number,
 *   cumulativePnl: number,
 *   nextPosition: number,
 * }} CopySizingReplayStep */

export const DEFAULT_COPY_SIZING_PARAMS = Object.freeze({
  basePosition: 1,
  winBumpPct: 10,
  lossCutPct: 20,
  minPosition: 1,
});

/**
 * @param {Partial<CopySizingParams> | null | undefined} raw
 * @returns {CopySizingParams}
 */
export function normalizeCopySizingParams(raw) {
  const p = raw && typeof raw === "object" ? raw : {};
  const basePosition = finitePositive(p.basePosition, DEFAULT_COPY_SIZING_PARAMS.basePosition);
  const minPosition = finitePositive(p.minPosition, DEFAULT_COPY_SIZING_PARAMS.minPosition);
  const winBumpPct = finiteNonNeg(p.winBumpPct, DEFAULT_COPY_SIZING_PARAMS.winBumpPct);
  const lossCutPct = finiteNonNeg(p.lossCutPct, DEFAULT_COPY_SIZING_PARAMS.lossCutPct);
  return {
    basePosition,
    winBumpPct,
    lossCutPct,
    minPosition,
  };
}

/**
 * @param {number} position 本单使用仓位（U）
 * @param {CopySizingOutcome} outcome
 * @param {Partial<CopySizingParams>} params
 * @returns {number} 下一单仓位（U）
 */
export function advancePositionAfterOutcome(position, outcome, params) {
  const cfg = normalizeCopySizingParams(params);
  const cur = finitePositive(position, cfg.basePosition);
  let next = cur;
  if (outcome === "win") {
    next = cur * (1 + cfg.winBumpPct / 100);
  } else if (outcome === "loss") {
    next = cur * (1 - cfg.lossCutPct / 100);
  }
  if (!Number.isFinite(next) || next < 0) next = cfg.minPosition;
  return Math.max(cfg.minPosition, next);
}

/**
 * @param {CopySizingTradeInput[]} trades
 * @param {Partial<CopySizingParams>} params
 */
export function replayCopySizingHistory(trades, params) {
  const cfg = normalizeCopySizingParams(params);
  const list = Array.isArray(trades) ? trades.filter(Boolean) : [];
  const sorted = [...list].sort((a, b) => {
    const d = (a.settledAtMs || 0) - (b.settledAtMs || 0);
    if (d !== 0) return d;
    return String(a.id ?? a.signalAt ?? "").localeCompare(String(b.id ?? b.signalAt ?? ""));
  });

  let position = cfg.basePosition;
  let cumulative = 0;
  /** @type {CopySizingReplayStep[]} */
  const steps = [];

  for (const t of sorted) {
    const used = position;
    const pnl = t.outcome === "win" ? used : -used;
    cumulative += pnl;
    const nextPosition = advancePositionAfterOutcome(used, t.outcome, cfg);
    steps.push({
      ...t,
      position: roundU(used),
      simulatedPnl: roundU(pnl),
      cumulativePnl: roundU(cumulative),
      nextPosition: roundU(nextPosition),
    });
    position = nextPosition;
  }

  return {
    replayCount: steps.length,
    suggestedNextPosition: roundU(steps.length ? steps[steps.length - 1].nextPosition : cfg.basePosition),
    cumulativeSimPnl: roundU(cumulative),
    steps,
  };
}

/**
 * group-eval 卡片行 → 回放输入（与 evaluate 口径：已入场且 take_profit / stop_loss）。
 * @param {Record<string, unknown>} card
 * @returns {CopySizingTradeInput | null}
 */
export function evalCardToCopySizingTrade(card) {
  if (!card || typeof card !== "object") return null;
  if (card.entered === false) return null;
  const outcomeRaw = String(card.outcome ?? "").trim();
  /** @type {CopySizingOutcome | null} */
  let outcome = null;
  if (outcomeRaw === "take_profit") outcome = "win";
  else if (outcomeRaw === "stop_loss") outcome = "loss";
  else return null;

  const settledAtMs = resolveEvalCardSettledAtMs(card);
  return {
    id: card.id != null ? String(card.id) : undefined,
    symbol: card.symbol != null ? String(card.symbol) : undefined,
    signalAt: card.signalAt != null ? String(card.signalAt) : undefined,
    outcome,
    settledAtMs,
  };
}

/**
 * @param {Record<string, unknown>} card
 */
export function resolveEvalCardSettledAtMs(card) {
  /** @type {number[]} */
  const candidates = [];
  const prog =
    card.progress && typeof card.progress === "object"
      ? /** @type {Record<string, unknown>} */ (card.progress)
      : null;
  if (prog?.slHitAt) pushTime(candidates, prog.slHitAt);
  const tpHits = Array.isArray(prog?.tpHits) ? prog.tpHits : [];
  for (const h of tpHits) {
    if (h && typeof h === "object" && /** @type {Record<string, unknown>} */ (h).hitAt) {
      pushTime(candidates, /** @type {Record<string, unknown>} */ (h).hitAt);
    }
  }
  const ex =
    card.execution && typeof card.execution === "object"
      ? /** @type {Record<string, unknown>} */ (card.execution).actual
      : null;
  if (ex && typeof ex === "object" && /** @type {Record<string, unknown>} */ (ex).closedAt) {
    pushTime(candidates, /** @type {Record<string, unknown>} */ (ex).closedAt);
  }
  if (prog?.entryHitAt) pushTime(candidates, prog.entryHitAt);
  if (card.signalAt) pushTime(candidates, card.signalAt);

  const valid = candidates.filter((n) => Number.isFinite(n) && n > 0);
  if (valid.length) return Math.max(...valid);
  return 0;
}

/**
 * @param {Record<string, unknown>[]} cards
 * @param {Partial<CopySizingParams>} params
 */
export function replayFromEvalCards(cards, params) {
  const trades = [];
  for (const c of cards || []) {
    const t = evalCardToCopySizingTrade(c);
    if (t) trades.push(t);
  }
  return replayCopySizingHistory(trades, params);
}

/** @param {unknown} v @param {number} fallback */
function finitePositive(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return n;
}

/** @param {unknown} v @param {number} fallback */
function finiteNonNeg(v, fallback) {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return n;
}

/** @param {number[]} out @param {unknown} raw */
function pushTime(out, raw) {
  const t = Date.parse(String(raw));
  if (Number.isFinite(t)) out.push(t);
}

/** @param {number} n */
function roundU(n) {
  if (!Number.isFinite(n)) return 0;
  return Math.round(n * 10000) / 10000;
}
