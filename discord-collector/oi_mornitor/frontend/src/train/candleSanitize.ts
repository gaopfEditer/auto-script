import type { Candle } from "./types";

const LOG_THRESHOLD = 350;

function isFinitePos(n: number): boolean {
  return Number.isFinite(n) && n > 0;
}

/** 单根 OHLC 校验；非法返回 null */
export function sanitizeTrainCandle(raw: Candle, ctx = "candle"): Candle | null {
  const o = Number(raw.o);
  const h = Number(raw.h);
  const l = Number(raw.l);
  const c = Number(raw.c);
  const t = Number(raw.t);
  const v = Number(raw.v ?? 0);

  if (!Number.isFinite(t) || t <= 0) {
    console.warn(`[train-candles] 丢弃 ${ctx}: 非法 time`, raw);
    return null;
  }
  if (![o, h, l, c].every(isFinitePos)) {
    console.warn(`[train-candles] 丢弃 ${ctx}: OHLC 含 0/NaN`, { t, o, h, l, c });
    return null;
  }
  let hi = Math.max(o, h, c);
  let lo = Math.min(o, l, c);
  if (hi < lo) {
    console.warn(`[train-candles] 修复 ${ctx}: high < low`, { t, o, h, l, c });
    hi = Math.max(o, h, l, c);
    lo = Math.min(o, h, l, c);
  }
  const close = Math.min(hi, Math.max(lo, c));
  return { t, o, h: hi, l: lo, c: close, v: Number.isFinite(v) ? v : 0 };
}

function median(nums: number[]): number {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m]! : (s[m - 1]! + s[m]!) / 2;
}

/** 相对前后窗口中位价偏离过大的尖刺 */
function dropOutlierSpikes(candles: Candle[], ctx: string): Candle[] {
  if (candles.length < 5) return candles;
  const out: Candle[] = [];
  for (let i = 0; i < candles.length; i++) {
    const c = candles[i]!;
    const window = candles
      .slice(Math.max(0, i - 4), i)
      .concat(candles.slice(i + 1, i + 5))
      .map((x) => x.c);
    const med = median(window);
    if (med > 0 && (c.h > med * 12 || c.l < med / 12)) {
      console.warn(`[train-candles] 丢弃 ${ctx} 尖刺 bar`, { t: c.t, ohlc: c, med });
      continue;
    }
    out.push(c);
  }
  return out;
}

export function dedupeSortTrainCandles(candles: Candle[], ctx = "series"): Candle[] {
  const m = new Map<number, Candle>();
  for (const raw of candles) {
    const c = sanitizeTrainCandle(raw, ctx);
    if (c) m.set(c.t, c);
  }
  return [...m.values()].sort((a, b) => a.t - b.t);
}

export function trimAfterLargeTimeGap(candles: Candle[], barSec: number, ctx = "series"): Candle[] {
  if (candles.length <= 1 || barSec <= 0) return candles;
  const maxGap = barSec * 3;
  const out: Candle[] = [candles[0]!];
  for (let i = 1; i < candles.length; i++) {
    const c = candles[i]!;
    const prev = out[out.length - 1]!;
    const gap = c.t - prev.t;
    if (gap > maxGap) {
      console.warn(
        `[train-candles] ${ctx}: 截断时间空洞 ${prev.t} → ${c.t}（丢弃后续 ${candles.length - i} 根）`,
      );
      break;
    }
    if (gap <= 0) continue;
    out.push(c);
  }
  return out;
}

export function prepareTrainCandlesForChart(
  candles: Candle[],
  sliceEnd: number,
  barSec = 900,
): Candle[] {
  const sliced = candles.slice(0, Math.max(0, sliceEnd));
  let out = dedupeSortTrainCandles(sliced, "chart-visible");
  out = trimAfterLargeTimeGap(out, barSec, "chart-visible");
  out = dropOutlierSpikes(out, "chart-visible");
  if (out.length >= LOG_THRESHOLD || sliced.length >= LOG_THRESHOLD) {
    logCandleSeriesHealth(out, "chart-visible");
  }
  return out;
}

export function logCandleSeriesHealth(candles: Candle[], label: string): void {
  if (!candles.length) return;
  const head = candles.slice(0, 5);
  const tail = candles.slice(-5);
  let minL = Infinity;
  let maxH = -Infinity;
  let minBar: Candle | undefined;
  let maxBar: Candle | undefined;
  for (const c of candles) {
    if (c.l < minL) {
      minL = c.l;
      minBar = c;
    }
    if (c.h > maxH) {
      maxH = c.h;
      maxBar = c;
    }
  }
  console.warn(`[train-candles] ${label} n=${candles.length}`, {
    first5: head.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c })),
    last5: tail.map((c) => ({ t: c.t, o: c.o, h: c.h, l: c.l, c: c.c })),
    globalMinLow: minBar,
    globalMaxHigh: maxBar,
  });
}

export function assertVisiblePriceWindow(bars: Candle[]): void {
  if (bars.length < 2) return;
  let minL = Infinity;
  let maxH = -Infinity;
  let minBar: Candle | undefined;
  let maxBar: Candle | undefined;
  for (const c of bars) {
    if (!isFinitePos(c.l) || !isFinitePos(c.h)) continue;
    if (c.l < minL) {
      minL = c.l;
      minBar = c;
    }
    if (c.h > maxH) {
      maxH = c.h;
      maxBar = c;
    }
  }
  if (!Number.isFinite(minL) || !Number.isFinite(maxH) || minL <= 0) return;
  const ratio = maxH / minL;
  if (ratio > 20) {
    console.warn("[train-chart] 可见窗口 OHLC 极差 > 20×", {
      ratio,
      minBar: minBar && { t: minBar.t, o: minBar.o, h: minBar.h, l: minBar.l, c: minBar.c },
      maxBar: maxBar && { t: maxBar.t, o: maxBar.o, h: maxBar.h, l: maxBar.l, c: maxBar.c },
    });
  }
}

export function sanitizeTrainCandleList(candles: Candle[], ctx = "ingest"): Candle[] {
  let out = dedupeSortTrainCandles(candles, ctx);
  out = dropOutlierSpikes(out, ctx);
  return out;
}
