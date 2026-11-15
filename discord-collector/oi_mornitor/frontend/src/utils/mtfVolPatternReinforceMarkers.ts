/**
 * 小周期「放量插针」标在本周期 K 上。
 * 「{子}{父}反转」：1h 图打在父 K；15m 图打在子 K（同条件）。父 K 已收盘后 pin，避免被后续刷新冲掉。
 *
 * 例：1h 21:00 射星放量 + 同小时 15m 21:30 放量插针 → 1h 21:00 与 15m 21:30 可各自显示 15m1h反转（图层开）
 */
import type { PatternCandle, PatternChartMarker } from "../types";
import type { ChartTimeframe } from "./chartTimeframe";
import { chartBarDurationMs } from "./chartTimeframe";
import { detectInvertedHammer, detectShootingStar } from "./candleSignals";
import { closedThroughIndex } from "./confluenceChartMarkers";
import { VP_FEATURE_WINDOW, vpFeatureSeries } from "./vpVolumePriceFeatures";

export const VOL_PIN_MARKER_KINDS = new Set(["vol_pin_spike"]);
export const MTF_PARENT_REV_MARKER_KINDS = new Set(["mtf_parent_reversal_bear", "mtf_parent_reversal_bull"]);
export const MTF_REINFORCE_MARKER_KINDS = new Set([
  ...VOL_PIN_MARKER_KINDS,
  ...MTF_PARENT_REV_MARKER_KINDS,
]);

export const VOL_PIN_COLOR = "#ff9800";
export const MTF_PARENT_REV_BEAR_COLOR = "#e91e63";
export const MTF_PARENT_REV_BULL_COLOR = "#00acc1";

/** 「放量插针」：成交量 ≥ 该口径均量（rolling 20）的 1.5 倍 */
export const VOL_PIN_MA_MULT = 1.5;
/** ≥2.5× 均量：标注「放量插针（巨）」 */
export const VOL_PIN_MEGA_MA_MULT = 2.5;
/** 极端放量高潮棒（仍须 ≥1.5×均量）：大实体 + 影 dominance，如 11/13 21:30 */
const VOL_CLIMAX_Z_MIN = 2.2;
const VOL_CLIMAX_MA_MULT = 2.0;
const VOL_CLIMAX_MA_HARD = 3.5;

const VP_IMMEDIATE_CHILD: Partial<Record<ChartTimeframe, ChartTimeframe>> = {
  "15m": "5m",
  "1h": "15m",
  "4h": "1h",
  "1d": "4h",
};

export function childTfForChart(tf: ChartTimeframe): ChartTimeframe | null {
  return VP_IMMEDIATE_CHILD[tf] ?? null;
}

export function vpChildKlineLimit(parentCount: number, parentTf: ChartTimeframe, childTf: ChartTimeframe): number {
  const ratio = chartBarDurationMs(parentTf) / chartBarDurationMs(childTf);
  const est = Math.ceil(parentCount * ratio) + 80;
  return Math.min(1500, Math.max(120, est));
}

/** 子周期 K 线请求：limit 覆盖当前图上父棒时间跨度，endTime 对齐最后一根父棒收盘 */
export function vpChildKlineFetchOpts(
  parentCandles: PatternCandle[],
  parentTf: ChartTimeframe,
  childTf: ChartTimeframe,
): { limit: number; endTimeMs?: number } {
  const parentN = parentCandles.length || 120;
  let limit = vpChildKlineLimit(parentN, parentTf, childTf);
  if (parentCandles.length >= 2) {
    const parentSec = chartBarDurationMs(parentTf) / 1000;
    const spanBars = Math.ceil((parentCandles[parentCandles.length - 1].time - parentCandles[0].time) / parentSec) + 4;
    const spanChild = Math.ceil(spanBars * (parentSec / (chartBarDurationMs(childTf) / 1000))) + 80;
    limit = Math.min(1500, Math.max(limit, spanChild));
  }
  const endTimeMs =
    parentCandles.length > 0
      ? parentCandles[parentCandles.length - 1].time * 1000 + chartBarDurationMs(parentTf)
      : undefined;
  return { limit, endTimeMs };
}

function volPinSpike(vol: number, f: ReturnType<typeof vpFeatureSeries>[number]): boolean {
  if (f.volMa == null || !(f.volMa > 0)) return false;
  return vol >= VOL_PIN_MA_MULT * f.volMa;
}

function volPinMarkerText(vol: number, f: ReturnType<typeof vpFeatureSeries>[number]): string {
  if (f.volMa != null && f.volMa > 0 && vol >= VOL_PIN_MEGA_MA_MULT * f.volMa) {
    return "放量插针（巨）";
  }
  return "放量插针";
}

function volClimax(vol: number, f: ReturnType<typeof vpFeatureSeries>[number]): boolean {
  if (!volPinSpike(vol, f)) return false;
  if (vol >= VOL_CLIMAX_MA_HARD * f.volMa!) return true;
  return (
    f.volZ != null &&
    f.volZ >= VOL_CLIMAX_Z_MIN &&
    vol >= VOL_CLIMAX_MA_MULT * f.volMa!
  );
}

function climaxSideFromBody(c: PatternCandle): "short" | "long" | null {
  const body = c.close - c.open;
  const eps = Math.max(1e-9, Math.abs(c.close) * 1e-8);
  if (body < -eps) return "short";
  if (body > eps) return "long";
  return null;
}

/** 极端放量棒：优先插针形态，否则看上/下影占优（收阳高潮顶仍可判空） */
function volClimaxReversalSide(c: PatternCandle): "short" | "long" | null {
  const pin = pinSide(c);
  if (pin) return pin;
  const range = Math.max(0, c.high - c.low);
  if (range <= 0) return climaxSideFromBody(c);
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  if (upper > lower * 1.08 && upper >= range * 0.22) return "short";
  if (lower > upper * 1.08 && lower >= range * 0.22) return "long";
  return climaxSideFromBody(c);
}

function pinSide(c: PatternCandle): "short" | "long" | null {
  const bar = { open: c.open, high: c.high, low: c.low, close: c.close };
  if (detectShootingStar(bar, false)) return "short";
  if (detectInvertedHammer(bar)) return "long";
  const body = Math.abs(c.close - c.open);
  const range = Math.max(0, c.high - c.low);
  if (range <= 0) return null;
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  if (body <= 0) return null;
  if (upper >= body * 1.05 && upper >= range * 0.32) return "short";
  if (lower >= body * 1.05 && lower >= range * 0.32) return "long";
  return null;
}

function parentReversalSide(c: PatternCandle): "short" | "long" | null {
  return pinSide(c);
}

function childVolPinAt(
  candles: PatternCandle[],
  i: number,
  feats: ReturnType<typeof vpFeatureSeries>,
): "short" | "long" | null {
  const c = candles[i];
  const vol = Number(c.volume ?? 0);
  const pin = pinSide(c);
  if (volPinSpike(vol, feats[i]) && pin) return pin;
  if (volClimax(vol, feats[i])) {
    return volClimaxReversalSide(c);
  }
  return null;
}

function reversalLinkLabel(childTf: ChartTimeframe, parentTf: ChartTimeframe): string {
  return `${childTf}${parentTf}反转`;
}

/** 当前周期：放量 + 插针/射星/倒锤 →「放量插针」 */
export function buildVolPinMarkers(
  candles: PatternCandle[],
  opts?: { barDurationMs?: number; nowMs?: number },
): PatternChartMarker[] {
  const through = closedThroughIndex(candles, opts?.barDurationMs, opts?.nowMs);
  if (through < VP_FEATURE_WINDOW - 1) return [];
  const feats = vpFeatureSeries(candles);
  const markers: PatternChartMarker[] = [];

  for (let i = VP_FEATURE_WINDOW - 1; i <= through; i++) {
    const side = childVolPinAt(candles, i, feats);
    if (!side) continue;
    const c = candles[i];
    const vol = Number(c.volume ?? 0);
    const mega = feats[i].volMa != null && feats[i].volMa! > 0 && vol >= VOL_PIN_MEGA_MA_MULT * feats[i].volMa!;
    markers.push({
      time: c.time,
      position: side === "short" ? "aboveBar" : "belowBar",
      color: VOL_PIN_COLOR,
      shape: "circle",
      text: volPinMarkerText(vol, feats[i]),
      price: side === "short" ? c.high : c.low,
      kind: "vol_pin_spike",
      size: mega ? 0.66 : 0.58,
    });
  }
  return markers;
}

/** 子周期图：`{子}{父}反转` 打在子 K 上（父已收盘 + 同向放量插针共振） */
export function buildMtfChildReversalConfirmMarkers(
  parentCandles: PatternCandle[],
  childCandles: PatternCandle[],
  parentTf: ChartTimeframe,
  childTf: ChartTimeframe,
  opts?: { barDurationMs?: number; nowMs?: number },
): PatternChartMarker[] {
  if (!parentCandles.length || !childCandles.length) return [];

  const parentBarSec = Math.floor(chartBarDurationMs(parentTf) / 1000);
  const parentThrough = closedThroughIndex(parentCandles, chartBarDurationMs(parentTf), opts?.nowMs);
  const childThrough = closedThroughIndex(childCandles, chartBarDurationMs(childTf), opts?.nowMs);
  const parentFeats = vpFeatureSeries(parentCandles);
  const childFeats = vpFeatureSeries(childCandles);
  const markers: PatternChartMarker[] = [];
  const text = reversalLinkLabel(childTf, parentTf);
  const confirmTimes = new Set<number>();

  for (let i = VP_FEATURE_WINDOW - 1; i <= parentThrough; i++) {
    const pc = parentCandles[i];
    const pSide = parentReversalSide(pc);
    if (!pSide) continue;
    const pVol = Number(pc.volume ?? 0);
    if (!volPinSpike(pVol, parentFeats[i])) continue;

    const winStart = pc.time;
    const winEnd = pc.time + parentBarSec;

    let childPin: "short" | "long" | null = null;
    let childIdx = -1;
    for (let j = VP_FEATURE_WINDOW - 1; j <= childThrough; j++) {
      const cc = childCandles[j];
      const t = cc.time;
      if (t < winStart) continue;
      if (t >= winEnd) break;
      const side = childVolPinAt(childCandles, j, childFeats);
      if (side !== pSide) continue;
      childPin = side;
      childIdx = j;
    }
    if (childIdx < 0 || childPin == null) continue;
    if (pSide !== childPin) continue;

    const cc = childCandles[childIdx];
    if (confirmTimes.has(cc.time)) continue;
    confirmTimes.add(cc.time);

    markers.push({
      time: cc.time,
      position: pSide === "short" ? "aboveBar" : "belowBar",
      color: pSide === "short" ? MTF_PARENT_REV_BEAR_COLOR : MTF_PARENT_REV_BULL_COLOR,
      shape: "square",
      text,
      price: pSide === "short" ? cc.high : cc.low,
      kind: pSide === "short" ? "mtf_parent_reversal_bear" : "mtf_parent_reversal_bull",
      size: 0.68,
    });
  }

  return markers;
}

/** 父周期图：已收盘父 K + 同窗子级放量插针 → `{子}{父}反转` 打在父 K 上 */
export function buildMtfParentReversalMarkers(
  parentCandles: PatternCandle[],
  childCandles: PatternCandle[],
  parentTf: ChartTimeframe,
  childTf: ChartTimeframe,
  opts?: { barDurationMs?: number; nowMs?: number },
): PatternChartMarker[] {
  if (!parentCandles.length || !childCandles.length) return [];

  const parentBarSec = Math.floor(chartBarDurationMs(parentTf) / 1000);
  const parentThrough = closedThroughIndex(parentCandles, chartBarDurationMs(parentTf), opts?.nowMs);
  const childThrough = closedThroughIndex(childCandles, chartBarDurationMs(childTf), opts?.nowMs);
  const parentFeats = vpFeatureSeries(parentCandles);
  const childFeats = vpFeatureSeries(childCandles);
  const markers: PatternChartMarker[] = [];
  const text = reversalLinkLabel(childTf, parentTf);

  for (let i = VP_FEATURE_WINDOW - 1; i <= parentThrough; i++) {
    const pc = parentCandles[i];
    const pSide = parentReversalSide(pc);
    if (!pSide) continue;
    const pVol = Number(pc.volume ?? 0);
    if (!volPinSpike(pVol, parentFeats[i])) continue;

    const winStart = pc.time;
    const winEnd = pc.time + parentBarSec;

    let childPin: "short" | "long" | null = null;
    let childIdx = -1;
    for (let j = VP_FEATURE_WINDOW - 1; j <= childThrough; j++) {
      const cc = childCandles[j];
      const t = cc.time;
      if (t < winStart) continue;
      if (t >= winEnd) break;
      const side = childVolPinAt(childCandles, j, childFeats);
      if (side !== pSide) continue;
      childPin = side;
      childIdx = j;
    }
    if (childIdx < 0 || childPin == null) continue;
    if (pSide !== childPin) continue;

    markers.push({
      time: pc.time,
      position: pSide === "short" ? "aboveBar" : "belowBar",
      color: pSide === "short" ? MTF_PARENT_REV_BEAR_COLOR : MTF_PARENT_REV_BULL_COLOR,
      shape: "square",
      text,
      price: pSide === "short" ? pc.high : pc.low,
      kind: pSide === "short" ? "mtf_parent_reversal_bear" : "mtf_parent_reversal_bull",
      size: 0.68,
    });
  }

  return markers;
}

export function mtfReversalPinKey(m: PatternChartMarker): string {
  return `${m.kind ?? ""}:${m.time}:${m.text ?? ""}`;
}

/** 父 K 已收盘后确认的反转标：重算缺失时仍保留（不被 refresh/子 K 失败清空） */
export function mergeMtfReversalMarkersWithPins(
  fresh: PatternChartMarker[],
  pinStore: Map<string, PatternChartMarker>,
  visibleTimes: Set<number>,
): PatternChartMarker[] {
  const out = [...fresh];
  const freshKeys = new Set<string>();

  for (const m of fresh) {
    const kind = m.kind ?? "";
    if (!MTF_PARENT_REV_MARKER_KINDS.has(kind)) continue;
    const key = mtfReversalPinKey(m);
    freshKeys.add(key);
    pinStore.set(key, m);
  }

  for (const [key, m] of pinStore) {
    if (!visibleTimes.has(m.time)) {
      pinStore.delete(key);
      continue;
    }
    if (!freshKeys.has(key)) out.push(m);
  }

  return out;
}