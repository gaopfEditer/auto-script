/**
 * 区间极值末端放量（AICoin 新高/新低末端 + 放量）—
 * 与后端 oi_mornitor/range_extreme_volume.py 对齐。
 * 图表标记只应画在已收盘 K 上（调用方传入 closedThroughIndex）。
 */

export const HHV_LEN = 50;
export const LLV_LEN = 50;
export const MA_LEN = 50;
export const MA_VOL = 120;
export const DEGREE_THRESHOLD = 0.2;
export const LOOKBACK = 4;

function sma(vals: Array<number | null>, end: number, window: number): number | null {
  if (end + 1 < window) return null;
  let sum = 0;
  for (let i = end + 1 - window; i <= end; i++) {
    const v = vals[i];
    if (v == null || !Number.isFinite(v)) return null;
    sum += v;
  }
  return sum / window;
}

function rollingMax(vals: Array<number | null>, end: number, window: number): number | null {
  if (end + 1 < window) return null;
  let m = -Infinity;
  let ok = 0;
  for (let i = end + 1 - window; i <= end; i++) {
    const v = vals[i];
    if (v == null || !Number.isFinite(v)) return null;
    if (v > m) m = v;
    ok += 1;
  }
  return ok < window ? null : m;
}

function rollingMin(vals: Array<number | null>, end: number, window: number): number | null {
  if (end + 1 < window) return null;
  let m = Infinity;
  let ok = 0;
  for (let i = end + 1 - window; i <= end; i++) {
    const v = vals[i];
    if (v == null || !Number.isFinite(v)) return null;
    if (v < m) m = v;
    ok += 1;
  }
  return ok < window ? null : m;
}

export function rangeExtremeSignalSeries(
  highs: number[],
  lows: number[],
  opens: number[],
  closes: number[],
  volumes: number[],
  opts?: {
    hhvLen?: number;
    maLen?: number;
    maVol?: number;
    degreeThreshold?: number;
    lookback?: number;
  },
): number[] {
  const hhvLen = opts?.hhvLen ?? HHV_LEN;
  const maLen = opts?.maLen ?? MA_LEN;
  const maVol = opts?.maVol ?? MA_VOL;
  const degreeThreshold = opts?.degreeThreshold ?? DEGREE_THRESHOLD;
  const lookback = opts?.lookback ?? LOOKBACK;
  const n = Math.min(highs.length, lows.length, opens.length, closes.length, volumes.length);
  const out = new Array<number>(n).fill(0);
  if (n === 0) return out;

  const h: Array<number | null> = highs.slice(0, n).map((x) => (Number.isFinite(x) ? x : null));
  const l: Array<number | null> = lows.slice(0, n).map((x) => (Number.isFinite(x) ? x : null));
  const o: Array<number | null> = opens.slice(0, n).map((x) => (Number.isFinite(x) ? x : null));
  const c: Array<number | null> = closes.slice(0, n).map((x) => (Number.isFinite(x) ? x : null));
  const v: Array<number | null> = volumes.slice(0, n).map((x) => (Number.isFinite(x) ? x : null));

  const lens: Array<number | null> = new Array(n).fill(null);
  const newHigh = new Array<boolean>(n).fill(false);
  const newLow = new Array<boolean>(n).fill(false);
  const newHighEnd = new Array<boolean>(n).fill(false);
  const newLowEnd = new Array<boolean>(n).fill(false);
  const volUp = new Array<boolean>(n).fill(false);
  const volDown = new Array<boolean>(n).fill(false);

  for (let i = 0; i < n; i++) {
    if (h[i] == null || l[i] == null || o[i] == null || c[i] == null) continue;
    lens[i] = Math.abs(h[i]! - l[i]!);
    const hhv = rollingMax(h, i, hhvLen);
    const llv = rollingMin(l, i, hhvLen === LLV_LEN ? hhvLen : LLV_LEN);
    if (hhv != null && h[i] === hhv) newHigh[i] = true;
    if (llv != null && l[i] === llv) newLow[i] = true;

    const maLenV = sma(lens, i, maLen);
    const lenLimit = maLenV != null && lens[i] != null && lens[i]! > maLenV;
    const change = c[i]! - o[i]!;
    const prevNh = i >= 1 ? newHigh[i - 1] : false;
    const prevNl = i >= 1 ? newLow[i - 1] : false;
    if ((newHigh[i] || prevNh) && change < 0 && lenLimit) newHighEnd[i] = true;
    if ((newLow[i] || prevNl) && change > 0 && lenLimit) newLowEnd[i] = true;

    const degree = o[i] && o[i] !== 0 ? ((c[i]! - o[i]!) / o[i]!) * 100 : 0;
    const maVolV = sma(v, i, maVol);
    const volCond = maVolV != null && v[i] != null && v[i]! > maVolV;
    if (volCond && degree >= degreeThreshold) volUp[i] = true;
    if (volCond && degree <= -degreeThreshold) volDown[i] = true;
  }

  for (let i = 0; i < n; i++) {
    const from = Math.max(0, i - lookback);
    let anyNl = false;
    let anyNh = false;
    for (let j = from; j <= i; j++) {
      if (newLowEnd[j]) anyNl = true;
      if (newHighEnd[j]) anyNh = true;
    }
    let noPriorBuy = true;
    let noPriorSell = true;
    for (let j = from; j < i; j++) {
      if (out[j] === 1) noPriorBuy = false;
      if (out[j] === -1) noPriorSell = false;
    }
    if (volUp[i] && anyNl && noPriorBuy) out[i] = 1;
    else if (volDown[i] && anyNh && noPriorSell) out[i] = -1;
    else out[i] = 0;
  }
  return out;
}

export function revVolLabelZh(sig: number): string {
  if (sig === 1) return "新低末端放量买";
  if (sig === -1) return "新高末端放量卖";
  return "";
}

export const REV_VOL_MARKER_KINDS = new Set(["rev_vol_buy", "rev_vol_sell"]);

export const REV_VOL_BUY_COLOR = "#69f0ae";
export const REV_VOL_SELL_COLOR = "#ea80fc";
