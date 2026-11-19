/**
 * BTC/ETH 已收盘 5 分钟放量影线（多空）图表标记。
 * 与 Python `oi_mornitor.strategy.st_5m_vol_wick.signals` 同一套阈值，供研究对照：
 * - 放量：volume >= VOL_RATIO_MIN(1.5) × SMA(volume, 20)，只看信号柱
 * - 影线优先射击之星/倒锤子（主导影线 1.5–20×实体，对侧×2 < 主导），
 *   否则宽口径：主导影线 >= 1.05×实体 且 >= 32% 振幅
 * - 不含高潮量仅靠阴阳线判向；下影为多，上影为空；只标已收盘 K
 */
import type { PatternCandle, PatternChartMarker } from "../types";

export const ST_VOL_WICK_MARKER_KINDS = new Set(["st_vol_wick_long", "st_vol_wick_short"]);
export const ST_VOL_WICK_LONG_COLOR = "#00c853";
export const ST_VOL_WICK_SHORT_COLOR = "#ff1744";

export const VOL_MA_PERIOD = 20;
export const VOL_RATIO_MIN = 1.5;
export const WICK_BODY_RATIO = 1.5;
export const WICK_BODY_MAX = 20;
export const LOOSE_PIN_WICK_BODY = 1.05;
export const LOOSE_PIN_WICK_RANGE = 0.32;

function detectShootingStar(c: PatternCandle): boolean {
  const body = Math.abs(c.close - c.open);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  if (body <= 0 || upper <= 0) return false;
  if (upper < body * WICK_BODY_RATIO || upper > body * WICK_BODY_MAX) return false;
  if (lower > 0 && lower * 2 >= upper) return false;
  return true;
}

function detectInvertedHammer(c: PatternCandle): boolean {
  const body = Math.abs(c.close - c.open);
  const lower = Math.min(c.open, c.close) - c.low;
  const upper = c.high - Math.max(c.open, c.close);
  if (body <= 0 || lower <= 0) return false;
  if (lower < body * WICK_BODY_RATIO || lower > body * WICK_BODY_MAX) return false;
  if (upper > 0 && upper * 2 >= lower) return false;
  return true;
}

export function pinSide(c: PatternCandle): "short" | "long" | null {
  if (detectShootingStar(c)) return "short";
  if (detectInvertedHammer(c)) return "long";
  const body = Math.abs(c.close - c.open);
  const range = Math.max(0, c.high - c.low);
  if (body <= 0 || range <= 0) return null;
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  if (upper >= body * LOOSE_PIN_WICK_BODY && upper >= range * LOOSE_PIN_WICK_RANGE) return "short";
  if (lower >= body * LOOSE_PIN_WICK_BODY && lower >= range * LOOSE_PIN_WICK_RANGE) return "long";
  return null;
}

function volRatio(candles: PatternCandle[], i: number): number | null {
  if (i < VOL_MA_PERIOD - 1) return null;
  let sum = 0;
  for (let j = i - VOL_MA_PERIOD + 1; j <= i; j++) sum += Number(candles[j].volume ?? 0);
  const ma = sum / VOL_MA_PERIOD;
  if (ma <= 0) return null;
  return Number(candles[i].volume ?? 0) / ma;
}

export function buildStVolWickMarkers(candles5m: PatternCandle[]): PatternChartMarker[] {
  if (candles5m.length < VOL_MA_PERIOD) return [];
  const markers: PatternChartMarker[] = [];
  // 不标最后一根可能未收盘的 K：由调用方传入已收盘序列，或这里保守丢掉最后一根正在走的柱。
  // 与后端一致的做法是调用方已 drop unclosed；这里仍从 SMA 预热后扫到最后一根。
  const end = candles5m.length;
  for (let i = VOL_MA_PERIOD - 1; i < end; i++) {
    const c = candles5m[i];
    const side = pinSide(c);
    const ratio = volRatio(candles5m, i);
    if (!side || ratio == null || ratio < VOL_RATIO_MIN) continue;
    const isShort = side === "short";
    markers.push({
      time: c.time,
      position: isShort ? "aboveBar" : "belowBar",
      color: isShort ? ST_VOL_WICK_SHORT_COLOR : ST_VOL_WICK_LONG_COLOR,
      shape: isShort ? "arrowDown" : "arrowUp",
      text: isShort ? "放量空" : "放量多",
      price: isShort ? c.high : c.low,
      kind: isShort ? "st_vol_wick_short" : "st_vol_wick_long",
      size: 1.05,
    });
  }
  return markers;
}
