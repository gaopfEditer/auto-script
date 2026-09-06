import { memo, useCallback, useEffect, useRef, useState } from "react";
import {
  ColorType,
  CrosshairMode,
  createChart,
  type CandlestickData,
  type HistogramData,
  type IChartApi,
  type IPriceLine,
  type ISeriesApi,
  type LineData,
  type LogicalRange,
  type SeriesMarker,
  type UTCTimestamp,
} from "lightweight-charts";
import type { PatternCandle, PatternChartData, PatternState } from "../types";
import {
  chartOscillatorFormat,
  chartPriceFormat,
  chartPriceFormatFromPrices,
  formatChartAxisPrice,
  fmtMetaPrice,
  fmtNum,
  fmtPct,
} from "../utils/format";
import { displaySymbol } from "../utils/symbol";
import { CoinAvatar } from "./CoinAvatar";
import type { TickerRow } from "../types";
import { useBinanceChartLive } from "../hooks/useBinanceChartLive";
import type { LiveKlineUpdate } from "../utils/binanceWs";
import {
  CHART_DEFAULT_LIMIT,
  CHART_LOAD_CHUNK,
  CHART_REFRESH_TAIL,
  CHART_TIMEFRAMES,
  CHART_VISIBLE_BARS,
  coerceChartTimeframe,
  type ChartTimeframe,
  fetchPatternChart,
  mergeBbSeries,
  mergeCandlesByTime,
  mergeMacdMap,
  mergeVegasMap,
  oldestCandleOpenMs,
  resolveChartHasMore,
  type VegasKey,
} from "../utils/chartTimeframe";
import { chartLocalization, chartTimeScaleOptions, formatCandleLocalTime } from "../utils/chartLocale";
import { buildChartFromCandles } from "../utils/chartIndicators";
import {
  DERIV_OI_LINE_COLOR,
  fetchChartDerivSubplots,
} from "../utils/chartDerivSubplots";

/** 仅当左缘已贴到数据起点附近（几乎要露空白）才预取；真正空白是 from < 0 */
const LEFT_HISTORY_PAD = 5;
/** 当前选中币种：定时重拉近期 K 线（毫秒） */
const CHART_KLINE_REFRESH_MS = 60_000;
/** 自动向左续载的上限 */
const CHART_HISTORY_MAX = 5000;

/**
 * 向右拖动露出左侧空白（from < 0），或几乎贴到最早一根时，才续载。
 * 不因「缩到看全图 / 距左缘还很远」自动连拉多页。
 */
function needsLeftHistory(range: LogicalRange, len: number): boolean {
  if (len <= 0 || len >= CHART_HISTORY_MAX) return false;
  return range.from < 0 || range.from < LEFT_HISTORY_PAD;
}

function restoreLogicalRange(
  chart: IChartApi,
  range: LogicalRange,
  suppressRef?: { current: number },
) {
  // setData 后同步改 range 常被 LWC 内部布局冲掉，下一帧再设一次
  if (suppressRef) suppressRef.current += 1;
  const apply = () => {
    try {
      chart.timeScale().setVisibleLogicalRange(range);
    } catch {
      /* chart disposed */
    }
  };
  apply();
  requestAnimationFrame(() => {
    apply();
    requestAnimationFrame(() => {
      apply();
      if (suppressRef) {
        // 等 LWC 抛完程序性 range 事件再允许续载
        requestAnimationFrame(() => {
          suppressRef.current = Math.max(0, suppressRef.current - 1);
        });
      }
    });
  });
}

interface Props {
  symbol: string;
  state?: PatternState;
  liveTicker?: TickerRow;
  onClose: () => void;
  /** 信号 chip / 列表打开时带上的周期（如 1h、15m） */
  preferredTimeframe?: string | null;
  /** 每次从信号打开递增，确保重复点击同一周期也会切回 */
  preferredTimeframeNonce?: number;
  /** 右键标题：打开与左侧列表相同的操作菜单 */
  onTitleContextMenu?: (e: React.MouseEvent, symbol: string) => void;
  /** 当前币是否已在形态监听列表 */
  inWatchlist?: boolean;
  /** 加入形态监听 */
  onAddToWatchlist?: (symbol: string) => void;
  addWatchBusy?: boolean;
}

type ChartLayers = {
  bb: boolean;
  volume: boolean;
  macd: boolean;
  candlePattern: boolean;
  structure: boolean;
  /** 下方持仓量 / 净买入副图（默认关） */
  oi: boolean;
};

const DEFAULT_LAYERS: ChartLayers = {
  bb: true,
  volume: true,
  macd: true,
  candlePattern: true,
  structure: true,
  oi: false,
};

const LAYER_TOGGLES: { key: keyof ChartLayers; label: string }[] = [
  { key: "bb", label: "布林" },
  { key: "volume", label: "量能" },
  { key: "macd", label: "MACD" },
  { key: "candlePattern", label: "K线形态" },
  { key: "structure", label: "形态线" },
  { key: "oi", label: "持仓量" },
];

/** H_max / LH / L₁ / HL / 扳机 等水平价线 */
const STRUCTURE_LINE_KINDS = new Set(["h_max", "lh", "l1", "hl", "trigger"]);
const LIQ_LINE_KINDS = new Set(["liq_short", "liq_long"]);
const SANDBOX_MARKER_PREFIX = "sandbox_";
/** 形态结构箭头标记（与价线对应） */
const STRUCTURE_MARKER_KINDS = new Set([
  "h_max",
  "lh",
  "l1",
  "hl",
  "mid_peak",
  "trigger",
  "hh",
  "bb_wick",
]);

const MARKER_LEGEND = [
  { kind: "h_max", label: "① H_max 绝对高点", color: "#ff5252" },
  { kind: "lh", label: "② LH 次高点", color: "#ffc107" },
  { kind: "l1", label: "L₁ 洗盘低点", color: "#ff8a80" },
  { kind: "hl", label: "③ HL 更高低点", color: "#00e676" },
  { kind: "mid_peak", label: "夹角反弹高点", color: "#64b5f6" },
  { kind: "trigger", label: "扳机线", color: "#64b5f6" },
  { kind: "hh", label: "④ HH 更高高点", color: "#00e676" },
  { kind: "bb_wick", label: "BB-Wicks 插针", color: "#e040fb" },
  { kind: "shooting_star", label: "射击之星 / V+oi异动", color: "#ff4081" },
  { kind: "inverted_hammer", label: "倒锤子", color: "#00bcd4" },
  { kind: "continuous_upper_wick", label: "连续上插针", color: "#9c27b0" },
  { kind: "continuous_lower_wick", label: "连续下插针", color: "#9c27b0" },
  { kind: "oi_anomaly", label: "OI异动（无形态）", color: "#ff9800" },
];

const VEGAS_SERIES: { key: VegasKey; title: string; color: string }[] = [
  { key: "filter", title: "过滤线 EMA12", color: "rgba(0, 230, 118, 0.85)" },
  { key: "a1", title: "A组1 EMA144", color: "rgba(33, 150, 243, 0.75)" },
  { key: "a2", title: "A组2 EMA169", color: "rgba(33, 150, 243, 0.45)" },
  { key: "b1", title: "B组1 EMA576", color: "rgba(239, 83, 80, 0.75)" },
  { key: "b2", title: "B组2 EMA676", color: "rgba(239, 83, 80, 0.45)" },
];

/** K 线形态信号：半尺寸箭头；字号随图表 layout.fontSize（整体 60%） */
const COMPACT_MARKER_KINDS = new Set([
  "shooting_star",
  "inverted_hammer",
  "continuous_upper_wick",
  "continuous_lower_wick",
  "continuous_non_upper_wick",
  "continuous_non_lower_wick",
  "oi_anomaly",
]);
const COMPACT_MARKER_SIZE = 0.5;
/** 图表全局字号 = LWC 默认 12 × 60% */
const CHART_FONT_SIZE = Math.round(12 * 0.6);

/**
 * 将标记时间对齐到已加载 K 线 open_time。
 * LWC 对「不在 series 内」的 time 会吸附到端点，缩小时左侧会堆一排入/出标记。
 */
function alignMarkerTime(
  rawTime: number,
  candleTimeSet: Set<number>,
  candleTimes: number[],
): number | null {
  if (!candleTimes.length) return null;
  let t = Number(rawTime);
  if (!Number.isFinite(t) || t <= 0) return null;
  // 兼容毫秒时间戳
  if (t > 1e12) t = Math.floor(t / 1000);
  if (candleTimeSet.has(t)) return t;

  const first = candleTimes[0];
  const last = candleTimes[candleTimes.length - 1];
  if (t < first || t > last) return null;

  // 落在两根 K 线之间：对齐到不大于 t 的最近 open
  let lo = 0;
  let hi = candleTimes.length - 1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (candleTimes[mid] <= t) lo = mid + 1;
    else hi = mid - 1;
  }
  if (hi < 0) return null;
  return candleTimes[hi];
}

function extractSandboxMarkers(
  ...lists: Array<PatternChartData["markers"] | undefined>
): PatternChartData["markers"] {
  const out: NonNullable<PatternChartData["markers"]> = [];
  const seen = new Set<string>();
  for (const list of lists) {
    for (const m of list ?? []) {
      const kind = String(m.kind || "");
      if (!kind.startsWith(SANDBOX_MARKER_PREFIX)) continue;
      const key = `${m.time}:${kind}:${m.text || ""}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(m);
    }
  }
  return out;
}

/**
 * 用当前已加载的全部 K 线重算形态/结构标记（避免 refresh 只带尾部 80 根把历史标记冲掉）。
 */
function rebuildChartMarkers(
  candles: PatternCandle[],
  state: PatternState | undefined,
  sandbox: PatternChartData["markers"] | undefined,
): PatternChartData["markers"] {
  const built = buildChartFromCandles(
    candles,
    state as unknown as Record<string, unknown> | undefined,
    {},
  );
  return [...built.markers, ...(sandbox ?? [])];
}

function toCandleMarkers(
  markers: PatternChartData["markers"],
  showCandlePattern: boolean,
  showStructure: boolean,
  candles?: PatternCandle[],
): SeriesMarker<UTCTimestamp>[] {
  const candleTimes = (candles ?? []).map((c) => c.time).sort((a, b) => a - b);
  const candleTimeSet = new Set(candleTimes);

  return [...(markers ?? [])]
    .filter((m) => {
      const kind = m.kind ?? "";
      if (!showCandlePattern && COMPACT_MARKER_KINDS.has(kind)) return false;
      if (!showStructure && STRUCTURE_MARKER_KINDS.has(kind)) return false;
      return true;
    })
    .map((m) => {
      const aligned = alignMarkerTime(m.time, candleTimeSet, candleTimes);
      if (aligned == null) return null;
      const kind = m.kind ?? "";
      const compact = COMPACT_MARKER_KINDS.has(kind);
      return {
        time: aligned as UTCTimestamp,
        position: m.position,
        color: m.color,
        shape: m.shape,
        text: m.text || undefined,
        size: compact ? COMPACT_MARKER_SIZE : 1,
      } as SeriesMarker<UTCTimestamp>;
    })
    .filter((m): m is SeriesMarker<UTCTimestamp> => m != null)
    .sort((a, b) => (a.time as number) - (b.time as number));
}

function toCandleData(candles: PatternCandle[]): CandlestickData[] {
  return candles.map((c) => ({
    time: c.time as UTCTimestamp,
    open: c.open,
    high: c.high,
    low: c.low,
    close: c.close,
  }));
}

function toVolumeData(candles: PatternCandle[]): HistogramData[] {
  return candles.map((c) => ({
    time: c.time as UTCTimestamp,
    value: c.volume ?? 0,
    // 半透明，叠在 K 线下沿时仍能看清影线/实体
    color: c.close >= c.open ? "rgba(0, 230, 118, 0.28)" : "rgba(255, 82, 82, 0.28)",
  }));
}

/** 量能柱从 0 起算，按当前可见区内最大量撑满分配高度 */
function volumeAutoscaleInfoProvider(
  original: () => { priceRange: { minValue: number; maxValue: number } | null } | null,
) {
  const res = original();
  if (!res?.priceRange) return res;
  const max = Math.max(res.priceRange.maxValue, 0);
  return {
    priceRange: {
      minValue: 0,
      // 略放大上限，避免最高柱贴顶；可视区内最高柱约占分配高度 ~85%
      maxValue: max <= 0 ? 1 : max / 0.85,
    },
  };
}

/** MACD 金叉/死叉小圆点（画在 DIF 线上） */
function buildMacdCrossMarkers(
  line: { time: number; value: number }[],
  signal: { time: number; value: number }[],
): SeriesMarker<UTCTimestamp>[] {
  const sigByTime = new Map(signal.map((p) => [p.time, p.value]));
  const markers: SeriesMarker<UTCTimestamp>[] = [];
  let prevDiff: number | null = null;

  for (const p of line) {
    const sig = sigByTime.get(p.time);
    if (sig == null || !Number.isFinite(p.value) || !Number.isFinite(sig)) {
      prevDiff = null;
      continue;
    }
    const diff = p.value - sig;
    if (prevDiff != null) {
      if (prevDiff <= 0 && diff > 0) {
        markers.push({
          time: p.time as UTCTimestamp,
          position: "inBar",
          shape: "circle",
          color: "#00e676",
          size: 0.6,
          text: undefined,
        });
      } else if (prevDiff >= 0 && diff < 0) {
        markers.push({
          time: p.time as UTCTimestamp,
          position: "inBar",
          shape: "circle",
          color: "#ff5252",
          size: 0.6,
          text: undefined,
        });
      }
    }
    prevDiff = diff;
  }
  return markers;
}

/** MACD 对称扩展，可见区内柱线充分利用分区高度 */
function macdAutoscaleInfoProvider(
  original: () => { priceRange: { minValue: number; maxValue: number } | null } | null,
) {
  const res = original();
  if (!res?.priceRange) return res;
  const { minValue, maxValue } = res.priceRange;
  const amp = Math.max(Math.abs(minValue), Math.abs(maxValue), 1e-12);
  return {
    priceRange: {
      minValue: -amp / 0.85,
      maxValue: amp / 0.85,
    },
  };
}

/**
 * 量能与 K 线共用主图区（同 bottom），叠在 K 线底部，不另开独立带。
 * 仅 MACD 在整图最底独占一条。
 */
function applyPaneMargins(chart: IChartApi, layers: ChartLayers) {
  const { volume, macd } = layers;
  const MACD_H = 0.24;
  const VOL_IN_MAIN = 0.28;

  const mainBottom = macd ? MACD_H : 0.04;
  const mainTop = 0.03;
  const mainSpan = 1 - mainTop - mainBottom;
  const volTop = mainTop + mainSpan * (1 - (volume ? VOL_IN_MAIN : 0));

  chart.priceScale("right").applyOptions({
    scaleMargins: { top: mainTop, bottom: mainBottom },
  });

  if (volume) {
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: volTop, bottom: mainBottom },
      borderVisible: false,
    });
  } else {
    chart.priceScale("volume").applyOptions({
      scaleMargins: { top: 0.95, bottom: 0 },
      borderVisible: false,
    });
  }

  if (macd) {
    chart.priceScale("macd").applyOptions({
      scaleMargins: { top: 1 - MACD_H + 0.02, bottom: 0.02 },
      borderVisible: false,
    });
  } else {
    chart.priceScale("macd").applyOptions({
      scaleMargins: { top: 0.95, bottom: 0 },
      borderVisible: false,
    });
  }
}

export const PatternChartPanel = memo(function PatternChartPanel({
  symbol,
  state,
  liveTicker,
  onClose: _onClose,
  preferredTimeframe = null,
  preferredTimeframeNonce = 0,
  onTitleContextMenu,
  inWatchlist = false,
  onAddToWatchlist,
  addWatchBusy = false,
}: Props) {
  void _onClose;
  const chartRef = useRef<HTMLDivElement>(null);
  const chartWrapRef = useRef<HTMLDivElement>(null);
  const crosshairPriceRef = useRef<HTMLDivElement>(null);
  const oiChartElRef = useRef<HTMLDivElement>(null);
  const spotNetElRef = useRef<HTMLDivElement>(null);
  const futNetElRef = useRef<HTMLDivElement>(null);
  const oiChartApi = useRef<IChartApi | null>(null);
  const spotNetChartApi = useRef<IChartApi | null>(null);
  const futNetChartApi = useRef<IChartApi | null>(null);
  const oiSeriesRef = useRef<ISeriesApi<"Line"> | null>(null);
  const spotNetSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const futNetSeriesRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const derivSyncingRef = useRef(false);
  /** 防止 setCrosshairPosition 触发的 move 事件回环 */
  const crosshairSyncingRef = useRef(false);
  /** 副图按 time(秒) 取价，供十字线水平定位 */
  const oiValueByTimeRef = useRef(new Map<number, number>());
  const spotNetByTimeRef = useRef(new Map<number, number>());
  const futNetByTimeRef = useRef(new Map<number, number>());
  const chartApi = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const upperRef = useRef<ISeriesApi<"Line"> | null>(null);
  const midRef = useRef<ISeriesApi<"Line"> | null>(null);
  const lowerRef = useRef<ISeriesApi<"Line"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const macdHistRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const macdLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdSignalRef = useRef<ISeriesApi<"Line"> | null>(null);
  const vegasRefs = useRef<Partial<Record<VegasKey, ISeriesApi<"Line">>>>({});
  const priceLinesRef = useRef<IPriceLine[]>([]);

  const candlesRef = useRef<PatternCandle[]>([]);
  const hasMoreRef = useRef(true);
  const loadingMoreRef = useRef(false);
  /** >0 时忽略 range 续载（程序性 setVisibleLogicalRange / 初次定位） */
  const suppressHistoryLoadRef = useRef(0);
  /** 左侧续载已直接 setData 到图表；跳过随后 data effect，避免用短数据冲掉历史 */
  const skipNextDataApplyRef = useRef(false);
  const timeframeRef = useRef<ChartTimeframe>("15m");
  const metaRef = useRef<PatternChartData | null>(null);
  const layersRef = useRef<ChartLayers>(DEFAULT_LAYERS);
  const priceDecimalsRef = useRef(2);
  const lastCloseRef = useRef(0);

  const [timeframe, setTimeframe] = useState<ChartTimeframe>(() => {
    return coerceChartTimeframe(preferredTimeframe) || "15m";
  });
  const [data, setData] = useState<PatternChartData | null>(null);
  const [candleCount, setCandleCount] = useState(0);
  const [lastCandleTime, setLastCandleTime] = useState<number | null>(null);
  const [hasMore, setHasMore] = useState(true);
  const [loading, setLoading] = useState(true);
  const [loadingMore, setLoadingMore] = useState(false);
  const [err, setErr] = useState("");
  const [layers, setLayers] = useState<ChartLayers>(DEFAULT_LAYERS);
  const [oiSubLoading, setOiSubLoading] = useState(false);
  const [oiSubErr, setOiSubErr] = useState("");
  layersRef.current = layers;

  const clearPriceLines = useCallback(() => {
    const series = seriesRef.current;
    if (!series) return;
    for (const line of priceLinesRef.current) {
      series.removePriceLine(line);
    }
    priceLinesRef.current = [];
  }, []);

  const applyPriceAxisFormat = useCallback(
    (
      price: number | null | undefined,
      samplePrices?: Array<number | null | undefined>,
    ) => {
      const samples = [
        ...(samplePrices ?? []),
        price,
      ].filter((x) => x != null && Number.isFinite(Number(x)) && Number(x) > 0);
      const fmt = samples.length
        ? chartPriceFormatFromPrices(samples)
        : chartPriceFormat(price);
      priceDecimalsRef.current = fmt.precision;
      seriesRef.current?.applyOptions({ priceFormat: fmt });
      upperRef.current?.applyOptions({ priceFormat: fmt });
      midRef.current?.applyOptions({ priceFormat: fmt });
      lowerRef.current?.applyOptions({ priceFormat: fmt });
      for (const { key } of VEGAS_SERIES) {
        vegasRefs.current[key]?.applyOptions({ priceFormat: fmt });
      }
      chartApi.current?.applyOptions({
        localization: {
          ...chartLocalization,
          priceFormatter: (p: number) => formatChartAxisPrice(p, priceDecimalsRef.current),
        },
      });
    },
    [],
  );

  const applyMacdAxisFormat = useCallback((payload: PatternChartData) => {
    const vals = [
      ...(payload.macd?.hist ?? []).map((p) => p.value),
      ...(payload.macd?.line ?? []).map((p) => p.value),
      ...(payload.macd?.signal ?? []).map((p) => p.value),
    ];
    const fmt = chartOscillatorFormat(vals);
    macdHistRef.current?.applyOptions({ priceFormat: fmt });
    macdLineRef.current?.applyOptions({ priceFormat: fmt });
    macdSignalRef.current?.applyOptions({ priceFormat: fmt });
  }, []);

  const applyPriceLines = useCallback((payload: PatternChartData) => {
    const series = seriesRef.current;
    if (!series || payload.partial) return;
    clearPriceLines();
    const showStructure = layersRef.current.structure;
    for (const line of payload.price_lines ?? []) {
      const kind = line.kind ?? "";
      // 清算区图层已下线
      if (LIQ_LINE_KINDS.has(kind)) continue;
      if (!showStructure && STRUCTURE_LINE_KINDS.has(kind)) continue;
      priceLinesRef.current.push(
        series.createPriceLine({
          price: line.price,
          color: line.color,
          lineWidth: 1,
          lineStyle: line.kind === "trigger" ? 2 : 0,
          axisLabelVisible: true,
          title: line.title,
        }),
      );
    }
  }, [clearPriceLines]);

  const applyChartSeries = useCallback(
    (payload: PatternChartData, candles: PatternCandle[], opts?: { isPrepend?: boolean }) => {
      const series = seriesRef.current;
      const chart = chartApi.current;
      if (!series || !chart) return;

      try {
        const prevRange = chart.timeScale().getVisibleLogicalRange();
        const prevLen = candlesRef.current.length;
        const sortedCandles = [...candles]
          .sort((a, b) => a.time - b.time)
          .filter((c, i, arr) => i === 0 || c.time !== arr[i - 1].time);
        const prepended = opts?.isPrepend ? sortedCandles.length - prevLen : 0;

        // 必须先设精度再 setData：LWC 会按 minMove 量化 OHLC，默认 0.01 会把低价币画成锯齿
        const samplePrices = sortedCandles.flatMap((c) => [c.open, c.high, c.low, c.close]);
        applyPriceAxisFormat(sortedCandles.at(-1)?.close, samplePrices);
        applyMacdAxisFormat(payload);

        series.setData(toCandleData(sortedCandles));

        const showPattern = layersRef.current.candlePattern;
        const showStructure = layersRef.current.structure;
        const sandbox = extractSandboxMarkers(payload.markers, metaRef.current?.markers);
        const rebuilt = rebuildChartMarkers(
          sortedCandles,
          (metaRef.current?.state || payload.state) as PatternState | undefined,
          sandbox,
        );
        const markers = toCandleMarkers(rebuilt, showPattern, showStructure, sortedCandles);
        if (markers.length) {
          series.setMarkers(markers);
        } else {
          series.setMarkers([]);
        }

        if (!payload.partial) {
          applyPriceLines(payload);
          metaRef.current = { ...payload, markers: rebuilt };
        } else if (metaRef.current) {
          metaRef.current = { ...metaRef.current, markers: rebuilt };
        }

        if (upperRef.current) {
          const upperPts = [...(payload.bb?.upper ?? [])].sort((a, b) => a.time - b.time);
          upperRef.current.setData(
            upperPts.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })) as LineData[],
          );
        }
        if (midRef.current) {
          const midPts = [...(payload.bb?.mid ?? [])].sort((a, b) => a.time - b.time);
          midRef.current.setData(
            midPts.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })) as LineData[],
          );
        }
        if (lowerRef.current) {
          const lowerPts = [...(payload.bb?.lower ?? [])].sort((a, b) => a.time - b.time);
          lowerRef.current.setData(
            lowerPts.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })) as LineData[],
          );
        }

        for (const { key } of VEGAS_SERIES) {
          const line = vegasRefs.current[key];
          if (!line) continue;
          const pts = [...(payload.vegas?.[key] ?? [])].sort((a, b) => a.time - b.time);
          line.setData(
            pts.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })) as LineData[],
          );
        }

        if (volumeRef.current) {
          volumeRef.current.setData(toVolumeData(sortedCandles));
        }

        if (macdHistRef.current) {
          const hist = [...(payload.macd?.hist ?? [])].sort((a, b) => a.time - b.time);
          macdHistRef.current.setData(
            hist.map(
              (p) =>
                ({
                  time: p.time as UTCTimestamp,
                  value: p.value,
                  color:
                    p.value >= 0 ? "rgba(0, 230, 118, 0.55)" : "rgba(255, 82, 82, 0.55)",
                }) as HistogramData,
            ),
          );
        }
        const macdLinePts = [...(payload.macd?.line ?? [])].sort((a, b) => a.time - b.time);
        const macdSigPts = [...(payload.macd?.signal ?? [])].sort((a, b) => a.time - b.time);
        if (macdLineRef.current) {
          macdLineRef.current.setData(
            macdLinePts.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })) as LineData[],
          );
          if (layersRef.current.macd) {
            macdLineRef.current.setMarkers(buildMacdCrossMarkers(macdLinePts, macdSigPts));
          } else {
            macdLineRef.current.setMarkers([]);
          }
        }
        if (macdSignalRef.current) {
          macdSignalRef.current.setData(
            macdSigPts.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })) as LineData[],
          );
        }

        applyPaneMargins(chart, layersRef.current);

        candlesRef.current = sortedCandles;
        setCandleCount(sortedCandles.length);
        setLastCandleTime(sortedCandles.at(-1)?.time ?? null);

        if (prevRange && prepended > 0) {
          // 只平移视口，保持用户当前看到的 K 线不动；不因缩全图把 from 钉在 0 去连环续载
          restoreLogicalRange(
            chart,
            {
              from: prevRange.from + prepended,
              to: prevRange.to + prepended,
            },
            suppressHistoryLoadRef,
          );
        } else if (prevRange && prevLen > 0) {
          // setData 会重置视口；非 prepend（refresh/live 合并）必须原样恢复，否则左滑历史被打回
          const stickRight = prevRange.to >= prevLen - 8;
          if (stickRight) {
            const span = Math.max(20, prevRange.to - prevRange.from);
            const to = sortedCandles.length + 2;
            restoreLogicalRange(
              chart,
              {
                from: Math.max(0, to - span),
                to,
              },
              suppressHistoryLoadRef,
            );
          } else {
            restoreLogicalRange(chart, prevRange, suppressHistoryLoadRef);
          }
        } else if (!prevRange || prevLen === 0) {
          const to = sortedCandles.length;
          const from = Math.max(0, to - CHART_VISIBLE_BARS);
          restoreLogicalRange(chart, { from, to: to + 2 }, suppressHistoryLoadRef);
        }
      } catch (e) {
        setErr(e instanceof Error ? e.message : "图表渲染失败");
      }
    },
    [applyPriceLines, applyPriceAxisFormat, applyMacdAxisFormat],
  );

  const loadMoreHistoryRef = useRef<() => Promise<void>>(async () => {});

  const loadMoreHistory = useCallback(async () => {
    if (loadingMoreRef.current || !hasMoreRef.current) return;
    if (candlesRef.current.length >= CHART_HISTORY_MAX) {
      hasMoreRef.current = false;
      setHasMore(false);
      return;
    }
    const oldestMs = oldestCandleOpenMs(candlesRef.current);
    if (oldestMs == null) return;

    loadingMoreRef.current = true;
    setLoadingMore(true);
    let shouldChain = false;
    try {
      const prevLen = candlesRef.current.length;
      const prevRange = chartApi.current?.timeScale().getVisibleLogicalRange() ?? null;
      const chunk = await fetchPatternChart(symbol, timeframeRef.current, {
        limit: CHART_LOAD_CHUNK,
        endTimeMs: oldestMs - 1,
      });
      if (!chunk.ok || !chunk.candles?.length) {
        hasMoreRef.current = false;
        setHasMore(false);
        return;
      }

      const merged = mergeCandlesByTime(candlesRef.current, chunk.candles);
      // 无新增 K 线：停止续载，避免同一 endTime 空转
      if (merged.length <= prevLen) {
        hasMoreRef.current = false;
        setHasMore(false);
        return;
      }
      const prepended = merged.length - prevLen;
      hasMoreRef.current =
        resolveChartHasMore(chunk, CHART_LOAD_CHUNK) && merged.length < CHART_HISTORY_MAX;
      setHasMore(hasMoreRef.current);

      const mergedUpper = mergeBbSeries(metaRef.current?.bb?.upper ?? [], chunk.bb?.upper ?? []);
      const mergedMid = mergeBbSeries(metaRef.current?.bb?.mid ?? [], chunk.bb?.mid ?? []);
      const mergedLower = mergeBbSeries(metaRef.current?.bb?.lower ?? [], chunk.bb?.lower ?? []);
      const mergedVegas = mergeVegasMap(metaRef.current?.vegas, chunk.vegas);
      const mergedMacd = mergeMacdMap(metaRef.current?.macd, chunk.macd);
      if (metaRef.current) {
        metaRef.current = {
          ...metaRef.current,
          bb: { upper: mergedUpper, mid: mergedMid, lower: mergedLower },
          vegas: mergedVegas,
          macd: mergedMacd,
          oi: [],
        };
      }
      applyChartSeries(
        {
          ...chunk,
          partial: true,
          bb: { upper: mergedUpper, mid: mergedMid, lower: mergedLower },
          vegas: mergedVegas,
          macd: mergedMacd,
          oi: [],
        },
        merged,
        { isPrepend: true },
      );

      // 同步 React state，但跳过 data→apply 的二次 setData（否则会丢 isPrepend 视口偏移）
      skipNextDataApplyRef.current = true;
      setData((prev) =>
        prev
          ? {
              ...prev,
              candles: merged,
              has_more: hasMoreRef.current,
              bb: { upper: mergedUpper, mid: mergedMid, lower: mergedLower },
              vegas: mergedVegas,
              macd: mergedMacd,
              oi: [],
              markers: metaRef.current?.markers ?? prev.markers,
            }
          : {
              ...chunk,
              ok: true,
              candles: merged,
              has_more: hasMoreRef.current,
              bb: { upper: mergedUpper, mid: mergedMid, lower: mergedLower },
              vegas: mergedVegas,
              macd: mergedMacd,
              oi: [],
              markers: metaRef.current?.markers ?? chunk.markers ?? [],
              price_lines: metaRef.current?.price_lines ?? [],
              analysis: metaRef.current?.analysis ?? {},
              state: metaRef.current?.state ?? ({} as PatternState),
            },
      );

      // 仅当续载后左侧仍有空白（用户拖过头）才再拉一页；不因贴边/看全图连环加载
      if (hasMoreRef.current && prevRange) {
        const intended: LogicalRange = {
          from: prevRange.from + prepended,
          to: prevRange.to + prepended,
        };
        shouldChain = intended.from < 0;
      }
    } catch (e) {
      console.warn("[chart] 左侧历史续载失败", e);
    } finally {
      loadingMoreRef.current = false;
      setLoadingMore(false);
      if (shouldChain) {
        window.setTimeout(() => {
          void loadMoreHistoryRef.current();
        }, 50);
      }
    }
  }, [symbol, applyChartSeries]);

  loadMoreHistoryRef.current = loadMoreHistory;

  const refreshLatestRef = useRef<() => void>(() => {});

  const refreshLatest = useCallback(async () => {
    if (loadingMoreRef.current || loading) return;
    try {
      const json = await fetchPatternChart(symbol, timeframeRef.current, {
        limit: CHART_REFRESH_TAIL,
      });
      if (!json.ok || !json.candles?.length) return;

      const merged = mergeCandlesByTime(candlesRef.current, json.candles);
      const mergedUpper = mergeBbSeries(metaRef.current?.bb?.upper ?? [], json.bb?.upper ?? []);
      const mergedMid = mergeBbSeries(metaRef.current?.bb?.mid ?? [], json.bb?.mid ?? []);
      const mergedLower = mergeBbSeries(metaRef.current?.bb?.lower ?? [], json.bb?.lower ?? []);
      const mergedVegas = mergeVegasMap(metaRef.current?.vegas, json.vegas);
      const mergedMacd = mergeMacdMap(metaRef.current?.macd, json.macd);

      setData({
        ...json,
        candles: merged,
        bb: { upper: mergedUpper, mid: mergedMid, lower: mergedLower },
        vegas: mergedVegas,
        macd: mergedMacd,
        oi: [],
        // markers 由 applyChartSeries 按全量 K 线重算，避免尾部刷新冲掉历史形态
        markers: metaRef.current?.markers ?? json.markers,
      });
    } catch {
      /* 静默 */
    }
  }, [symbol, loading]);

  refreshLatestRef.current = () => {
    void refreshLatest();
  };

  const applyLiveCandle = useCallback((candle: PatternCandle, closed: boolean) => {
    const series = seriesRef.current;
    if (!series || candle.time <= 0) return;

    try {
      series.update({
        time: candle.time as UTCTimestamp,
        open: candle.open,
        high: candle.high,
        low: candle.low,
        close: candle.close,
      });

      if (volumeRef.current && candle.volume != null) {
        volumeRef.current.update({
          time: candle.time as UTCTimestamp,
          value: candle.volume,
          color:
            candle.close >= candle.open
              ? "rgba(0, 230, 118, 0.28)"
              : "rgba(255, 82, 82, 0.28)",
        });
      }

      const candles = candlesRef.current;
      const last = candles[candles.length - 1];
      if (last?.time === candle.time) {
        candles[candles.length - 1] = candle;
      } else if (!last || candle.time > last.time) {
        candlesRef.current = [...candles, candle];
        setCandleCount(candlesRef.current.length);
      }
      setLastCandleTime(candle.time);

      if (closed) refreshLatestRef.current();

      const chart = chartApi.current;
      const range = chart?.timeScale().getVisibleLogicalRange();
      const len = candlesRef.current.length;
      if (chart && range && len > 0 && range.to >= len - 8) {
        const to = len + 2;
        const from = Math.max(0, to - CHART_VISIBLE_BARS);
        chart.timeScale().setVisibleLogicalRange({ from, to });
      }
    } catch {
      /* 静默 */
    }
  }, []);

  const applyLayerVisibility = useCallback((next: ChartLayers) => {
    const chart = chartApi.current;
    upperRef.current?.applyOptions({ visible: next.bb });
    midRef.current?.applyOptions({ visible: next.bb });
    lowerRef.current?.applyOptions({ visible: next.bb });
    volumeRef.current?.applyOptions({ visible: next.volume });
    macdHistRef.current?.applyOptions({ visible: next.macd });
    macdLineRef.current?.applyOptions({ visible: next.macd });
    macdSignalRef.current?.applyOptions({ visible: next.macd });
    if (macdLineRef.current) {
      if (next.macd && metaRef.current?.macd) {
        macdLineRef.current.setMarkers(
          buildMacdCrossMarkers(metaRef.current.macd.line ?? [], metaRef.current.macd.signal ?? []),
        );
      } else {
        macdLineRef.current.setMarkers([]);
      }
    }

    const series = seriesRef.current;
    if (series) {
      series.setMarkers(
        toCandleMarkers(
          metaRef.current?.markers,
          next.candlePattern,
          next.structure,
          candlesRef.current,
        ),
      );
    }
    if (metaRef.current && !metaRef.current.partial) {
      applyPriceLines(metaRef.current);
    }

    if (chart) applyPaneMargins(chart, next);
  }, [applyPriceLines]);

  const toggleLayer = useCallback(
    (key: keyof ChartLayers) => {
      setLayers((prev) => {
        const next = { ...prev, [key]: !prev[key] };
        layersRef.current = next;
        if (key !== "oi") {
          applyLayerVisibility(next);
        } else {
          // 副图挂载后主图画布高度会变，下一帧再量一次
          requestAnimationFrame(() => {
            if (chartRef.current && chartApi.current) {
              chartApi.current.applyOptions({
                width: chartRef.current.clientWidth,
                height: chartRef.current.clientHeight,
              });
            }
          });
        }
        return next;
      });
    },
    [applyLayerVisibility],
  );

  const wsEnabled = !loading && !err && Boolean(data?.candles?.length);
  const { markPrice, connected: wsConnected } = useBinanceChartLive(
    symbol,
    timeframe,
    wsEnabled,
    useCallback(
      (update: LiveKlineUpdate) => applyLiveCandle(update.candle, update.closed),
      [applyLiveCandle],
    ),
    useCallback(() => {
      refreshLatestRef.current();
    }, []),
  );

  // 从信号 chip / 列表打开时，切到该信号的周期
  useEffect(() => {
    const tf = coerceChartTimeframe(preferredTimeframe);
    if (tf) setTimeframe(tf);
  }, [symbol, preferredTimeframe, preferredTimeframeNonce]);

  useEffect(() => {
    let cancelled = false;
    timeframeRef.current = timeframe;
    candlesRef.current = [];
    hasMoreRef.current = true;
    loadingMoreRef.current = false;
    metaRef.current = null;
    setHasMore(true);
    setLoading(true);
    setErr("");
    setLoadingMore(false);
    setLastCandleTime(null);

    fetchPatternChart(symbol, timeframe, { limit: CHART_DEFAULT_LIMIT })
      .then((json) => {
        if (cancelled) return;
        if (!json.ok) {
          setErr(json.error || "加载失败");
          setData(null);
          return;
        }
        hasMoreRef.current = resolveChartHasMore(json, CHART_DEFAULT_LIMIT);
        setHasMore(hasMoreRef.current);
        setData(json);
      })
      .catch(() => {
        if (!cancelled) setErr("网络错误");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [symbol, timeframe]);

  useEffect(() => {
    if (loading || err || !data?.candles?.length || !symbol) return;

    const tick = () => {
      if (!document.hidden) void refreshLatest();
    };
    // 先立即补一次，再每分钟刷新当前选中币种的近期 K 线
    tick();
    const id = window.setInterval(tick, CHART_KLINE_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [symbol, timeframe, loading, err, data?.candles?.length, refreshLatest]);

  useEffect(() => {
    if (!chartRef.current) return;

    if (chartApi.current) {
      chartApi.current.remove();
      chartApi.current = null;
      seriesRef.current = null;
      upperRef.current = null;
      midRef.current = null;
      lowerRef.current = null;
      volumeRef.current = null;
      macdHistRef.current = null;
      macdLineRef.current = null;
      macdSignalRef.current = null;
      vegasRefs.current = {};
      priceLinesRef.current = [];
    }

    const el = chartRef.current;

    try {
      const chart = createChart(el, {
        width: el.clientWidth,
        height: el.clientHeight,
        layout: {
          background: { type: ColorType.Solid, color: "#0a0a0a" },
          textColor: "#9e9e9e",
          fontSize: CHART_FONT_SIZE,
        },
        grid: {
          vertLines: { color: "#1e1e1e" },
          horzLines: { color: "#1e1e1e" },
        },
        rightPriceScale: { borderColor: "#2a2a2a" },
        localization: {
          ...chartLocalization,
          priceFormatter: (p: number) => formatChartAxisPrice(p, priceDecimalsRef.current),
        },
        timeScale: {
          borderColor: "#2a2a2a",
          ...chartTimeScaleOptions,
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          horzLine: { labelVisible: false },
        },
        handleScale: {
          axisPressedMouseMove: { time: true, price: true },
          mouseWheel: true,
          pinch: true,
        },
        handleScroll: {
          mouseWheel: true,
          pressedMouseMove: true,
          horzTouchDrag: true,
          vertTouchDrag: false,
        },
      });

      const seedFmt = chartPriceFormat(null);
      priceDecimalsRef.current = seedFmt.precision;

      const series = chart.addCandlestickSeries({
        upColor: "#00e676",
        downColor: "#ff5252",
        borderVisible: false,
        wickUpColor: "#00e676",
        wickDownColor: "#ff5252",
        priceFormat: seedFmt,
      });

      upperRef.current = chart.addLineSeries({
        color: "rgba(100, 181, 246, 0.45)",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        visible: layersRef.current.bb,
        priceFormat: seedFmt,
      });
      midRef.current = chart.addLineSeries({
        color: "rgba(255, 193, 7, 0.55)",
        lineWidth: 1,
        lineStyle: 2,
        priceLineVisible: false,
        lastValueVisible: false,
        visible: layersRef.current.bb,
        priceFormat: seedFmt,
      });
      lowerRef.current = chart.addLineSeries({
        color: "rgba(100, 181, 246, 0.25)",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        visible: layersRef.current.bb,
        priceFormat: seedFmt,
      });

      for (const { key, color } of VEGAS_SERIES) {
        vegasRefs.current[key] = chart.addLineSeries({
          color,
          lineWidth: key === "filter" ? 2 : 1,
          priceLineVisible: false,
          lastValueVisible: false,
          priceFormat: seedFmt,
        });
      }

      volumeRef.current = chart.addHistogramSeries({
        priceScaleId: "volume",
        priceFormat: { type: "volume" },
        priceLineVisible: false,
        lastValueVisible: false,
        visible: layersRef.current.volume,
        autoscaleInfoProvider: volumeAutoscaleInfoProvider,
      });

      macdHistRef.current = chart.addHistogramSeries({
        priceScaleId: "macd",
        priceLineVisible: false,
        lastValueVisible: false,
        visible: layersRef.current.macd,
        autoscaleInfoProvider: macdAutoscaleInfoProvider,
      });
      macdLineRef.current = chart.addLineSeries({
        priceScaleId: "macd",
        color: "rgba(33, 150, 243, 0.9)",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        visible: layersRef.current.macd,
        autoscaleInfoProvider: macdAutoscaleInfoProvider,
      });
      macdSignalRef.current = chart.addLineSeries({
        priceScaleId: "macd",
        color: "rgba(255, 152, 0, 0.9)",
        lineWidth: 1,
        priceLineVisible: false,
        lastValueVisible: false,
        visible: layersRef.current.macd,
        autoscaleInfoProvider: macdAutoscaleInfoProvider,
      });

      applyPaneMargins(chart, layersRef.current);

      chartApi.current = chart;
      seriesRef.current = series;

      const hideCrosshairPrice = () => {
        const label = crosshairPriceRef.current;
        if (label) label.style.display = "none";
      };

      const onCrosshairMove = (param: {
        point?: { x: number; y: number } | undefined;
        time?: unknown;
      }) => {
        const label = crosshairPriceRef.current;
        const seriesApi = seriesRef.current;
        if (!label || !seriesApi) return;
        if (
          !param.point ||
          param.time === undefined ||
          param.point.x < 0 ||
          param.point.y < 0
        ) {
          hideCrosshairPrice();
          return;
        }
        const price = seriesApi.coordinateToPrice(param.point.y);
        if (price == null || !Number.isFinite(price)) {
          hideCrosshairPrice();
          return;
        }
        const d = priceDecimalsRef.current;
        const priceStr = d <= 0 ? String(Math.round(price)) : price.toFixed(d);
        const last = lastCloseRef.current;
        if (last > 0) {
          const pctChg = ((price - last) / last) * 100;
          const sign = pctChg >= 0 ? "+" : "";
          label.textContent = `${priceStr} (${sign}${pctChg.toFixed(2)}%)`;
          label.classList.toggle("pos", pctChg >= 0);
          label.classList.toggle("neg", pctChg < 0);
        } else {
          label.textContent = priceStr;
          label.classList.remove("pos", "neg");
        }
        label.style.display = "block";
        label.style.top = `${param.point.y}px`;
      };
      chart.subscribeCrosshairMove(onCrosshairMove);

      const onRange = (range: LogicalRange | null) => {
        if (!range || loadingMoreRef.current) return;
        if (suppressHistoryLoadRef.current > 0) return;
        const len = candlesRef.current.length;
        // 只有左侧真正露空白时，才允许把误判的 has_more=false 翻回来再试
        if (!hasMoreRef.current) {
          if (range.from >= 0 || len >= CHART_HISTORY_MAX) return;
          hasMoreRef.current = true;
          setHasMore(true);
        }
        if (needsLeftHistory(range, len)) void loadMoreHistoryRef.current();
      };
      chart.timeScale().subscribeVisibleLogicalRangeChange(onRange);

      const probeLeftHistory = () => {
        if (loadingMoreRef.current) return;
        if (suppressHistoryLoadRef.current > 0) return;
        const range = chart.timeScale().getVisibleLogicalRange();
        const len = candlesRef.current.length;
        if (!range) return;
        if (!hasMoreRef.current) {
          if (range.from >= 0 || len >= CHART_HISTORY_MAX) return;
          hasMoreRef.current = true;
          setHasMore(true);
        }
        if (needsLeftHistory(range, len)) void loadMoreHistoryRef.current();
      };

      // 滚轮缩放/平移后 LWC 有时不立刻抛 range 事件；下一帧再探一次左缘
      const onWheel = () => {
        window.requestAnimationFrame(probeLeftHistory);
      };
      el.addEventListener("wheel", onWheel, { passive: true });
      // 拖拽平移松手后再探一次（向右滑看更早 K 线）
      const onPointerUp = () => {
        window.requestAnimationFrame(() => {
          window.requestAnimationFrame(probeLeftHistory);
        });
      };
      el.addEventListener("pointerup", onPointerUp);
      el.addEventListener("pointercancel", onPointerUp);

      const resizeMain = () => {
        if (chartRef.current && chartApi.current) {
          chartApi.current.applyOptions({
            width: chartRef.current.clientWidth,
            height: chartRef.current.clientHeight,
          });
        }
      };
      const resizeOiSubs = () => {
        const pairs: Array<[HTMLDivElement | null, IChartApi | null]> = [
          [oiChartElRef.current, oiChartApi.current],
          [spotNetElRef.current, spotNetChartApi.current],
          [futNetElRef.current, futNetChartApi.current],
        ];
        for (const [node, api] of pairs) {
          if (node && api) {
            api.applyOptions({ width: node.clientWidth, height: node.clientHeight });
          }
        }
      };
      const onResize = () => {
        resizeMain();
        resizeOiSubs();
      };
      window.addEventListener("resize", onResize);
      const ro =
        typeof ResizeObserver !== "undefined" && chartRef.current
          ? new ResizeObserver(() => resizeMain())
          : null;
      if (ro && chartRef.current) ro.observe(chartRef.current);

      return () => {
        window.removeEventListener("resize", onResize);
        ro?.disconnect();
        el.removeEventListener("wheel", onWheel);
        el.removeEventListener("pointerup", onPointerUp);
        el.removeEventListener("pointercancel", onPointerUp);
        chart.timeScale().unsubscribeVisibleLogicalRangeChange(onRange);
        chart.unsubscribeCrosshairMove(onCrosshairMove);
        hideCrosshairPrice();
        chart.remove();
        chartApi.current = null;
        seriesRef.current = null;
        upperRef.current = null;
        midRef.current = null;
        lowerRef.current = null;
        volumeRef.current = null;
        macdHistRef.current = null;
        macdLineRef.current = null;
        macdSignalRef.current = null;
        vegasRefs.current = {};
        priceLinesRef.current = [];
      };
    } catch (e) {
      setErr(e instanceof Error ? e.message : "图表初始化失败");
    }
  }, [symbol, timeframe]);

  useEffect(() => {
    if (!data?.candles?.length || !seriesRef.current) return;
    if (skipNextDataApplyRef.current) {
      skipNextDataApplyRef.current = false;
      applyLayerVisibility(layersRef.current);
      return;
    }
    // 左侧续载后 candlesRef 更长；勿用较短的 data 冲掉历史（否则左滑空白）
    const refLen = candlesRef.current.length;
    const dataLen = data.candles.length;
    if (
      refLen > dataLen &&
      candlesRef.current.at(-1)?.time === data.candles.at(-1)?.time
    ) {
      applyLayerVisibility(layersRef.current);
      return;
    }
    applyChartSeries(data, data.candles);
    applyLayerVisibility(layersRef.current);
  }, [data, applyChartSeries, applyLayerVisibility]);

  const analysis = data?.analysis;
  const deriv = analysis?.derivatives;
  const mtf = deriv?.mtf;
  const ticker = data?.ticker;
  const lastPrice =
    markPrice ?? liveTicker?.last_price ?? ticker?.last_price ?? analysis?.last_price;
  const pct = liveTicker?.price_change_pct_24h ?? ticker?.price_change_pct_24h;
  const oiUsd = liveTicker?.current_oi_usd ?? ticker?.current_oi_usd;
  const quoteVol = liveTicker?.quote_volume ?? ticker?.quote_volume;
  const statusLabel = analysis?.status_label || state?.status_label || "—";

  useEffect(() => {
    const seed =
      lastPrice ??
      candlesRef.current.at(-1)?.close ??
      data?.candles?.at(-1)?.close ??
      0;
    if (seed && Number.isFinite(seed) && seed > 0) {
      lastCloseRef.current = Number(seed);
    }
  }, [lastPrice, data?.candles, candleCount]);

  useEffect(() => {
    if (!seriesRef.current) return;
    const candles = candlesRef.current.length
      ? candlesRef.current
      : data?.candles ?? [];
    const seed =
      lastPrice ??
      candles.at(-1)?.close ??
      null;
    const samples = candles.flatMap((c) => [c.open, c.high, c.low, c.close]);
    applyPriceAxisFormat(seed, samples);
  }, [lastPrice, data?.candles, candleCount, applyPriceAxisFormat]);

  /** 持仓量副图：挂载 / 销毁 LWC 实例，并与主图时间轴同步 */
  useEffect(() => {
    if (!layers.oi) {
      oiChartApi.current?.remove();
      spotNetChartApi.current?.remove();
      futNetChartApi.current?.remove();
      oiChartApi.current = null;
      spotNetChartApi.current = null;
      futNetChartApi.current = null;
      oiSeriesRef.current = null;
      spotNetSeriesRef.current = null;
      futNetSeriesRef.current = null;
      return;
    }

    const main = chartApi.current;
    const oiEl = oiChartElRef.current;
    const spotEl = spotNetElRef.current;
    const futEl = futNetElRef.current;
    if (!main || !oiEl || !spotEl || !futEl) return;

    const PRICE_AXIS_MIN_W = 56;
    const mkSub = (el: HTMLDivElement) =>
      createChart(el, {
        width: el.clientWidth,
        height: el.clientHeight,
        layout: {
          background: { type: ColorType.Solid, color: "#0a0a0a" },
          textColor: "#9e9e9e",
          fontSize: CHART_FONT_SIZE,
        },
        grid: {
          vertLines: { color: "#1e1e1e" },
          horzLines: { color: "#1e1e1e" },
        },
        rightPriceScale: {
          borderColor: "#2a2a2a",
          // 与主图右轴同宽，避免绘图区左右错位看起来像「时间不同步」
          minimumWidth: PRICE_AXIS_MIN_W,
        },
        timeScale: {
          borderColor: "#2a2a2a",
          ...chartTimeScaleOptions,
          visible: el === futEl,
        },
        crosshair: {
          mode: CrosshairMode.Normal,
          // 副图主要跟主图联动竖线（时间轴）；横线弱化
          vertLine: {
            visible: true,
            labelVisible: false,
            style: 2, // Dashed
            color: "rgba(158, 158, 158, 0.55)",
            width: 1,
          },
          horzLine: {
            visible: true,
            labelVisible: true,
            style: 2,
            color: "rgba(158, 158, 158, 0.35)",
            width: 1,
          },
        },
        handleScroll: false,
        handleScale: false,
      });

    const oiChart = mkSub(oiEl);
    const spotChart = mkSub(spotEl);
    const futChart = mkSub(futEl);
    oiChartApi.current = oiChart;
    spotNetChartApi.current = spotChart;
    futNetChartApi.current = futChart;

    try {
      main.priceScale("right").applyOptions({ minimumWidth: PRICE_AXIS_MIN_W });
    } catch {
      /* ignore */
    }

    const oiSeries = oiChart.addLineSeries({
      color: DERIV_OI_LINE_COLOR,
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    const spotSeries = spotChart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    const futSeries = futChart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceLineVisible: false,
      lastValueVisible: false,
    });
    oiSeriesRef.current = oiSeries;
    spotNetSeriesRef.current = spotSeries;
    futNetSeriesRef.current = futSeries;

    const subCharts = [oiChart, spotChart, futChart];
    const crosshairTargets: Array<{
      chart: IChartApi;
      series: ISeriesApi<"Line"> | ISeriesApi<"Histogram">;
      values: { current: Map<number, number> };
    }> = [
      { chart: oiChart, series: oiSeries, values: oiValueByTimeRef },
      { chart: spotChart, series: spotSeries, values: spotNetByTimeRef },
      { chart: futChart, series: futSeries, values: futNetByTimeRef },
    ];

    const clearAllSubCrosshairs = () => {
      for (const { chart } of crosshairTargets) {
        try {
          chart.clearCrosshairPosition();
        } catch {
          /* disposed */
        }
      }
    };

    const syncCrosshairToSubs = (time: unknown) => {
      if (crosshairSyncingRef.current) return;
      if (time === undefined || time === null) {
        crosshairSyncingRef.current = true;
        try {
          clearAllSubCrosshairs();
        } finally {
          crosshairSyncingRef.current = false;
        }
        return;
      }
      const t = typeof time === "number" ? time : Number(time);
      if (!Number.isFinite(t)) {
        clearAllSubCrosshairs();
        return;
      }
      crosshairSyncingRef.current = true;
      try {
        for (const { chart, series, values } of crosshairTargets) {
          const price = values.current.get(t);
          // 无点位时仍用 0 定位竖线（时间轴虚线）
          chart.setCrosshairPosition(
            price != null && Number.isFinite(price) ? price : 0,
            t as UTCTimestamp,
            series,
          );
        }
      } catch {
        /* disposed */
      } finally {
        crosshairSyncingRef.current = false;
      }
    };

    const onMainCrosshair = (param: { time?: unknown }) => {
      syncCrosshairToSubs(param.time);
    };
    main.subscribeCrosshairMove(onMainCrosshair);

    // 副图悬停时同样把竖线打到其余副图（主图由用户指针主导，不回写以免抢焦点）
    const onSubCrosshair =
      (self: IChartApi) => (param: { time?: unknown }) => {
        if (crosshairSyncingRef.current) return;
        if (param.time === undefined) {
          for (const { chart } of crosshairTargets) {
            if (chart !== self) {
              try {
                chart.clearCrosshairPosition();
              } catch {
                /* ignore */
              }
            }
          }
          return;
        }
        const t = typeof param.time === "number" ? param.time : Number(param.time);
        if (!Number.isFinite(t)) return;
        crosshairSyncingRef.current = true;
        try {
          for (const { chart, series, values } of crosshairTargets) {
            if (chart === self) continue;
            const price = values.current.get(t);
            chart.setCrosshairPosition(
              price != null && Number.isFinite(price) ? price : 0,
              t as UTCTimestamp,
              series,
            );
          }
        } catch {
          /* ignore */
        } finally {
          crosshairSyncingRef.current = false;
        }
      };
    const onOiCross = onSubCrosshair(oiChart);
    const onSpotCross = onSubCrosshair(spotChart);
    const onFutCross = onSubCrosshair(futChart);
    oiChart.subscribeCrosshairMove(onOiCross);
    spotChart.subscribeCrosshairMove(onSpotCross);
    futChart.subscribeCrosshairMove(onFutCross);

    const syncFromMain = (range: LogicalRange | null) => {
      if (!range || derivSyncingRef.current) return;
      derivSyncingRef.current = true;
      try {
        // 复制 barSpacing / rightOffset，再设 logical range，拖动/缩放时才不会漂
        const tsOpts = main.timeScale().options();
        const spacing = {
          barSpacing: tsOpts.barSpacing,
          rightOffset: tsOpts.rightOffset,
        };
        for (const c of subCharts) {
          c.timeScale().applyOptions(spacing);
          c.timeScale().setVisibleLogicalRange(range);
        }
      } catch {
        /* disposed */
      } finally {
        derivSyncingRef.current = false;
      }
    };
    const onMainRange = (range: LogicalRange | null) => syncFromMain(range);
    main.timeScale().subscribeVisibleLogicalRangeChange(onMainRange);
    const cur = main.timeScale().getVisibleLogicalRange();
    if (cur) syncFromMain(cur);

    const ro = typeof ResizeObserver !== "undefined" ? new ResizeObserver(() => {
      for (const [node, api] of [
        [oiEl, oiChart],
        [spotEl, spotChart],
        [futEl, futChart],
      ] as const) {
        api.applyOptions({ width: node.clientWidth, height: node.clientHeight });
      }
    }) : null;
    ro?.observe(oiEl);
    ro?.observe(spotEl);
    ro?.observe(futEl);

    // 主图画布在副图出现后变矮
    if (chartRef.current) {
      main.applyOptions({
        width: chartRef.current.clientWidth,
        height: chartRef.current.clientHeight,
      });
    }

    return () => {
      main.timeScale().unsubscribeVisibleLogicalRangeChange(onMainRange);
      main.unsubscribeCrosshairMove(onMainCrosshair);
      oiChart.unsubscribeCrosshairMove(onOiCross);
      spotChart.unsubscribeCrosshairMove(onSpotCross);
      futChart.unsubscribeCrosshairMove(onFutCross);
      try {
        main.priceScale("right").applyOptions({ minimumWidth: 0 });
      } catch {
        /* ignore */
      }
      ro?.disconnect();
      oiChart.remove();
      spotChart.remove();
      futChart.remove();
      oiChartApi.current = null;
      spotNetChartApi.current = null;
      futNetChartApi.current = null;
      oiSeriesRef.current = null;
      spotNetSeriesRef.current = null;
      futNetSeriesRef.current = null;
    };
  }, [layers.oi, symbol, timeframe]);

  /** 持仓量副图数据：与当前已加载 K 线时间戳对齐 */
  useEffect(() => {
    if (!layers.oi) {
      setOiSubLoading(false);
      setOiSubErr("");
      return;
    }
    const times = candlesRef.current.map((c) => c.time);
    if (!times.length) return;

    let cancelled = false;
    setOiSubLoading(true);
    setOiSubErr("");

    // 先用与主图等长的 whitespace 占位，避免续载/切换后 bar 数不一致导致拖动错位
    const placeholders = times.map((t) => ({ time: t as UTCTimestamp }));
    oiSeriesRef.current?.setData(placeholders);
    spotNetSeriesRef.current?.setData(placeholders);
    futNetSeriesRef.current?.setData(placeholders);
    {
      const range = chartApi.current?.timeScale().getVisibleLogicalRange();
      if (range && chartApi.current) {
        const tsOpts = chartApi.current.timeScale().options();
        const spacing = {
          barSpacing: tsOpts.barSpacing,
          rightOffset: tsOpts.rightOffset,
        };
        for (const api of [
          oiChartApi.current,
          spotNetChartApi.current,
          futNetChartApi.current,
        ]) {
          if (!api) continue;
          api.timeScale().applyOptions(spacing);
          api.timeScale().setVisibleLogicalRange(range);
        }
      }
    }

    void (async () => {
      try {
        const payload = await fetchChartDerivSubplots(symbol, timeframe, times);
        if (cancelled) return;
        // 副图实例可能比本 effect 晚一帧挂好
        for (let i = 0; i < 12 && !oiSeriesRef.current; i++) {
          await new Promise((r) => requestAnimationFrame(() => r(null)));
          if (cancelled) return;
        }
        oiSeriesRef.current?.setData(payload.oi);
        spotNetSeriesRef.current?.setData(payload.spotNet);
        futNetSeriesRef.current?.setData(payload.futuresNet);

        const fillMap = (
          rows: Array<{ time?: unknown; value?: unknown }>,
          target: { current: Map<number, number> },
        ) => {
          const m = new Map<number, number>();
          for (const row of rows) {
            if (row == null || !("value" in row) || row.value == null) continue;
            const t = Number(row.time);
            const v = Number(row.value);
            if (Number.isFinite(t) && Number.isFinite(v)) m.set(t, v);
          }
          target.current = m;
        };
        fillMap(payload.oi, oiValueByTimeRef);
        fillMap(payload.spotNet, spotNetByTimeRef);
        fillMap(payload.futuresNet, futNetByTimeRef);

        const range = chartApi.current?.timeScale().getVisibleLogicalRange();
        if (range && chartApi.current) {
          derivSyncingRef.current = true;
          try {
            const tsOpts = chartApi.current.timeScale().options();
            const spacing = {
              barSpacing: tsOpts.barSpacing,
              rightOffset: tsOpts.rightOffset,
            };
            for (const api of [
              oiChartApi.current,
              spotNetChartApi.current,
              futNetChartApi.current,
            ]) {
              if (!api) continue;
              api.timeScale().applyOptions(spacing);
              api.timeScale().setVisibleLogicalRange(range);
            }
          } finally {
            derivSyncingRef.current = false;
          }
        }
        if (!payload.oi.length && !payload.spotNet.length && !payload.futuresNet.length) {
          setOiSubErr("副图数据为空");
        }
      } catch (e) {
        if (!cancelled) {
          setOiSubErr(e instanceof Error ? e.message : "副图加载失败");
        }
      } finally {
        if (!cancelled) setOiSubLoading(false);
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [layers.oi, symbol, timeframe, candleCount, lastCandleTime]);

  const activeKinds = new Set(data?.markers?.map((m) => m.kind).filter(Boolean) ?? []);
  data?.price_lines?.forEach((l) => activeKinds.add(l.kind));
  const hasVegas = Boolean(
    data?.vegas && VEGAS_SERIES.some((s) => (data.vegas?.[s.key]?.length ?? 0) > 0),
  );

  return (
    <div className="pattern-chart-panel">
      <header className="pattern-chart-head">
        <div className="pattern-chart-head-top">
          <div
            className="pattern-chart-title"
            title={onTitleContextMenu ? "右键可置顶（至少 1 天）或取消置顶" : undefined}
            onContextMenu={(e) => onTitleContextMenu?.(e, symbol)}
          >
            <CoinAvatar symbol={symbol} />
            <div>
              <h2>${displaySymbol(symbol)}</h2>
              <div className="pattern-chart-meta">
                <span className={pct != null && pct >= 0 ? "pos" : "neg"}>
                  ${fmtMetaPrice(lastPrice)}
                  {pct != null ? ` · ${fmtPct(pct)}` : ""}
                </span>
                <span>OI {fmtNum(oiUsd)}</span>
                {deriv?.funding_rate_pct != null ? (
                  <span
                    className={
                      deriv.funding_extreme_positive
                        ? "deriv-funding hot"
                        : deriv.funding_rate_pct < 0
                          ? "deriv-funding neg"
                          : "deriv-funding"
                    }
                    title="永续资金费率（8h）"
                  >
                    费率 {deriv.funding_rate_pct >= 0 ? "+" : ""}
                    {deriv.funding_rate_pct}%
                  </span>
                ) : null}
                {deriv?.oi_regime_label ? (
                  <span
                    className={`deriv-oi ${deriv.oi_regime === "squeeze" ? "warn" : deriv.oi_regime === "breakout" ? "pos" : ""}`}
                    title={`价变 ${deriv.oi_price_chg_pct ?? "—"}% · OI变 ${deriv.oi_chg_pct ?? "—"}%`}
                  >
                    {deriv.oi_regime_label}
                  </span>
                ) : null}
                <span>24h额 {fmtNum(quoteVol)}</span>
                <span className="pat-status-tag">{statusLabel}</span>
              </div>
            </div>
          </div>
          <div className="pattern-chart-head-actions">
            <div className="mercu-timeframes pattern-chart-tf">
              {CHART_TIMEFRAMES.map((tf) => (
                <button
                  key={tf}
                  type="button"
                  className={`tf-btn ${tf === timeframe ? "active" : ""}`}
                  onClick={() => setTimeframe(tf)}
                  disabled={loading && tf !== timeframe}
                >
                  {tf}
                </button>
              ))}
            </div>
            <div className="pattern-chart-layers" role="group" aria-label="图表图层">
              {LAYER_TOGGLES.map(({ key, label }) => (
                <button
                  key={key}
                  type="button"
                  className={`layer-btn ${layers[key] ? "active" : ""} ${key === "oi" ? "layer-btn-oi" : ""}`}
                  onClick={() => toggleLayer(key)}
                  title={layers[key] ? `隐藏${label}` : `显示${label}`}
                >
                  {label}
                </button>
              ))}
            </div>
            {!inWatchlist && onAddToWatchlist ? (
              <button
                type="button"
                className="pattern-chart-add-watch"
                disabled={addWatchBusy}
                onClick={() => onAddToWatchlist(symbol)}
              >
                添加到形态列表
              </button>
            ) : null}
            {inWatchlist ? (
              <span className="pattern-chart-in-watch" title="已在形态监听列表">
                已在列表
              </span>
            ) : null}
          </div>
        </div>
      </header>

      <div className="pattern-chart-body">
        <aside className="pattern-analysis-side">
          <h3>位置分析</h3>
          {loading && <p className="pattern-empty">加载 K 线…</p>}
          {err && <p className="pattern-err">{err}</p>}
          {!loading && !err && (
            <>
              <p className="pattern-analysis-msg">{analysis?.message || "扫描形态结构中…"}</p>
              <ul className="pattern-marker-legend">
                {MARKER_LEGEND.filter(
                  (m) =>
                    activeKinds.has(m.kind) &&
                    (layers.structure || !STRUCTURE_MARKER_KINDS.has(m.kind)),
                ).map((m) => (
                  <li key={m.kind}>
                    <span className="legend-dot" style={{ background: m.color }} />
                    {m.label}
                    {analysis && m.kind === "h_max" && (analysis.h_max ?? 0) > 0 ? (
                      <em>{fmtMetaPrice(analysis.h_max)}</em>
                    ) : null}
                    {analysis && m.kind === "lh" && (analysis.lh_price ?? 0) > 0 ? (
                      <em>{fmtMetaPrice(analysis.lh_price)}</em>
                    ) : null}
                    {analysis && m.kind === "l1" && (analysis.l1 ?? 0) > 0 ? (
                      <em>{fmtMetaPrice(analysis.l1)}</em>
                    ) : null}
                    {analysis && m.kind === "hl" && (analysis.hl ?? 0) > 0 ? (
                      <em>{fmtMetaPrice(analysis.hl)}</em>
                    ) : null}
                    {analysis && m.kind === "trigger" && (analysis.trigger_price ?? 0) > 0 ? (
                      <em>{fmtMetaPrice(analysis.trigger_price)}</em>
                    ) : null}
                  </li>
                ))}
                {hasVegas
                  ? VEGAS_SERIES.map((s) => (
                      <li key={`vegas-${s.key}`}>
                        <span className="legend-dot" style={{ background: s.color }} />
                        Vegas {s.title}
                      </li>
                    ))
                  : null}
                {(data?.bb?.mid?.length ?? 0) > 0 ? (
                  <li key="bb-mid">
                    <span className="legend-dot" style={{ background: "rgba(255, 193, 7, 0.85)" }} />
                    布林中轨
                  </li>
                ) : null}
              </ul>
              <div className="pattern-signal-tags">
                {analysis?.bb_wick_top && <span className="sig bb">BB-Wicks 顶部</span>}
                {analysis?.macd_top_weak && <span className="sig macd-weak">MACD 走弱</span>}
                {analysis?.macd_bull && <span className="sig macd-bull">MACD 金叉放大</span>}
                {deriv?.high_funding_short_bias && (
                  <span className="sig funding-short" title="高正费率 + 挤空/突破结构，顶背离胜率提升">
                    高费率·看空共振
                  </span>
                )}
                {deriv?.oi_regime === "squeeze" && (
                  <span className="sig oi-squeeze">挤空假突破风险</span>
                )}
                {deriv?.oi_regime === "breakout" && (
                  <span className="sig oi-breakout">OI 真突破</span>
                )}
                {mtf?.summary ? (
                  <span
                    className={`sig mtf ${mtf.allow_short === false ? "blocked" : "ok"}`}
                    title={mtf.block_reason || mtf.summary}
                  >
                    MTF {mtf["4h"]?.vegas_label ? `4h ${mtf["4h"].vegas_label}` : ""}
                    {mtf.allow_short === false ? " · 过滤空信号" : ""}
                  </span>
                ) : null}
                {analysis?.oi_anomaly_only && <span className="sig oi">OI异动</span>}
                {analysis?.oi_anomaly && !analysis?.oi_anomaly_only && (
                  <span className="sig oi-combo">形态+OI异动</span>
                )}
                {analysis?.sweep_momentum ? (
                  <span
                    className={`sig sweep score-${
                      analysis.sweep_momentum.sustainability_score >= 70
                        ? "high"
                        : analysis.sweep_momentum.sustainability_score >= 40
                          ? "mid"
                          : "low"
                    } ${
                      analysis.sweep_momentum.is_bullish_sweep
                        ? "bull"
                        : analysis.sweep_momentum.is_bearish_sweep
                          ? "bear"
                          : ""
                    }`}
                    title={[
                      analysis.sweep_momentum.signal_type,
                      `量能 ${analysis.sweep_momentum.vol_ratio}x`,
                      analysis.sweep_momentum.oi_delta_pct != null
                        ? `OI ${analysis.sweep_momentum.oi_delta_pct > 0 ? "+" : ""}${analysis.sweep_momentum.oi_delta_pct}%`
                        : "OI —",
                      ...(analysis.sweep_momentum.reasons || []),
                    ].join("\n")}
                  >
                    扫荡 {analysis.sweep_momentum.sustainability_score}
                    {analysis.sweep_momentum.signal_type !== "普通震荡"
                      ? ` · ${analysis.sweep_momentum.signal_type.replace("反转扫荡", "")}`
                      : ""}
                  </span>
                ) : null}
              </div>
              {analysis?.sweep_momentum && analysis.sweep_momentum.reasons?.length ? (
                <ul className="pattern-sweep-reasons">
                  <li className="pattern-sweep-head">
                    持续性 {analysis.sweep_momentum.sustainability_score}/100 ·{" "}
                    {analysis.sweep_momentum.signal_type}
                    {" · "}量 {analysis.sweep_momentum.vol_ratio}x
                    {analysis.sweep_momentum.oi_delta_pct != null
                      ? ` · OI ${analysis.sweep_momentum.oi_delta_pct > 0 ? "+" : ""}${analysis.sweep_momentum.oi_delta_pct}%`
                      : ""}
                  </li>
                  {analysis.sweep_momentum.reasons.map((r, i) => (
                    <li key={`sweep-r-${i}`}>{r}</li>
                  ))}
                </ul>
              ) : null}
              {mtf?.["4h"]?.ready || mtf?.["1d"]?.ready ? (
                <p className="pattern-mtf-row">
                  多周期：
                  {mtf?.["4h"]?.ready ? (
                    <span>
                      {" "}
                      4h {String(mtf["4h"].vegas_label || "—")} / {String(mtf["4h"].trend || "—")}
                      {mtf["4h"].macd_top_weak ? " · MACD顶弱" : ""}
                    </span>
                  ) : null}
                  {mtf?.["1d"]?.ready ? (
                    <span>
                      {" · "}
                      日线 {String(mtf["1d"].vegas_label || "—")} / {String(mtf["1d"].trend || "—")}
                    </span>
                  ) : null}
                </p>
              ) : null}
              <p className="pattern-interval-tag">
                {timeframe} · 已加载 {candleCount} 根
                {lastCandleTime ? ` · 最新 ${formatCandleLocalTime(lastCandleTime)}` : ""}
                {wsConnected ? " · 实时" : " · 连接中…"}
                {loadingMore ? " · 加载更早…" : hasMore ? " · 右拖/左滑看更早可续载" : " · 已到最早"}
              </p>
            </>
          )}
        </aside>
        <div
          className={`pattern-chart-wrap${layers.oi ? " with-oi-subs" : ""}`}
          ref={chartWrapRef}
        >
          <div className="pattern-chart-main-pane">
            <div className="pattern-chart-canvas" ref={chartRef} />
            <div
              ref={crosshairPriceRef}
              className="pattern-crosshair-price"
              aria-hidden
            />
          </div>
          {layers.oi ? (
            <div className="pattern-oi-subplots" aria-label="持仓量副图">
              {oiSubLoading || oiSubErr ? (
                <p className="pattern-oi-subplots-status">
                  {oiSubLoading ? "加载持仓量指标…" : oiSubErr}
                </p>
              ) : null}
              <div className="pattern-oi-sub">
                <div className="pattern-oi-sub-label">持仓量 OI</div>
                <div className="pattern-oi-sub-canvas" ref={oiChartElRef} />
              </div>
              <div className="pattern-oi-sub">
                <div className="pattern-oi-sub-label">现货净买入</div>
                <div className="pattern-oi-sub-canvas" ref={spotNetElRef} />
              </div>
              <div className="pattern-oi-sub">
                <div className="pattern-oi-sub-label">合约净买入</div>
                <div className="pattern-oi-sub-canvas" ref={futNetElRef} />
              </div>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  );
});
