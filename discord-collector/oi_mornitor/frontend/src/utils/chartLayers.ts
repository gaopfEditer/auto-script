import { VOLUME_MA_PERIOD } from "./chartMaSeries";

export type ChartLayers = {
  bb: boolean;
  volume: boolean;
  macd: boolean;
  candlePattern: boolean;
  structure: boolean;
  /** Vegas 双通道 EMA12/144/169/576/676 */
  vegas: boolean;
  /** 趋势均线 EMA13/33/99/144 */
  ema: boolean;
};

export const DEFAULT_CHART_LAYERS: ChartLayers = {
  bb: true,
  volume: true,
  macd: true,
  candlePattern: true,
  structure: true,
  vegas: true,
  ema: false,
};

/** 主图 EMA 均线（close 上的 ewm） */
export const CHART_EMA_LINES = [
  { key: "e13", period: 13, title: "EMA(13)", color: "rgba(0, 230, 118, 0.88)" },
  { key: "e33", period: 33, title: "EMA(33)", color: "rgba(255, 213, 79, 0.92)" },
  { key: "e99", period: 99, title: "EMA(99)", color: "rgba(186, 104, 200, 0.92)" },
  { key: "e144", period: 144, title: "EMA(144)", color: "rgba(244, 143, 177, 0.92)" },
] as const;

export type ChartEmaKey = (typeof CHART_EMA_LINES)[number]["key"];

/** 训练页与形态图主图一致（无 OI 副图） */
export const TRAIN_CHART_LAYER_TOGGLES: { key: keyof ChartLayers; label: string }[] = [
  { key: "bb", label: "布林" },
  { key: "volume", label: `量能·MA${VOLUME_MA_PERIOD}` },
  { key: "macd", label: "MACD" },
  { key: "candlePattern", label: "K线形态" },
  { key: "structure", label: "形态线" },
  { key: "vegas", label: "维加斯" },
  { key: "ema", label: "均线" },
];

export const STRUCTURE_LINE_KINDS = new Set(["h_max", "lh", "l1", "hl", "trigger"]);

export const COMPACT_MARKER_KINDS = new Set([
  "shooting_star",
  "inverted_hammer",
  "continuous_upper_wick",
  "continuous_lower_wick",
  "continuous_non_upper_wick",
  "continuous_non_lower_wick",
  "oi_anomaly",
]);

export const STRUCTURE_MARKER_KINDS = new Set([
  "h_max",
  "lh",
  "l1",
  "hl",
  "mid_peak",
  "trigger",
  "hh",
  "bb_wick",
]);
