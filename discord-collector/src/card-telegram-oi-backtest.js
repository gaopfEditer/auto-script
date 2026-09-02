/**
 * OI → Telegram 形态卡片回测：阶梯触达延时窗口（主流 / 山寨分档）。
 * 阈值按价格涨跌幅 %（非杠杆盈亏）；延时规则可经 env / 请求覆盖。
 */
import { config } from "./config.js";
import { detectSymbolTier } from "./card-backtest-policy.js";
import { calcLeveragePnl } from "./card-price-fetch.js";
import { resolveLiquidationLeverage } from "./card-liquidation-engine.js";

/** @typedef {'telegram_oi' | 'window_days'} BacktestPolicyId */

/**
 * @typedef {{
 *   stepPct: number,
 *   initialWindowMs: number,
 *   extendWindowMs: number,
 *   maxWindowMs: number,
 *   extendOnStep: boolean,
 *   tier: 'major' | 'altcoin',
 *   label: string,
 * }} TelegramOiRollingSpec
 */

const MS_H = 60 * 60 * 1000;

/**
 * @param {unknown} tier
 * @param {Record<string, unknown>} [overrides]
 * @returns {TelegramOiRollingSpec}
 */
export function getTelegramOiRollingSpec(tier, overrides = {}) {
  const isMajor = tier === "major";
  const stepPct = numOverride(
    overrides.stepPct ?? overrides.profitThresholdPct,
    isMajor ? config.tgSignalBacktestMajorStepPct : config.tgSignalBacktestAltStepPct
  );
  const initialH = numOverride(
    overrides.initialWindowH ?? overrides.initialWindowHours,
    isMajor ? config.tgSignalBacktestMajorInitialH : config.tgSignalBacktestAltInitialH
  );
  const extendH = numOverride(
    overrides.extendWindowH ?? overrides.extendWindowHours,
    isMajor ? config.tgSignalBacktestMajorExtendH : config.tgSignalBacktestAltExtendH
  );
  const maxH = numOverride(overrides.maxWindowH ?? overrides.maxWindowHours, config.tgSignalBacktestMaxH);
  const extendOnStep =
    overrides.extendOnStep != null
      ? truthy(overrides.extendOnStep)
      : isMajor
        ? config.tgSignalBacktestMajorExtendOnStep
        : config.tgSignalBacktestAltExtendOnStep;

  return {
    stepPct,
    initialWindowMs: Math.max(1, initialH) * MS_H,
    extendWindowMs: Math.max(0, extendH) * MS_H,
    maxWindowMs: Math.max(initialH, maxH) * MS_H,
    extendOnStep,
    tier: isMajor ? "major" : "altcoin",
    label: isMajor
      ? `主流 · 初始 ${initialH}h · 阶梯 ±${stepPct}%`
      : `山寨 · 初始 ${initialH}h · 每 ±${stepPct}% 延时 ${extendH}h · 最长 ${maxH}h`,
  };
}

/**
 * @param {unknown} v
 * @param {number} fallback
 */
function numOverride(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** @param {unknown} v */
function truthy(v) {
  if (v === true || v === 1) return true;
  const s = String(v ?? "").toLowerCase();
  return ["1", "true", "yes", "on"].includes(s);
}

/**
 * @param {unknown} row
 * @param {Record<string, unknown>} [body]
 * @returns {BacktestPolicyId}
 */
export function resolveBacktestPolicy(row, body = {}) {
  const raw =
    (row && typeof row === "object" ? /** @type {Record<string, unknown>} */ (row).backtestPolicy : null) ??
    (row && typeof row === "object" ? /** @type {Record<string, unknown>} */ (row).policy : null) ??
    body.backtestPolicy ??
    body.policy ??
    body.backtest_profile ??
    "";
  const s = String(raw ?? "").trim().toLowerCase();
  if (["telegram_oi", "oi_telegram", "oi-tg", "tg_oi"].includes(s)) return "telegram_oi";
  const src = String(
    (row && typeof row === "object" ? /** @type {Record<string, unknown>} */ (row).source : "") ?? ""
  ).toLowerCase();
  if (["oi_telegram", "oi-telegram", "oi_candle", "oi_structure"].includes(src)) return "telegram_oi";
  return "window_days";
}

/**
 * @param {number} entry
 * @param {number} price
 */
export function absPriceMovePct(entry, price) {
  if (!entry || !price) return 0;
  return (Math.abs(price - entry) / entry) * 100;
}

/**
 * 扫描 K 线，计算延时后的有效观察窗与阶梯触达。
 * @param {Array<{ high: number, low: number, close?: number, ts?: number }>} klines
 * @param {number} entry
 * @param {boolean} isShort
 * @param {number} leverage
 * @param {TelegramOiRollingSpec} spec
 * @param {number} entryMs
 */
export function evaluateTelegramOiRollingWindow(klines, entry, isShort, leverage, spec, entryMs) {
  const maxEndMs = entryMs + spec.maxWindowMs;
  let windowEndMs = entryMs + spec.initialWindowMs;

  const sorted = [...klines]
    .filter((k) => {
      const ts = k.ts ?? 0;
      return ts >= entryMs - 1 && ts <= maxEndMs;
    })
    .sort((a, b) => (a.ts ?? 0) - (b.ts ?? 0));

  let lastStepTier = 0;
  /** @type {Array<{ tier: number, movePct: number, at: string, windowExtendedTo: string }>} */
  const milestones = [];
  /** @type {string | null} */
  let firstStepHitAt = null;

  for (const k of sorted) {
    const ts = k.ts ?? 0;
    const high = Number(k.high);
    const low = Number(k.low);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    let maxAbsOnBar = 0;
    for (const p of [high, low]) {
      maxAbsOnBar = Math.max(maxAbsOnBar, absPriceMovePct(entry, p));
    }
    const tier = spec.stepPct > 0 ? Math.floor(maxAbsOnBar / spec.stepPct) : 0;
    if (tier > lastStepTier) {
      for (let t = lastStepTier + 1; t <= tier; t++) {
        if (spec.extendOnStep && spec.extendWindowMs > 0) {
          windowEndMs = Math.min(maxEndMs, windowEndMs + spec.extendWindowMs);
        }
        milestones.push({
          tier: t,
          movePct: Math.round(t * spec.stepPct * 1000) / 1000,
          at: new Date(ts).toISOString(),
          windowExtendedTo: new Date(windowEndMs).toISOString(),
        });
      }
      lastStepTier = tier;
      if (!firstStepHitAt) firstStepHitAt = new Date(ts).toISOString();
    }
  }

  windowEndMs = Math.min(windowEndMs, maxEndMs);
  const effective = sorted.filter((k) => (k.ts ?? 0) <= windowEndMs);

  let peak = -Infinity;
  let trough = Infinity;
  /** @type {string | null} */
  let peakAt = null;
  /** @type {string | null} */
  let troughAt = null;
  /** @type {number | null} */
  let peakPrice = null;
  /** @type {number | null} */
  let troughPrice = null;
  let hitStepBeforePeak = false;
  let hitStepBeforeTrough = false;
  let hitTh = false;

  for (const k of effective) {
    const ts = k.ts ?? 0;
    const at = ts ? new Date(ts).toISOString() : null;
    const high = Number(k.high);
    const low = Number(k.low);
    if (!Number.isFinite(high) || !Number.isFinite(low)) continue;

    const bestPrice = isShort ? low : high;
    const worstPrice = isShort ? high : low;
    const best = calcLeveragePnl(entry, bestPrice, isShort, leverage);
    const worst = calcLeveragePnl(entry, worstPrice, isShort, leverage);

    if (best && best.pnlPctOnMargin > peak) {
      peak = best.pnlPctOnMargin;
      peakAt = at;
      peakPrice = bestPrice;
      hitStepBeforePeak = hitTh;
    }
    if (worst && worst.pnlPctOnMargin < trough) {
      trough = worst.pnlPctOnMargin;
      troughAt = at;
      troughPrice = worstPrice;
      hitStepBeforeTrough = hitTh;
    }

    const absMove = Math.max(absPriceMovePct(entry, high), absPriceMovePct(entry, low));
    if (absMove >= spec.stepPct) hitTh = true;
  }

  const last = effective[effective.length - 1];
  const currentPnl =
    last != null
      ? calcLeveragePnl(entry, Number(last.close ?? last.high ?? last.low), isShort, leverage)
      : null;

  const maxAbsMovePct =
    effective.length > 0
      ? Math.max(
          ...effective.flatMap((k) => [
            absPriceMovePct(entry, Number(k.high)),
            absPriceMovePct(entry, Number(k.low)),
          ])
        )
      : 0;

  return {
    policy: "telegram_oi",
    rollingSpec: {
      stepPct: spec.stepPct,
      initialWindowH: spec.initialWindowMs / MS_H,
      extendWindowH: spec.extendWindowMs / MS_H,
      maxWindowH: spec.maxWindowMs / MS_H,
      extendOnStep: spec.extendOnStep,
      tierLabel: spec.label,
    },
    windowEndAt: new Date(windowEndMs).toISOString(),
    maxWindowEndAt: new Date(maxEndMs).toISOString(),
    initialWindowEndAt: new Date(entryMs + spec.initialWindowMs).toISOString(),
    stepTiersHit: lastStepTier,
    maxAbsMovePct: Math.round(maxAbsMovePct * 1000) / 1000,
    hitStepThreshold: lastStepTier >= 1,
    firstStepHitAt,
    milestones,
    maxProfitPct: Number.isFinite(peak) ? Math.round(peak * 100) / 100 : null,
    maxProfitAt: peakAt,
    maxProfitPrice: peakPrice,
    minProfitPct: Number.isFinite(trough) ? Math.round(trough * 100) / 100 : null,
    minProfitAt: troughAt,
    minProfitPrice: troughPrice,
    hitProfitThresholdBeforeMax: hitStepBeforePeak,
    hitProfitThresholdBeforeMin: hitStepBeforeTrough,
    currentPnlPct: currentPnl?.pnlPctOnMargin ?? null,
    klineCountInWindow: effective.length,
    windowEndAtMs: windowEndMs,
  };
}

/**
 * OI 形态 alert → 回测 signal（Telegram 推送同源字段）。
 * @param {unknown} alert
 * @param {number} index
 */
export function oiAlertToBacktestSignal(alert, index = 0) {
  if (!alert || typeof alert !== "object") return null;
  const a = /** @type {Record<string, unknown>} */ (alert);
  const symRaw = String(a.symbol ?? "").trim().toUpperCase();
  const bare = symRaw.replace(/USDT$|USDC$|BUSD$/, "");
  if (!bare) return null;

  const side = String(a.side ?? "").toLowerCase();
  let direction = "long";
  if (side === "bear" || side === "short" || side === "空") direction = "short";
  else if (side === "bull" || side === "long" || side === "多") direction = "long";
  else if (/顶|bear|short|空|看跌/.test(String(a.pattern_label ?? a.type_label ?? a.status_label ?? ""))) {
    direction = "short";
  } else if (/底|bull|long|多|看涨/.test(String(a.pattern_label ?? a.type_label ?? ""))) {
    direction = "long";
  }

  const tsRaw = a.kline_open_time ?? a.time ?? a.signalAt ?? a.scan_ts;
  let signalMs = NaN;
  if (typeof tsRaw === "number" && Number.isFinite(tsRaw)) {
    signalMs = tsRaw > 10_000_000_000 ? tsRaw : tsRaw * 1000;
  } else {
    signalMs = Date.parse(String(tsRaw ?? ""));
  }
  const signalAt = Number.isFinite(signalMs) ? new Date(signalMs).toISOString() : new Date().toISOString();

  const priceRaw = a.price ?? a.close ?? a.entry;
  const entryNum = priceRaw != null && priceRaw !== "" ? Number(priceRaw) : NaN;
  const entry = Number.isFinite(entryNum) && entryNum > 0 ? entryNum : null;

  const tier = detectSymbolTier(bare);
  const rolling = getTelegramOiRollingSpec(tier);

  return {
    id: String(a.id ?? a.dedupe ?? `${bare}-${signalAt}-${index}`),
    symbol: bare,
    direction: /** @type {'long' | 'short'} */ (direction),
    signalAt,
    entry,
    entryMode: entry != null ? "limit" : "market",
    tier,
    profitThresholdPct: rolling.stepPct,
    backtestPolicy: /** @type {BacktestPolicyId} */ ("telegram_oi"),
    source: String(a.source ?? "oi_telegram"),
    interval: String(a.interval ?? ""),
    signalKind: String(a.kind ?? a.signal_kind ?? a.type ?? ""),
    typeLabel: String(a.type_label ?? a.pattern_label ?? ""),
  };
}

/**
 * OI → Telegram 形态卡片回测说明（env 可调，见 TG_SIGNAL_BACKTEST_*）。
 * @param {'major' | 'altcoin'} tier
 */
export function telegramOiBacktestTierLabel(tier) {
  return getTelegramOiRollingSpec(tier).label;
}

/**
 * @param {unknown} raw
 * @returns {import("./card-validate-signals.js").BacktestSignalInput[]}
 */
export function parseOiTelegramAlerts(raw) {
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray(/** @type {{ alerts: unknown[] }} */ (raw).alerts) ? /** @type {{ alerts: unknown[] }} */ (raw).alerts : [];
  /** @type {import("./card-validate-signals.js").BacktestSignalInput[]} */
  const out = [];
  for (let i = 0; i < list.length; i++) {
    const sig = oiAlertToBacktestSignal(list[i], i);
    if (sig) out.push(sig);
  }
  return out.slice(0, 500);
}
