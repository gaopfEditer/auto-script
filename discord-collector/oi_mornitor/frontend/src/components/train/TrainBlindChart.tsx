import { memo, useEffect, useMemo, useRef } from "react";
import {
  ColorType,
  CrosshairMode,
  LineStyle,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type SeriesMarker,
  type UTCTimestamp,
} from "lightweight-charts";
import type { Candle, SimTrade } from "../../train/types";
import type { PatternCandle, PatternChartMarker } from "../../types";
import { buildChartFromCandles } from "../../utils/chartIndicators";
import { VOLUME_MA_COLOR, buildVolumeMaData } from "../../utils/chartMaSeries";
import { chartLocalization, chartTimeScaleOptions } from "../../utils/chartLocale";
import {
  COMPACT_MARKER_KINDS,
  STRUCTURE_LINE_KINDS,
  STRUCTURE_MARKER_KINDS,
  type ChartLayers,
} from "../../utils/chartLayers";
import { buildMacdCrossMarkers } from "../../utils/chartMacdMarkers";
import type { VegasKey } from "../../utils/chartTimeframe";
import { chartPriceFormat } from "../../utils/format";
import {
  assertVisiblePriceWindow,
  prepareTrainCandlesForChart,
} from "../../train/candleSanitize";

const VEGAS_SERIES: { key: VegasKey; color: string }[] = [
  { key: "filter", color: "rgba(0, 230, 118, 0.85)" },
  { key: "a1", color: "rgba(33, 150, 243, 0.75)" },
  { key: "a2", color: "rgba(33, 150, 243, 0.45)" },
  { key: "b1", color: "rgba(239, 83, 80, 0.75)" },
  { key: "b2", color: "rgba(239, 83, 80, 0.45)" },
];

const MACD_H = 0.24;
const VOL_IN_MAIN = 0.28;
const COMPACT_MARKER_SIZE = 0.5;

function toPattern(c: Candle): PatternCandle {
  return { time: c.t, open: c.o, high: c.h, low: c.l, close: c.c, volume: c.v };
}

function inferBarSec(candles: Candle[]): number {
  if (candles.length < 2) return 900;
  const gaps: number[] = [];
  for (let i = 1; i < Math.min(candles.length, 40); i++) {
    const g = candles[i]!.t - candles[i - 1]!.t;
    if (g > 0) gaps.push(g);
  }
  if (!gaps.length) return 900;
  gaps.sort((a, b) => a - b);
  return gaps[Math.floor(gaps.length / 2)] ?? 900;
}

function toMainScaleLine(
  pts: { time: number; value: number }[],
  timeSet: Set<number>,
): { time: UTCTimestamp; value: number }[] {
  return pts
    .filter(
      (p) =>
        timeSet.has(p.time) &&
        Number.isFinite(p.value) &&
        p.value > 0,
    )
    .map((p) => ({ time: p.time as UTCTimestamp, value: p.value }));
}

function volumeAutoscaleInfoProvider(
  original: () => { priceRange: { minValue: number; maxValue: number } | null } | null,
) {
  const res = original();
  if (!res?.priceRange) return res;
  const max = Math.max(res.priceRange.maxValue, 0);
  return { priceRange: { minValue: 0, maxValue: max <= 0 ? 1 : max / 0.85 } };
}

function macdAutoscaleInfoProvider(
  original: () => { priceRange: { minValue: number; maxValue: number } | null } | null,
) {
  const res = original();
  if (!res?.priceRange) return res;
  const { minValue, maxValue } = res.priceRange;
  const amp = Math.max(Math.abs(minValue), Math.abs(maxValue), 1e-12);
  return { priceRange: { minValue: -amp / 0.85, maxValue: amp / 0.85 } };
}

function ohlcRange(bars: Candle[]): { min: number; max: number } | null {
  let min = Infinity;
  let max = -Infinity;
  for (const c of bars) {
    if (!(c.l > 0 && c.h > 0)) continue;
    min = Math.min(min, c.l);
    max = Math.max(max, c.h);
  }
  if (!Number.isFinite(min) || !Number.isFinite(max) || min <= 0) return null;
  const pad = Math.max((max - min) * 0.06, max * 0.0005);
  return { min: min - pad, max: max + pad };
}

function applyPaneMargins(chart: IChartApi, layers: ChartLayers) {
  const mainBottom = layers.macd ? MACD_H : 0.04;
  const mainTop = 0.03;
  const mainSpan = 1 - mainTop - mainBottom;
  const volTop = mainTop + mainSpan * (1 - (layers.volume ? VOL_IN_MAIN : 0));
  chart.priceScale("right").applyOptions({ scaleMargins: { top: mainTop, bottom: mainBottom } });
  chart.priceScale("volume").applyOptions({
    scaleMargins: layers.volume
      ? { top: volTop, bottom: mainBottom }
      : { top: 0.95, bottom: 0 },
    borderVisible: false,
  });
  chart.priceScale("macd").applyOptions({
    scaleMargins: layers.macd
      ? { top: 1 - MACD_H + 0.02, bottom: 0.02 }
      : { top: 0.95, bottom: 0 },
    borderVisible: false,
  });
}

function toCandleMarkers(
  markers: PatternChartMarker[],
  layers: ChartLayers,
  candleTimes: Set<number>,
): SeriesMarker<UTCTimestamp>[] {
  return markers
    .filter((m) => {
      const kind = m.kind ?? "";
      if (!layers.candlePattern && COMPACT_MARKER_KINDS.has(kind)) return false;
      if (!layers.structure && STRUCTURE_MARKER_KINDS.has(kind)) return false;
      return candleTimes.has(m.time);
    })
    .map((m) => {
      const kind = m.kind ?? "";
      const compact = COMPACT_MARKER_KINDS.has(kind);
      return {
        time: m.time as UTCTimestamp,
        position: m.position,
        color: m.color,
        shape: m.shape,
        text: m.text || undefined,
        size: m.size ?? (compact ? COMPACT_MARKER_SIZE : 1),
      } as SeriesMarker<UTCTimestamp>;
    })
    .sort((a, b) => (a.time as number) - (b.time as number));
}

interface Props {
  candles: Candle[];
  visibleCount: number;
  revealAll?: boolean;
  layers: ChartLayers;
  trades?: SimTrade[];
  pickPriceMode?: "high" | "low" | "none";
  onPickPrice?: (price: number) => void;
  showTrades?: boolean;
  highlightTradeId?: string | null;
}

export const TrainBlindChart = memo(function TrainBlindChart({
  candles,
  visibleCount,
  revealAll = false,
  layers,
  trades = [],
  pickPriceMode = "none",
  onPickPrice,
  showTrades = false,
  highlightTradeId = null,
}: Props) {
  const outerRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLDivElement>(null);
  const crosshairPriceRef = useRef<HTMLDivElement>(null);
  const lastCloseRef = useRef(0);
  const priceDecimalsRef = useRef(2);
  const chartRef = useRef<IChartApi | null>(null);
  const candleRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const upperRef = useRef<ISeriesApi<"Line"> | null>(null);
  const midRef = useRef<ISeriesApi<"Line"> | null>(null);
  const lowerRef = useRef<ISeriesApi<"Line"> | null>(null);
  const vegasRefs = useRef<Partial<Record<VegasKey, ISeriesApi<"Line">>>>({});
  const volRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const volMaRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdHistRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const macdLineRef = useRef<ISeriesApi<"Line"> | null>(null);
  const macdSignalRef = useRef<ISeriesApi<"Line"> | null>(null);
  const priceLinesRef = useRef<ReturnType<ISeriesApi<"Candlestick">["createPriceLine"]>[]>([]);
  const builtRef = useRef<ReturnType<typeof buildChartFromCandles> | null>(null);
  const layersRef = useRef(layers);
  layersRef.current = layers;
  const visibleForScaleRef = useRef<Candle[]>([]);

  const sliceEnd = revealAll ? candles.length : Math.min(visibleCount, candles.length);
  const visible = useMemo(() => {
    const barSec = inferBarSec(candles);
    return prepareTrainCandlesForChart(candles, sliceEnd, barSec);
  }, [candles, sliceEnd]);

  useEffect(() => {
    const el = canvasRef.current;
    const outer = outerRef.current;
    if (!el) return;

    const chart = createChart(el, {
      width: el.clientWidth,
      height: el.clientHeight || 420,
      layout: {
        background: { type: ColorType.Solid, color: "#0a0a0a" },
        textColor: "#9e9e9e",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#1e1e1e" },
        horzLines: { color: "#1e1e1e" },
      },
      rightPriceScale: { borderColor: "#2a2a2a" },
      localization: chartLocalization,
      timeScale: { borderColor: "#2a2a2a", ...chartTimeScaleOptions },
      crosshair: {
        mode: CrosshairMode.Normal,
        horzLine: { labelVisible: false },
      },
    });

    const candle = chart.addCandlestickSeries({
      upColor: "#00e676",
      downColor: "#ff5252",
      borderVisible: false,
      wickUpColor: "#00e676",
      wickDownColor: "#ff5252",
      autoscaleInfoProvider: () => {
        const range = ohlcRange(visibleForScaleRef.current);
        if (!range) return null;
        return {
          priceRange: {
            minValue: range.min,
            maxValue: range.max,
          },
        };
      },
    });

    upperRef.current = chart.addLineSeries({
      color: "rgba(100, 181, 246, 0.45)",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      priceScaleId: "right",
    });
    midRef.current = chart.addLineSeries({
      color: "rgba(255, 193, 7, 0.55)",
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      priceScaleId: "right",
    });
    lowerRef.current = chart.addLineSeries({
      color: "rgba(100, 181, 246, 0.25)",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      priceScaleId: "right",
    });

    for (const { key, color } of VEGAS_SERIES) {
      vegasRefs.current[key] = chart.addLineSeries({
        color,
        lineWidth: key === "filter" ? 2 : 1,
        priceLineVisible: false,
        lastValueVisible: false,
        priceScaleId: "right",
      });
    }

    volRef.current = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "volume",
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: volumeAutoscaleInfoProvider,
    });
    volMaRef.current = chart.addLineSeries({
      priceScaleId: "volume",
      color: VOLUME_MA_COLOR,
      lineWidth: 1,
      lineStyle: LineStyle.Dashed,
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: volumeAutoscaleInfoProvider,
    });

    macdHistRef.current = chart.addHistogramSeries({
      priceScaleId: "macd",
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: macdAutoscaleInfoProvider,
    });
    macdLineRef.current = chart.addLineSeries({
      priceScaleId: "macd",
      color: "rgba(33, 150, 243, 0.9)",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: macdAutoscaleInfoProvider,
    });
    macdSignalRef.current = chart.addLineSeries({
      priceScaleId: "macd",
      color: "rgba(255, 152, 0, 0.9)",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      autoscaleInfoProvider: macdAutoscaleInfoProvider,
    });

    applyPaneMargins(chart, layersRef.current);

    chartRef.current = chart;
    candleRef.current = candle;

    const hideCrosshairPrice = () => {
      const label = crosshairPriceRef.current;
      if (label) label.style.display = "none";
    };

    const onCrosshairMove = (param: {
      point?: { x: number; y: number } | undefined;
      time?: unknown;
    }) => {
      const label = crosshairPriceRef.current;
      const seriesApi = candleRef.current;
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
      if (price == null || !Number.isFinite(Number(price))) {
        hideCrosshairPrice();
        return;
      }
      const d = priceDecimalsRef.current;
      const priceStr =
        d <= 0 ? String(Math.round(Number(price))) : Number(price).toFixed(d);
      const last = lastCloseRef.current;
      if (last > 0) {
        const pctChg = ((Number(price) - last) / last) * 100;
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

    const ro = new ResizeObserver(() => {
      if (canvasRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: canvasRef.current.clientWidth,
          height: canvasRef.current.clientHeight || 420,
        });
      }
    });
    if (outer) ro.observe(outer);

    return () => {
      chart.unsubscribeCrosshairMove(onCrosshairMove);
      ro.disconnect();
      chart.remove();
      chartRef.current = null;
      candleRef.current = null;
      volRef.current = null;
      vegasRefs.current = {};
      priceLinesRef.current = [];
    };
  }, []);

  const applyLayerVisibility = (next: ChartLayers) => {
    upperRef.current?.applyOptions({ visible: next.bb });
    midRef.current?.applyOptions({ visible: next.bb });
    lowerRef.current?.applyOptions({ visible: next.bb });
    volRef.current?.applyOptions({ visible: next.volume });
    volMaRef.current?.applyOptions({ visible: next.volume });
    macdHistRef.current?.applyOptions({ visible: next.macd });
    macdLineRef.current?.applyOptions({ visible: next.macd });
    macdSignalRef.current?.applyOptions({ visible: next.macd });
    if (macdLineRef.current && builtRef.current) {
      macdLineRef.current.setMarkers(
        next.macd
          ? buildMacdCrossMarkers(builtRef.current.macd.line, builtRef.current.macd.signal)
          : [],
      );
    }
    const candle = candleRef.current;
    if (candle && builtRef.current) {
      const times = new Set(visible.map((c) => c.t));
      candle.setMarkers(toCandleMarkers(builtRef.current.markers, next, times));
    }
    if (chartRef.current) applyPaneMargins(chartRef.current, next);
  };

  useEffect(() => {
    applyLayerVisibility(layers);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 仅图层开关
  }, [layers]);

  useEffect(() => {
    const candle = candleRef.current;
    const vol = volRef.current;
    if (!candle || !vol || !visible.length) return;

    visibleForScaleRef.current = visible;
    assertVisiblePriceWindow(visible);

    const patternAll = visible.map(toPattern);
    const built = buildChartFromCandles(patternAll, null);
    builtRef.current = built;
    const timeSet = new Set(visible.map((c) => c.t));

    candle.setData(
      visible.map((c) => ({
        time: c.t as UTCTimestamp,
        open: c.o,
        high: c.h,
        low: c.l,
        close: c.c,
      })),
    );

    candle.setMarkers(toCandleMarkers(built.markers, layersRef.current, timeSet));

    upperRef.current?.setData(toMainScaleLine(built.bb.upper, timeSet));
    midRef.current?.setData(toMainScaleLine(built.bb.mid, timeSet));
    lowerRef.current?.setData(toMainScaleLine(built.bb.lower, timeSet));
    for (const { key } of VEGAS_SERIES) {
      vegasRefs.current[key]?.setData(toMainScaleLine(built.vegas[key] ?? [], timeSet));
    }

    if (layersRef.current.volume) {
      const volPack = buildVolumeMaData(patternAll);
      vol.setData(volPack.bars);
      volMaRef.current?.setData(volPack.ma);
    } else {
      vol.setData([]);
      volMaRef.current?.setData([]);
    }

    const toMacdLine = (pts: { time: number; value: number }[]) =>
      pts
        .filter((p) => timeSet.has(p.time) && Number.isFinite(p.value))
        .map((p) => ({ time: p.time as UTCTimestamp, value: p.value }));
    macdLineRef.current?.setData(toMacdLine(built.macd.line));
    macdSignalRef.current?.setData(toMacdLine(built.macd.signal));
    macdHistRef.current?.setData(
      built.macd.hist
        .filter((p) => timeSet.has(p.time) && Number.isFinite(p.value))
        .map((p) => ({
          time: p.time as UTCTimestamp,
          value: p.value,
          color: p.value >= 0 ? "rgba(0, 230, 118, 0.55)" : "rgba(255, 82, 82, 0.55)",
        })),
    );
    macdLineRef.current?.setMarkers(
      layersRef.current.macd
        ? buildMacdCrossMarkers(built.macd.line, built.macd.signal)
        : [],
    );

    for (const pl of priceLinesRef.current) {
      try {
        candle.removePriceLine(pl);
      } catch {
        /* ignore */
      }
    }
    priceLinesRef.current = [];

    const last = visible[visible.length - 1]?.c ?? 1;
    lastCloseRef.current = last;
    const fmt = chartPriceFormat(last);
    priceDecimalsRef.current = fmt.precision;
    candle.applyOptions({ priceFormat: fmt });

    if (layersRef.current.structure) {
      for (const line of built.price_lines ?? []) {
        const kind = line.kind ?? "";
        if (!STRUCTURE_LINE_KINDS.has(kind)) continue;
        if (!Number.isFinite(line.price) || line.price <= 0) continue;
        priceLinesRef.current.push(
          candle.createPriceLine({
            price: line.price,
            color: line.color,
            lineWidth: 1,
            lineStyle: kind === "trigger" ? 2 : 0,
            axisLabelVisible: true,
            title: line.title,
          }),
        );
      }
    }

    if (showTrades) {
      for (const t of trades) {
        if (t.entryBar >= sliceEnd && !revealAll) continue;
        const hi = highlightTradeId != null && t.id === highlightTradeId;
        const entryColor = hi
          ? "#b8ff3c"
          : t.side === "long"
            ? "#00e676"
            : "#ff5252";
        if (!(t.entry > 0)) continue;
        priceLinesRef.current.push(
          candle.createPriceLine({
            price: t.entry,
            color: entryColor,
            title: t.side === "long" ? "多" : "空",
            lineWidth: hi ? 3 : 1,
            lineStyle: hi ? LineStyle.Solid : LineStyle.Dashed,
          }),
        );
        if (t.sl != null && t.sl > 0) {
          priceLinesRef.current.push(
            candle.createPriceLine({
              price: t.sl,
              color: "#ff5252",
              title: "SL",
              lineStyle: 2,
            }),
          );
        }
        if (t.tp != null && t.tp > 0) {
          priceLinesRef.current.push(
            candle.createPriceLine({
              price: t.tp,
              color: "#64b5f6",
              title: "TP",
              lineStyle: 2,
            }),
          );
        }
        if (t.exit != null && t.exit > 0 && t.result && t.result !== "open") {
          priceLinesRef.current.push(
            candle.createPriceLine({
              price: t.exit,
              color: "#b8ff3c",
              title: "平",
              lineStyle: 3,
              lineWidth: 1,
            }),
          );
        }
      }
    }

    applyLayerVisibility(layersRef.current);
    const ts = chartRef.current?.timeScale();
    if (ts && visible.length > 0) {
      const from = Math.max(0, visible.length - Math.min(visible.length, 220));
      ts.setVisibleLogicalRange({ from, to: visible.length + 1 });
    }
  }, [visible, trades, sliceEnd, revealAll, showTrades, layers, highlightTradeId]);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart || pickPriceMode === "none" || !onPickPrice) return;
    const handler = (param: { point?: { x: number; y: number } }) => {
      if (!param.point) return;
      const price = candleRef.current?.coordinateToPrice(param.point.y);
      if (price != null && Number.isFinite(Number(price))) {
        onPickPrice(Number(price));
      }
    };
    chart.subscribeClick(handler);
    return () => chart.unsubscribeClick(handler);
  }, [pickPriceMode, onPickPrice]);

  return (
    <div
      ref={outerRef}
      className={`train-chart-wrap train-chart-fill pattern-chart-main-pane${pickPriceMode !== "none" ? " is-picking" : ""}`}
      title={pickPriceMode !== "none" ? "点击图表取价" : undefined}
    >
      <div ref={canvasRef} className="pattern-chart-canvas" />
      <div ref={crosshairPriceRef} className="pattern-crosshair-price" aria-hidden />
    </div>
  );
});
