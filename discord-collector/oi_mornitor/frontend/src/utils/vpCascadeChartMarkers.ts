/**
 * 量价炒买/炒卖（大周期）→ 小周期反转进场 — lightweight-charts 标记（预览版，供人工确认后再回测）
 *
 * 原则（不以 TD9 命名）：
 * - 放量棒：只在「该周期自己的 K 线图」上标橙方（小周期图不标父周期放量，避免时间错位）
 * - 父周期炒买/炒卖：逻辑在父 K 上判定；紫/靛「观察」与子级 `1h跌15m入` 只画在当前（小）周期图上
 * - 子周期：放量后的反转进场标记
 */
import type { PatternCandle, PatternChartMarker } from "../types";
import type { ChartTimeframe } from "./chartTimeframe";
import { chartBarDurationMs } from "./chartTimeframe";
import { detectInvertedHammer, detectShootingStar } from "./candleSignals";
import { closedThroughIndex } from "./confluenceChartMarkers";
import { rangeExtremeSignalSeries } from "./rangeExtremeVolume";
import { isTd9Overbought, isTd9Oversold, tdSetupSeries } from "./tdSequential";
import { VP_FEATURE_WINDOW, vpFeatureSeries } from "./vpVolumePriceFeatures";

/** 当前图表周期 → 直接父周期（4h→1h、1h→15m、15m→5m） */
const VP_CASCADE_IMMEDIATE_PARENT: Partial<Record<ChartTimeframe, ChartTimeframe>> = {
  "5m": "15m",
  "15m": "1h",
  "1h": "4h",
};

export function immediateParentTfForChart(tf: ChartTimeframe): ChartTimeframe | null {
  return VP_CASCADE_IMMEDIATE_PARENT[tf] ?? null;
}

/** 父棒触发后，子周期监视窗（子 K 根数） */
export const VP_CASCADE_WATCH_CHILD_BARS: Record<string, number> = {
  "4h|1h": 12,
  "4h|15m": 32,
  "1h|15m": 16,
  "15m|5m": 24,
};

/** 当前 TF 需要拉哪些父 K（15m 同时看 1h 与 4h） */
export function parentTfsForChart(tf: ChartTimeframe): ChartTimeframe[] {
  const out: ChartTimeframe[] = [];
  const imm = VP_CASCADE_IMMEDIATE_PARENT[tf];
  if (imm) out.push(imm);
  if (tf === "15m") out.push("4h");
  return out;
}

export const VP_CHASE_MARKER_KINDS = new Set(["vp_chase_buy", "vp_chase_sell"]);
export const VP_VOL_SPIKE_MARKER_KINDS = new Set(["vp_vol_spike"]);
export const VP_CASCADE_ENTRY_KINDS = new Set(["vp_cascade_short", "vp_cascade_long"]);

export const VP_CHASE_BUY_COLOR = "#ab47bc";
export const VP_CHASE_SELL_COLOR = "#5c6bc0";
export const VP_VOL_SPIKE_COLOR = "#ffb74d";
export const VP_CASCADE_SHORT_COLOR = "#ec407a";
export const VP_CASCADE_LONG_COLOR = "#26a69a";

/** 放量：均量线倍数 + z 同时过线（与图上肉眼放量对齐） */
const VOL_SPIKE_Z_MIN = 1.0;
const VOL_SPIKE_MA_MULT = 1.38;

/** 放量棒之后 0～3 根内可出现炒买/炒卖（0=同棒，仅非插针实体） */
const CHASE_AFTER_SPIKE_MAX = 3;

/** 炒买/炒卖棒：实体推进，拒绝插针形态 */
const CHASE_EFF_MIN = 0.45;
const CHASE_VOL_MA_MULT = 0.85;
const CHASE_MAX_WICK_BODY = 1.15;
const CHASE_PIN_EFF_MAX = 0.38;

/** 子棒反转：量能可不极端（抄顶底后反转常缩量） */
const CHILD_VOL_MA_RELAX = 0.82;

/** 父级收盘后跳过前几根子 K 再允许入场（避免抢第一根毛刺） */
const CHILD_ENTRY_WARMUP_BARS: Record<string, number> = {
  "1h|15m": 4,
  "4h|15m": 8,
  "4h|1h": 2,
  "15m|5m": 2,
};

const REVERSAL_LABEL_RANK: Record<string, number> = {
  射星: 5,
  倒锤: 5,
  新低弱放量: 4,
  新高弱放量: 4,
  TD9: 1,
};

export type VpCascadeWatchWindow = { winStart: number; winEnd: number };

export type VpChaseSide = "buy" | "sell";

export type VpChaseHit = {
  index: number;
  spikeIndex: number;
  side: VpChaseSide;
  /** 炒买/炒卖棒 open（秒） */
  time: number;
  /** 炒买/炒卖棒收盘（秒），观察点打在这里 */
  observeCloseSec: number;
};

function isVolumeSpikeBar(
  vol: number,
  f: ReturnType<typeof vpFeatureSeries>[number],
): boolean {
  if (f.volMa == null || !(f.volMa > 0)) return false;
  if (f.volZ == null || f.volZ < VOL_SPIKE_Z_MIN) return false;
  return vol >= VOL_SPIKE_MA_MULT * f.volMa;
}

/** 插针/十字星：不能当作炒买炒卖观察棒 */
function isPinLikeChaseBar(c: PatternCandle, efficiency: number | null): boolean {
  const bar = { open: c.open, high: c.high, low: c.low, close: c.close };
  if (detectShootingStar(bar, false) || detectInvertedHammer(bar)) return true;
  const body = Math.abs(c.close - c.open);
  const range = Math.max(0, c.high - c.low);
  if (range <= 0) return true;
  const upper = c.high - Math.max(c.open, c.close);
  const lower = Math.min(c.open, c.close) - c.low;
  const domWick = Math.max(upper, lower);
  if (efficiency != null && efficiency <= CHASE_PIN_EFF_MAX) return true;
  if (body <= range * 0.12 && domWick / range > 0.45) return true;
  if (body > 0 && domWick >= body * CHASE_MAX_WICK_BODY) return true;
  return false;
}

function chaseSideOnBar(
  candles: PatternCandle[],
  i: number,
  feats: ReturnType<typeof vpFeatureSeries>,
): VpChaseSide | null {
  const c = candles[i];
  const f = feats[i];
  const vol = Number(c.volume ?? 0);
  if (f.volMa == null || !(f.volMa > 0) || f.efficiency == null) return null;
  if (f.efficiency < CHASE_EFF_MIN) return null;
  if (isPinLikeChaseBar(c, f.efficiency)) return null;
  if (vol < CHASE_VOL_MA_MULT * f.volMa) return null;

  const prevClose = i > 0 ? candles[i - 1].close : c.open;
  const priceUp = c.close > c.open && c.close >= prevClose;
  const priceDown = c.close < c.open && c.close <= prevClose;
  if (f.bodySign === 1 && priceUp) return "buy";
  if (f.bodySign === -1 && priceDown) return "sell";
  return null;
}

/** 所有父周期放量棒（独立打标，不依赖后续是否炒） */
export function detectVolumeSpikeIndices(
  candles: PatternCandle[],
  opts?: { barDurationMs?: number; nowMs?: number },
): number[] {
  const through = closedThroughIndex(candles, opts?.barDurationMs, opts?.nowMs);
  if (through < VP_FEATURE_WINDOW - 1) return [];
  const feats = vpFeatureSeries(candles);
  const out: number[] = [];
  for (let i = VP_FEATURE_WINDOW - 1; i <= through; i++) {
    const vol = Number(candles[i].volume ?? 0);
    if (isVolumeSpikeBar(vol, feats[i])) out.push(i);
  }
  return out;
}

/** 以放量棒为锚，向后最多 3 根找炒买/炒卖 → 观察 */
export function detectVpChaseBars(
  candles: PatternCandle[],
  parentTf: ChartTimeframe,
  opts?: { barDurationMs?: number; nowMs?: number },
): VpChaseHit[] {
  const through = closedThroughIndex(candles, opts?.barDurationMs, opts?.nowMs);
  if (through < VP_FEATURE_WINDOW - 1) return [];
  const feats = vpFeatureSeries(candles);
  const spikeSet = new Set(detectVolumeSpikeIndices(candles, opts));
  if (!spikeSet.size) return [];

  const hits: VpChaseHit[] = [];
  const usedChase = new Set<number>();

  const spikes = [...spikeSet].sort((a, b) => a - b);
  for (const spikeIndex of spikes) {
    for (let gap = 0; gap <= CHASE_AFTER_SPIKE_MAX; gap++) {
      const i = spikeIndex + gap;
      if (i > through) break;
      if (usedChase.has(i)) continue;
      // 放量当根若是插针，只当「量」；观察挪到后续实体棒
      if (gap === 0 && isPinLikeChaseBar(candles[i], feats[i].efficiency)) continue;

      const side = chaseSideOnBar(candles, i, feats);
      if (!side) continue;

      hits.push({
        index: i,
        spikeIndex,
        side,
        time: candles[i].time,
        observeCloseSec: parentCloseSec(candles[i].time, parentTf),
      });
      usedChase.add(i);
      break;
    }
  }
  return hits;
}

function pushVolSpikeMarker(
  markers: PatternChartMarker[],
  candles: PatternCandle[],
  spikeIndex: number,
  tf: ChartTimeframe,
  usedSpikeTimes: Set<number>,
): void {
  const sc = candles[spikeIndex];
  if (usedSpikeTimes.has(sc.time)) return;
  usedSpikeTimes.add(sc.time);
  markers.push({
    time: sc.time,
    position: "aboveBar",
    color: VP_VOL_SPIKE_COLOR,
    shape: "square",
    text: `放量·${tf}`,
    price: sc.high,
    kind: "vp_vol_spike",
    size: 0.45,
  });
}

function childVolOk(candles: PatternCandle[], i: number, feats: ReturnType<typeof vpFeatureSeries>): boolean {
  const vol = Number(candles[i].volume ?? 0);
  const f = feats[i];
  if (f.volMa == null || !(f.volMa > 0)) return true;
  return vol >= CHILD_VOL_MA_RELAX * f.volMa;
}

type ChildReversalHit = { label: string; side: "short" | "long" };

/** 入场文案：父周期炒买/炒卖 → 子周期进场（涨=追涨后空，跌=杀跌后多） */
export function formatVpEntryLabel(
  parentTf: ChartTimeframe,
  childTf: ChartTimeframe,
  chaseSide: VpChaseSide,
  trigger?: string,
): string {
  const leg = chaseSide === "sell" ? "跌" : "涨";
  const base = `${parentTf}${leg}${childTf}入`;
  return trigger ? `${base}·${trigger}` : base;
}

function childReversalAt(
  candles: PatternCandle[],
  i: number,
  feats: ReturnType<typeof vpFeatureSeries>,
  chaseSide: VpChaseSide,
): ChildReversalHit | null {
  if (!childVolOk(candles, i, feats)) return null;
  const c = candles[i];
  const bar = { open: c.open, high: c.high, low: c.low, close: c.close };

  const closes = candles.map((x) => x.close);
  const tdSeries = tdSetupSeries(closes);
  const td = tdSeries[i];

  const volumes = candles.map((x) => x.volume ?? 0);
  const revSeries = rangeExtremeSignalSeries(
    candles.map((x) => x.high),
    candles.map((x) => x.low),
    candles.map((x) => x.open),
    closes,
    volumes,
  );
  const rev = revSeries[i];

  // 追涨后找空：射星 / TD超买 / 新高弱放量卖
  if (chaseSide === "buy") {
    if (detectShootingStar(bar, false)) return { label: "射星", side: "short" };
    if (isTd9Overbought(td)) return { label: "TD9", side: "short" };
    if (rev === -1) return { label: "新高弱放量", side: "short" };
    return null;
  }

  // 杀跌后找多：倒锤 / TD超卖 / 新低弱放量买
  if (chaseSide === "sell") {
    if (detectInvertedHammer(bar)) return { label: "倒锤", side: "long" };
    if (isTd9Oversold(td)) return { label: "TD9", side: "long" };
    if (rev === 1) return { label: "新低弱放量", side: "long" };
    return null;
  }
  return null;
}

function childEntryWarmupBars(parentTf: ChartTimeframe, childTf: ChartTimeframe): number {
  return CHILD_ENTRY_WARMUP_BARS[`${parentTf}|${childTf}`] ?? 2;
}

function warmupStartSec(
  winStart: number,
  childCandles: PatternCandle[],
  childPtr: number,
  warmupBars: number,
): number {
  let idx = childPtr;
  let skipped = 0;
  while (idx < childCandles.length && skipped < warmupBars) {
    if (childCandles[idx].time >= winStart) skipped += 1;
    idx += 1;
  }
  if (idx < childCandles.length) return childCandles[idx].time;
  return winStart + 1;
}

type ScoredChildReversal = ChildReversalHit & { index: number; time: number };

/** 监视窗内取得分最高的反转棒（形态优先，同分取更晚一根） */
function pickBestChildReversal(
  childCandles: PatternCandle[],
  childFeats: ReturnType<typeof vpFeatureSeries>,
  chaseSide: VpChaseSide,
  entryStartSec: number,
  winEnd: number,
  childThrough: number,
  childPtr: number,
): ScoredChildReversal | null {
  let best: ScoredChildReversal | null = null;
  for (let j = childPtr; j <= childThrough; j++) {
    const t = childCandles[j].time;
    if (t < entryStartSec) continue;
    if (t > winEnd) break;
    const hit = childReversalAt(childCandles, j, childFeats, chaseSide);
    if (!hit) continue;
    const rank = REVERSAL_LABEL_RANK[hit.label] ?? 0;
    if (
      !best ||
      rank > (REVERSAL_LABEL_RANK[best.label] ?? 0) ||
      (rank === (REVERSAL_LABEL_RANK[best.label] ?? 0) && t > best.time)
    ) {
      best = { ...hit, index: j, time: t };
    }
  }
  return best;
}

/** 供 15m 上图：1h 级联占用的时间窗，用来压制 4h 误抢入场 */
export function collectVpChaseWatchWindows(
  parentCandles: PatternCandle[],
  parentTf: ChartTimeframe,
  childTf: ChartTimeframe,
  opts?: { barDurationMs?: number; nowMs?: number },
): VpCascadeWatchWindow[] {
  const parentBarMs = chartBarDurationMs(parentTf);
  const childBarMs = chartBarDurationMs(childTf);
  const watchBars = watchChildBars(parentTf, childTf);
  const watchSec = Math.floor((watchBars * childBarMs) / 1000);
  const parentOpts = { barDurationMs: parentBarMs, nowMs: opts?.nowMs };
  const chases = detectVpChaseBars(parentCandles, parentTf, parentOpts);
  return chases.map((c) => ({
    winStart: c.observeCloseSec,
    winEnd: c.observeCloseSec + watchSec,
  }));
}

function entryOverlapsWindows(entryOpenSec: number, windows: VpCascadeWatchWindow[]): boolean {
  for (const w of windows) {
    if (entryOpenSec >= w.winStart && entryOpenSec <= w.winEnd) return true;
  }
  return false;
}

function watchChildBars(parentTf: ChartTimeframe, childTf: ChartTimeframe): number {
  const key = `${parentTf}|${childTf}`;
  return VP_CASCADE_WATCH_CHILD_BARS[key] ?? 12;
}

function parentCloseSec(parentOpenSec: number, parentTf: ChartTimeframe): number {
  return parentOpenSec + Math.floor(chartBarDurationMs(parentTf) / 1000);
}

/**
 * 在当前（子）周期 K 线上画：父级放量后的观察窗 + 小级别反转进场。
 * 不在此函数里画父周期「放量」——父放量仅在父周期自己的图表层显示。
 */
export function buildVpCascadeMarkers(
  childCandles: PatternCandle[],
  parentCandles: PatternCandle[],
  childTf: ChartTimeframe,
  parentTf: ChartTimeframe,
  opts?: {
    barDurationMs?: number;
    nowMs?: number;
    /** 高优先级父级（如 1h）已占用的子图时间窗；4h 不在此窗内抢标 */
    suppressEntryInWindows?: VpCascadeWatchWindow[];
  },
): PatternChartMarker[] {
  if (!childCandles.length || !parentCandles.length) return [];

  const parentBarMs = chartBarDurationMs(parentTf);
  const childBarMs = chartBarDurationMs(childTf);
  const watchBars = watchChildBars(parentTf, childTf);
  const watchSec = Math.floor((watchBars * childBarMs) / 1000);

  const parentOpts = { barDurationMs: parentBarMs, nowMs: opts?.nowMs };
  const chases = detectVpChaseBars(parentCandles, parentTf, parentOpts);

  const childThrough = closedThroughIndex(childCandles, opts?.barDurationMs, opts?.nowMs);
  const childFeats = vpFeatureSeries(childCandles);
  const markers: PatternChartMarker[] = [];

  if (!chases.length) return markers;

  let childPtr = 0;
  for (const chase of chases) {

    const winStart = chase.observeCloseSec;
    const winEnd = winStart + watchSec;

    while (childPtr < childCandles.length && childCandles[childPtr].time < winStart) childPtr += 1;

    let obsIdx = childPtr;
    while (obsIdx < childCandles.length && childCandles[obsIdx].time < winStart) obsIdx += 1;
    if (obsIdx <= childThrough && childCandles[obsIdx].time <= winEnd) {
      const cObs = childCandles[obsIdx];
      if (chase.side === "buy") {
        markers.push({
          time: cObs.time,
          position: "aboveBar",
          color: VP_CHASE_BUY_COLOR,
          shape: "circle",
          text: `${parentTf}放量后·${childTf}观察`,
          price: cObs.high,
          kind: "vp_chase_buy",
          size: 0.85,
        });
      } else {
        markers.push({
          time: cObs.time,
          position: "belowBar",
          color: VP_CHASE_SELL_COLOR,
          shape: "circle",
          text: `${parentTf}放量后·${childTf}观察`,
          price: cObs.low,
          kind: "vp_chase_sell",
          size: 0.85,
        });
      }
    }

    const warmup = childEntryWarmupBars(parentTf, childTf);
    const entryStartSec = warmupStartSec(winStart, childCandles, childPtr, warmup);
    const picked = pickBestChildReversal(
      childCandles,
      childFeats,
      chase.side,
      entryStartSec,
      winEnd,
      childThrough,
      childPtr,
    );
    if (!picked) continue;
    if (opts?.suppressEntryInWindows?.length && entryOverlapsWindows(picked.time, opts.suppressEntryInWindows)) {
      continue;
    }
    const c = childCandles[picked.index];
    const entryText = formatVpEntryLabel(parentTf, childTf, chase.side, picked.label);
    if (picked.side === "short") {
      markers.push({
        time: c.time,
        position: "aboveBar",
        color: VP_CASCADE_SHORT_COLOR,
        shape: "arrowDown",
        text: entryText,
        price: c.high,
        kind: "vp_cascade_short",
        size: 0.55,
      });
    } else {
      markers.push({
        time: c.time,
        position: "belowBar",
        color: VP_CASCADE_LONG_COLOR,
        shape: "arrowUp",
        text: entryText,
        price: c.low,
        kind: "vp_cascade_long",
        size: 0.55,
      });
    }
  }

  return markers;
}

/**
 * 无更小级联父级时（如 4h 主图）：在同一周期上标放量 + 放量后观察。
 */
export function buildVpChaseOnlyMarkers(
  candles: PatternCandle[],
  tf: ChartTimeframe,
  opts?: { barDurationMs?: number; nowMs?: number },
): PatternChartMarker[] {
  const spikeIndices = detectVolumeSpikeIndices(candles, opts);
  const chases = detectVpChaseBars(candles, tf, opts);
  const markers: PatternChartMarker[] = [];
  const usedSpikeTimes = new Set<number>();
  for (const si of spikeIndices) {
    pushVolSpikeMarker(markers, candles, si, tf, usedSpikeTimes);
  }
  for (const chase of chases) {
    const c = candles[chase.index];
    if (chase.side === "buy") {
      markers.push({
        time: c.time,
        position: "aboveBar",
        color: VP_CHASE_BUY_COLOR,
        shape: "circle",
        text: `追涨观察·${tf}·放量后`,
        price: c.high,
        kind: "vp_chase_buy",
        size: 0.85,
      });
    } else {
      markers.push({
        time: c.time,
        position: "belowBar",
        color: VP_CHASE_SELL_COLOR,
        shape: "circle",
        text: `杀跌观察·${tf}·放量后`,
        price: c.low,
        kind: "vp_chase_sell",
        size: 0.85,
      });
    }
  }
  return markers;
}

/** @deprecated 用 parentTfsForChart；仅兼容「是否有父级」判断 */
export function parentTfForChart(tf: ChartTimeframe): ChartTimeframe | null {
  const list = parentTfsForChart(tf);
  return list[0] ?? null;
}

/** 子图加载父 K 时 limit 粗算 */
export function vpParentKlineLimit(childCount: number, childTf: ChartTimeframe, parentTf: ChartTimeframe): number {
  const ratio = chartBarDurationMs(childTf) / chartBarDurationMs(parentTf);
  const est = Math.ceil(childCount * ratio) + 40;
  return Math.min(1500, Math.max(120, est));
}