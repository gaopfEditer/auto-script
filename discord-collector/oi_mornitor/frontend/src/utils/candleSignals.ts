/**
 * K 线形态信号 — 对齐 tradingview-bollinger-wicks.pine
 * （射击之星 / 倒锤子 / 连续插针 + 维加斯 V 前缀 + OI 异动后缀）
 */
import type { PatternCandle, PatternChartMarker } from "../types";

const SHOOT_WICK_RATIO = 1.5;
const SHOOT_WICK_MAX = 20;
const SHOOT_REPEAT_BARS = 5;
const CONT_WICK_COUNT = 2;
const BB_WICK_RATIO = 0.3;
const VEGAS_TOL_BB_PCT = 20;
const OI_LOOKBACK = 20;
const OI_TRIM_HIGH = 4;
const OI_BAR_MULT = 2.0;
const OI_VOL_MULT = 1.1;
const OI_VOL_Z = 0.8;

export const CANDLE_SIGNAL_KINDS = new Set([
  "shooting_star",
  "inverted_hammer",
  "continuous_upper_wick",
  "continuous_lower_wick",
  "continuous_non_upper_wick",
  "continuous_non_lower_wick",
]);

type BarCtx = {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  bbUpper: number;
  bbMid: number;
  bbLower: number;
  vegas: number[]; // A/B 四条：144/169/576/676
  oi: number | null;
};

function bodySize(b: BarCtx): number {
  return Math.abs(b.close - b.open);
}

function upperWick(b: BarCtx): number {
  return b.high - Math.max(b.open, b.close);
}

function lowerWick(b: BarCtx): number {
  return Math.min(b.open, b.close) - b.low;
}

export function detectShootingStar(
  b: Pick<BarCtx, "open" | "high" | "low" | "close">,
  atLower: boolean,
): boolean {
  const body = Math.abs(b.close - b.open);
  const uw = b.high - Math.max(b.open, b.close);
  const lw = Math.min(b.open, b.close) - b.low;
  if (body <= 0 || uw <= 0) return false;
  if (uw < body * SHOOT_WICK_RATIO || uw > body * SHOOT_WICK_MAX) return false;
  const lowerOk = lw <= 0 || (uw > 0 && lw * 2 < uw);
  if (!lowerOk) return false;
  if (atLower && b.close >= b.open) return false;
  return true;
}

export function detectInvertedHammer(
  b: Pick<BarCtx, "open" | "high" | "low" | "close">,
): boolean {
  const body = Math.abs(b.close - b.open);
  const uw = b.high - Math.max(b.open, b.close);
  const lw = Math.min(b.open, b.close) - b.low;
  if (body <= 0) return false;
  return lw >= body * SHOOT_WICK_RATIO && uw < lw / 3;
}

function detectBbWick(b: BarCtx): { upper: boolean; lower: boolean } {
  const body = bodySize(b);
  const uw = upperWick(b);
  const lw = lowerWick(b);
  const upper =
    b.high > b.bbUpper &&
    uw > 0 &&
    (body === 0 || uw / Math.max(body, 1e-12) >= BB_WICK_RATIO);
  const lower =
    b.low < b.bbLower &&
    lw > 0 &&
    (body === 0 || lw / Math.max(body, 1e-12) >= BB_WICK_RATIO);
  return { upper, lower };
}

function nearVegasChannel(b: BarCtx): boolean {
  const width = b.bbUpper - b.bbLower;
  if (!(width > 0) || b.vegas.length < 4) return false;
  const tol = (width * VEGAS_TOL_BB_PCT) / 100;
  let minDist = Infinity;
  for (const e of b.vegas) {
    if (!Number.isFinite(e)) continue;
    minDist = Math.min(
      minDist,
      Math.abs(b.high - e),
      Math.abs(b.low - e),
      Math.abs(b.close - e),
    );
  }
  return minDist <= tol;
}

function trimmedMeanAbsPrev(
  absBars: (number | null)[],
  i: number,
  lookback: number,
  trimHigh: number,
): number | null {
  const arr: number[] = [];
  for (let k = 1; k <= lookback; k++) {
    const v = absBars[i - k];
    if (v != null && Number.isFinite(v)) arr.push(v);
  }
  if (arr.length < 3) return null;
  arr.sort((a, b) => a - b);
  const trimN = Math.min(trimHigh, arr.length - 1);
  const keep = arr.length - trimN;
  if (keep < 1) return null;
  let sum = 0;
  for (let j = 0; j < keep; j++) sum += arr[j];
  return sum / keep;
}

/** 与 Pine：巨量 + |ΔOI| > 剔除高值后均值×倍数 → (oi异动) */
export function computeOiAnomalyFlags(
  volumes: number[],
  oiSeries: (number | null)[],
): boolean[] {
  const n = volumes.length;
  const flags = new Array<boolean>(n).fill(false);
  const deltaAbs: (number | null)[] = new Array(n).fill(null);
  const deltaSigned: (number | null)[] = new Array(n).fill(null);

  for (let i = 1; i < n; i++) {
    const a = oiSeries[i];
    const b = oiSeries[i - 1];
    if (a == null || b == null || !(a > 0) || !(b > 0)) continue;
    const d = a - b;
    deltaSigned[i] = d;
    deltaAbs[i] = Math.abs(d);
  }

  for (let i = 0; i < n; i++) {
    const dAbs = deltaAbs[i];
    const dSigned = deltaSigned[i];
    if (dAbs == null || dSigned == null) continue;

    const base = trimmedMeanAbsPrev(deltaAbs, i, OI_LOOKBACK, OI_TRIM_HIGH);
    if (base == null || !(base > 0) || !(dAbs > OI_BAR_MULT * base)) continue;

    // vol SMA / stdev over lookback ending at i (inclusive of current, like ta.sma)
    if (i + 1 < OI_LOOKBACK) continue;
    let sum = 0;
    for (let j = i - OI_LOOKBACK + 1; j <= i; j++) sum += volumes[j];
    const volSma = sum / OI_LOOKBACK;
    if (!(volSma > 0)) continue;
    let varSum = 0;
    for (let j = i - OI_LOOKBACK + 1; j <= i; j++) {
      const d = volumes[j] - volSma;
      varSum += d * d;
    }
    const volStd = Math.sqrt(varSum / OI_LOOKBACK);
    const vol = volumes[i];
    const volHugeMult = vol > volSma * OI_VOL_MULT;
    const volHugeZ = OI_VOL_Z <= 0 || vol > volSma + OI_VOL_Z * volStd;
    if (!(volHugeMult && volHugeZ)) continue;

    flags[i] = true;
  }
  return flags;
}

function sigPrefix(name: string, nearVegas: boolean, oiAnomaly: boolean): string {
  const base = nearVegas ? `V${name}` : name;
  return oiAnomaly ? `${base}(oi异动)` : base;
}

function atLowerBand(b: BarCtx): boolean {
  const midToLower = b.bbMid - b.bbLower;
  const zone = b.bbLower + midToLower * 0.15;
  return b.low <= zone;
}

/**
 * 扫描全序列，产出形态 markers（text 已含 V / oi异动）。
 */
export function buildCandleSignalMarkers(
  candles: PatternCandle[],
  opts: {
    bbUpper: Map<number, number>;
    bbMid: Map<number, number>;
    bbLower: Map<number, number>;
    vegasA1: Map<number, number>;
    vegasA2: Map<number, number>;
    vegasB1: Map<number, number>;
    vegasB2: Map<number, number>;
    /** candle.time(sec) → open interest */
    oiByTime?: Map<number, number>;
  },
): PatternChartMarker[] {
  const markers: PatternChartMarker[] = [];
  const bars: (BarCtx | null)[] = [];
  const volumes: number[] = [];
  const oiSeries: (number | null)[] = [];

  for (const c of candles) {
    const mid = opts.bbMid.get(c.time);
    const up = opts.bbUpper.get(c.time);
    const lo = opts.bbLower.get(c.time);
    volumes.push(c.volume ?? 0);
    oiSeries.push(opts.oiByTime?.get(c.time) ?? null);
    if (mid == null || up == null || lo == null) {
      bars.push(null);
      continue;
    }
    const v1 = opts.vegasA1.get(c.time);
    const v2 = opts.vegasA2.get(c.time);
    const v3 = opts.vegasB1.get(c.time);
    const v4 = opts.vegasB2.get(c.time);
    const vegasOk =
      v1 != null &&
      v2 != null &&
      v3 != null &&
      v4 != null &&
      [v1, v2, v3, v4].every((x) => Number.isFinite(x));
    bars.push({
      open: c.open,
      high: c.high,
      low: c.low,
      close: c.close,
      volume: c.volume ?? 0,
      bbUpper: up,
      bbMid: mid,
      bbLower: lo,
      vegas: vegasOk ? [v1, v2, v3, v4] : [],
      oi: opts.oiByTime?.get(c.time) ?? null,
    });
  }

  const oiFlags = computeOiAnomalyFlags(volumes, oiSeries);

  let contUpper = 0;
  let contLower = 0;
  const nonZoneUpperBars: number[] = [];
  const nonZoneLowerBars: number[] = [];
  let lastShootIdx = -1;

  for (let i = 0; i < candles.length; i++) {
    const b = bars[i];
    if (!b || !(b.bbUpper > b.bbLower)) continue;
    const c = candles[i];
    const nearV = nearVegasChannel(b);
    const oiTag = oiFlags[i];
    const label = (name: string) => sigPrefix(name, nearV, oiTag);

    // ---- 连续插针（上下轨附近）----
    const midToUpper = b.bbUpper - b.bbMid;
    const upperZone = b.bbMid + midToUpper * 0.85;
    const inUpperZone = b.high >= upperZone;
    const body = bodySize(b);
    const uw = upperWick(b);
    const lw = lowerWick(b);
    const validUpper = inUpperZone && uw > body && uw > 0;
    if (validUpper) {
      contUpper += 1;
      if (contUpper === CONT_WICK_COUNT) {
        markers.push({
          time: c.time,
          position: "aboveBar",
          color: "#9c27b0",
          shape: "arrowDown",
          text: label("连续上插针"),
          price: c.high,
          kind: "continuous_upper_wick",
        });
      }
    } else {
      contUpper = 0;
    }

    const midToLower = b.bbMid - b.bbLower;
    const lowerZone = b.bbLower + midToLower * 0.15;
    const inLowerZone = b.low <= lowerZone;
    const validLower = inLowerZone && lw > body && lw > 0;
    if (validLower) {
      contLower += 1;
      if (contLower === CONT_WICK_COUNT) {
        markers.push({
          time: c.time,
          position: "belowBar",
          color: "#9c27b0",
          shape: "arrowUp",
          text: label("连续下插针"),
          price: c.low,
          kind: "continuous_lower_wick",
        });
      }
    } else {
      contLower = 0;
    }

    // ---- 非上下轨附近连续插针（允许跳过 ≤2 根，≥3 次）----
    const bbWick = detectBbWick(b);
    if (bbWick.upper && !inUpperZone) {
      nonZoneUpperBars.push(i);
      if (nonZoneUpperBars.length > 20) nonZoneUpperBars.shift();
      if (nonZoneUpperBars.length >= 3) {
        let recent = 1;
        let last = i;
        for (let k = nonZoneUpperBars.length - 2; k >= 0; k--) {
          const wb = nonZoneUpperBars[k];
          const gap = last - wb - 1;
          if (gap <= 2) {
            recent += 1;
            last = wb;
          } else break;
        }
        if (recent >= 3) {
          markers.push({
            time: c.time,
            position: "aboveBar",
            color: "#7b1fa2",
            shape: "arrowDown",
            text: label("非上轨连续上插针"),
            price: c.high,
            kind: "continuous_non_upper_wick",
          });
        }
      }
    }
    if (bbWick.lower && !inLowerZone) {
      nonZoneLowerBars.push(i);
      if (nonZoneLowerBars.length > 20) nonZoneLowerBars.shift();
      if (nonZoneLowerBars.length >= 3) {
        let recent = 1;
        let last = i;
        for (let k = nonZoneLowerBars.length - 2; k >= 0; k--) {
          const wb = nonZoneLowerBars[k];
          const gap = last - wb - 1;
          if (gap <= 2) {
            recent += 1;
            last = wb;
          } else break;
        }
        if (recent >= 3) {
          markers.push({
            time: c.time,
            position: "belowBar",
            color: "#7b1fa2",
            shape: "arrowUp",
            text: label("非下轨连续下插针"),
            price: c.low,
            kind: "continuous_non_lower_wick",
          });
        }
      }
    }

    // ---- 射击之星 / 倒锤子 ----
    const atLower = atLowerBand(b);
    const shootShape = detectShootingStar(b, atLower);
    if (shootShape) {
      const isSecond =
        lastShootIdx >= 0 && i > lastShootIdx && i - lastShootIdx <= SHOOT_REPEAT_BARS;
      const name = isSecond ? "射击之星（2）" : "射击之星";
      markers.push({
        time: c.time,
        position: "aboveBar",
        color: "#ff4081",
        shape: "arrowDown",
        text: label(name),
        price: c.high,
        kind: "shooting_star",
      });
      lastShootIdx = i;
      continue;
    }

    const belowMid = b.low <= b.bbMid;
    if (belowMid && detectInvertedHammer(b)) {
      markers.push({
        time: c.time,
        position: "belowBar",
        color: "#00bcd4",
        shape: "arrowUp",
        text: label("倒锤子"),
        price: c.low,
        kind: "inverted_hammer",
      });
    }
  }

  return markers;
}
