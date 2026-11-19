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
  /** TD9 超买/超卖（Setup ±9，仅已收盘 K） */
  td9: boolean;
  /** 新高/新低末端+放量（仅已收盘 K） */
  revVol: boolean;
  /** 当前视口可见区间内最高/最低价线 */
  viewportHl: boolean;
  /** 量价炒买/炒卖 → 小级别反转级联（预览） */
  vpCascade: boolean;
  /** 小周期放量 + 大周期射星/倒锤放量（如 15m1h加强） */
  mtfReinforce: boolean;
  /** ST 5m POP 逢高试空（仅 5m 主图，默认关闭） */
  stPopShort: boolean;
  /** 5m 放量影线多空（仅 5m 主图） */
  stVolWick: boolean;
};

export const DEFAULT_CHART_LAYERS: ChartLayers = {
  bb: true,
  volume: true,
  macd: true,
  candlePattern: true,
  structure: true,
  vegas: true,
  ema: false,
  td9: true,
  revVol: true,
  viewportHl: true,
  vpCascade: true,
  mtfReinforce: true,
  stPopShort: false,
  stVolWick: true,
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
  { key: "td9", label: "TD9" },
  { key: "revVol", label: "新高新低放量" },
  { key: "viewportHl", label: "视口高低" },
  { key: "vpCascade", label: "量价级联" },
  { key: "mtfReinforce", label: "多周期加强" },
  { key: "stPopShort", label: "ST短空(5m)" },
  { key: "stVolWick", label: "放量影线(5m)" },
];

export const STRUCTURE_LINE_KINDS = new Set(["h_max", "lh", "l1", "hl", "trigger"]);

export const COMPACT_MARKER_KINDS = new Set([
  "shooting_star",
  "inverted_hammer",
  "continuous_upper_wick",
  "continuous_lower_wick",
  "continuous_non_upper_wick",
  "continuous_non_lower_wick",
  "td9_overbought",
  "td9_oversold",
  "rev_vol_buy",
  "rev_vol_sell",
  "wick_pin_upper",
  "wick_pin_lower",
  "vp_chase_buy",
  "vp_chase_sell",
  "vp_vol_spike",
  "vp_cascade_short",
  "vp_cascade_long",
  "vol_pin_spike",
  "mtf_parent_reversal_bear",
  "mtf_parent_reversal_bull",
  "st_pop_short",
  "st_vol_wick_long",
  "st_vol_wick_short",
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

export { TD9_MARKER_KINDS } from "./tdSequential";
export { REV_VOL_MARKER_KINDS } from "./rangeExtremeVolume";
export { WICK_OI_VOL_MARKER_KINDS } from "./wickOiVolumePin";
export {
  VP_CHASE_MARKER_KINDS,
  VP_VOL_SPIKE_MARKER_KINDS,
  VP_CASCADE_ENTRY_KINDS,
} from "./vpCascadeChartMarkers";
export { MTF_REINFORCE_MARKER_KINDS } from "./mtfVolPatternReinforceMarkers";
export { ST_POP_SHORT_MARKER_KINDS } from "./stPopShortChartMarkers";
export { ST_VOL_WICK_MARKER_KINDS } from "./stVolWickChartMarkers";
