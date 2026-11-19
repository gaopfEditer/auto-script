/**
 * ST 5m POP 逢高试空 — lightweight-charts 标记（与回测 v0 一致：进场固定 %，预览用）
 */
import type { PatternCandle, PatternChartMarker } from "../types";

export const ST_POP_SHORT_MARKER_KINDS = new Set(["st_pop_short"]);
export const ST_POP_SHORT_COLOR = "#ff1744";

const BASE_RUSH = 0.35;
const BASE_WICK = 0.15;
const BB_TOL = 0.1;
const EMA_DIST = 0.25;
const VOL_Z_MIN = 1.5;
const WICK_RATIO_MIN = 0.45;
const MIN_BARS = 200;

function ema(values: number[], span: number): number[] {
  const out: number[] = [];
  const k = 2 / (span + 1);
  let prev = values[0];
  for (let i = 0; i < values.length; i++) {
    const v = values[i];
    prev = i === 0 ? v : v * k + prev * (1 - k);
    out.push(prev);
  }
  return out;
}

function prep(candles: PatternCandle[]) {
  const closes = candles.map((c) => c.close);
  const ema72 = ema(closes, 72);
  const ema144 = ema(closes, 144);
  const mid: number[] = [];
  const bbU: number[] = [];
  const bbL: number[] = [];
  const volZ: number[] = [];
  const rush3: number[] = [];
  const uwRatio: number[] = [];
  const uwPct: number[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i];
    const ret1 = i > 0 ? ((c.close - candles[i - 1].close) / candles[i - 1].close) * 100 : 0;
    let r3 = 0;
    if (i >= 3) {
      r3 =
        ((candles[i].close - candles[i - 1].close) / candles[i - 1].close) * 100 +
        ((candles[i - 1].close - candles[i - 2].close) / candles[i - 2].close) * 100 +
        ((candles[i - 2].close - candles[i - 3].close) / candles[i - 3].close) * 100;
    }
    rush3.push(r3);
    const hl = c.high - c.low;
    uwRatio.push(hl > 0 ? (c.high - c.close) / hl : 0);
    uwPct.push(c.close > 0 ? ((c.high - c.close) / c.close) * 100 : 0);
    let mean = 0;
    let cnt = 0;
    for (let j = Math.max(0, i - 47); j <= i; j++) {
      mean += candles[j].volume ?? 0;
      cnt++;
    }
    mean /= cnt || 1;
    let varr = 0;
    for (let j = Math.max(0, i - 47); j <= i; j++) {
      const v = candles[j].volume ?? 0;
      varr += (v - mean) ** 2;
    }
    const std = Math.sqrt(varr / (cnt || 1)) || 1e-9;
    volZ.push(((c.volume ?? 0) - mean) / std);
    if (i >= 19) {
      let s = 0;
      for (let j = i - 19; j <= i; j++) s += closes[j];
      const m = s / 20;
      let v = 0;
      for (let j = i - 19; j <= i; j++) v += (closes[j] - m) ** 2;
      const sd = Math.sqrt(v / 20);
      mid.push(m);
      bbU.push(m + 2 * sd);
      bbL.push(m - 2 * sd);
    } else {
      mid.push(NaN);
      bbU.push(NaN);
      bbL.push(NaN);
    }
  }
  return { ema72, ema144, bbU, bbL, volZ, rush3, uwRatio, uwPct };
}

function idxAtOrBefore(candles: PatternCandle[], tsSec: number): number {
  let lo = 0;
  let hi = candles.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candles[mid].time <= tsSec) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans;
}

function trendVetoShort(df15: PatternCandle[], df1h: PatternCandle[], tsSec: number): boolean {
  const i15 = idxAtOrBefore(df15, tsSec);
  const i1h = idxAtOrBefore(df1h, tsSec);
  if (i15 < 8 || i1h < 1) return true;
  const p15 = prep(df15);
  const p1h = prep(df1h);
  if (df15[i15].close <= p15.ema72[i15] || df1h[i1h].close <= p1h.ema72[i1h]) return false;
  let newLows = 0;
  for (let j = i15 - 7; j <= i15; j++) {
    if (j > 0 && df15[j].low < df15[j - 1].low) newLows++;
  }
  return newLows === 0;
}

function nearResistance(i: number, c: PatternCandle, p: ReturnType<typeof prep>): boolean {
  const bb = p.bbU[i];
  if (Number.isFinite(bb) && Math.abs(c.close - bb) / c.close <= BB_TOL / 100) return true;
  const e72 = p.ema72[i];
  const e144 = p.ema144[i];
  if (c.close > e72 && c.close > e144) {
    const d72 = ((c.close - e72) / c.close) * 100;
    const d144 = ((c.close - e144) / c.close) * 100;
    if (Math.min(d72, d144) <= EMA_DIST) return true;
  }
  return false;
}

function scoreAt(i: number, c: PatternCandle, p: ReturnType<typeof prep>): number {
  let s = 0;
  if (p.rush3[i] >= BASE_RUSH) s++;
  if (p.uwRatio[i] >= WICK_RATIO_MIN && p.uwPct[i] >= BASE_WICK) s++;
  if (p.volZ[i] >= VOL_Z_MIN) s++;
  if (nearResistance(i, c, p)) s++;
  return s;
}

export function buildStPopShortMarkers(
  candles5m: PatternCandle[],
  candles15m?: PatternCandle[],
  candles1h?: PatternCandle[],
): PatternChartMarker[] {
  if (candles5m.length < MIN_BARS) return [];
  const p = prep(candles5m);
  const c15 = candles15m?.length ? candles15m : [];
  const c1h = candles1h?.length ? candles1h : [];
  const markers: PatternChartMarker[] = [];
  const start = Math.max(MIN_BARS, candles5m.length - 800);
  for (let i = start; i < candles5m.length; i++) {
    const c = candles5m[i];
    if (scoreAt(i, c, p) < 3) continue;
    if (c15.length >= 9 && c1h.length >= 2 && trendVetoShort(c15, c1h, c.time)) continue;
    markers.push({
      time: c.time,
      position: "aboveBar",
      color: ST_POP_SHORT_COLOR,
      shape: "arrowDown",
      text: "短空",
      price: c.high,
      kind: "st_pop_short",
      size: 1.05,
    });
  }
  return markers;
}