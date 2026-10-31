/**
 * TD9 / 新高新低末端放量 — 图表 markers（仅已收盘 K）。
 * 算法对齐后端 td_sequential / range_extreme_volume。
 */
import type { PatternCandle, PatternChartMarker } from "../types";
import {
  isTd9Overbought,
  isTd9Oversold,
  tdSetupSeries,
  TD9_OVERBOUGHT_COLOR,
  TD9_OVERSOLD_COLOR,
} from "./tdSequential";
import {
  rangeExtremeSignalSeries,
  REV_VOL_BUY_COLOR,
  REV_VOL_SELL_COLOR,
  revVolLabelZh,
} from "./rangeExtremeVolume";

/**
 * 最近一根已收盘 K 的下标。
 * barDurationMs>0 时：若末棒尚未走完则退一格；否则默认排除可能未收盘的末棒。
 */
export function closedThroughIndex(
  candles: PatternCandle[],
  barDurationMs?: number,
  nowMs: number = Date.now(),
): number {
  if (!candles.length) return -1;
  let idx = candles.length - 1;
  // 传入 barDurationMs 时按「开盘+周期 ≤ now」判定末棒是否已收盘；
  // 未传（训练历史段等）则视全部为已收盘。
  if (barDurationMs != null && barDurationMs > 0) {
    const openMs = candles[idx].time * 1000;
    if (openMs + barDurationMs > nowMs && idx > 0) idx -= 1;
  }
  return idx;
}

/** TD9 超买/超卖完成标记（|td|==9 的已收盘棒） */
export function buildTd9Markers(
  candles: PatternCandle[],
  opts?: { barDurationMs?: number; nowMs?: number },
): PatternChartMarker[] {
  const through = closedThroughIndex(candles, opts?.barDurationMs, opts?.nowMs);
  if (through < 0) return [];
  const closes = candles.map((c) => c.close);
  const series = tdSetupSeries(closes);
  const markers: PatternChartMarker[] = [];
  for (let i = 0; i <= through; i++) {
    const td = series[i];
    const c = candles[i];
    if (isTd9Overbought(td)) {
      markers.push({
        time: c.time,
        position: "aboveBar",
        color: TD9_OVERBOUGHT_COLOR,
        shape: "arrowDown",
        text: "TD9超买",
        price: c.high,
        kind: "td9_overbought",
      });
    } else if (isTd9Oversold(td)) {
      markers.push({
        time: c.time,
        position: "belowBar",
        color: TD9_OVERSOLD_COLOR,
        shape: "arrowUp",
        text: "TD9超卖",
        price: c.low,
        kind: "td9_oversold",
      });
    }
  }
  return markers;
}

/** 新高/新低末端+放量标记（signal ±1 的已收盘棒） */
export function buildRevVolMarkers(
  candles: PatternCandle[],
  opts?: { barDurationMs?: number; nowMs?: number },
): PatternChartMarker[] {
  const through = closedThroughIndex(candles, opts?.barDurationMs, opts?.nowMs);
  if (through < 0) return [];
  const opens = candles.map((c) => c.open);
  const highs = candles.map((c) => c.high);
  const lows = candles.map((c) => c.low);
  const closes = candles.map((c) => c.close);
  const volumes = candles.map((c) => c.volume ?? 0);
  const series = rangeExtremeSignalSeries(highs, lows, opens, closes, volumes);
  const markers: PatternChartMarker[] = [];
  for (let i = 0; i <= through; i++) {
    const sig = series[i];
    if (sig === 0) continue;
    const c = candles[i];
    const lab = revVolLabelZh(sig);
    if (sig === 1) {
      markers.push({
        time: c.time,
        position: "belowBar",
        color: REV_VOL_BUY_COLOR,
        shape: "arrowUp",
        text: lab || "新低末端放量买",
        price: c.low,
        kind: "rev_vol_buy",
      });
    } else if (sig === -1) {
      markers.push({
        time: c.time,
        position: "aboveBar",
        color: REV_VOL_SELL_COLOR,
        shape: "arrowDown",
        text: lab || "新高末端放量卖",
        price: c.high,
        kind: "rev_vol_sell",
      });
    }
  }
  return markers;
}

export function buildConfluenceChartMarkers(
  candles: PatternCandle[],
  opts?: { barDurationMs?: number; nowMs?: number },
): PatternChartMarker[] {
  return [
    ...buildTd9Markers(candles, opts),
    ...buildRevVolMarkers(candles, opts),
  ];
}
