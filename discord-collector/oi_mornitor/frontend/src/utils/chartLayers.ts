import { VOLUME_MA_PERIOD } from "./chartMaSeries";

export type ChartLayers = {
  bb: boolean;
  volume: boolean;
  macd: boolean;
  candlePattern: boolean;
  structure: boolean;
};

export const DEFAULT_CHART_LAYERS: ChartLayers = {
  bb: true,
  volume: true,
  macd: true,
  candlePattern: true,
  structure: true,
};

/** 训练页与形态图主图一致（无 OI 副图） */
export const TRAIN_CHART_LAYER_TOGGLES: { key: keyof ChartLayers; label: string }[] = [
  { key: "bb", label: "布林" },
  { key: "volume", label: `量能·MA${VOLUME_MA_PERIOD}` },
  { key: "macd", label: "MACD" },
  { key: "candlePattern", label: "K线形态" },
  { key: "structure", label: "形态线" },
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
