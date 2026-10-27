export type TrainTimeframe = "5m" | "15m" | "1h" | "4h" | "1d";

export type TrainPresetId = "naked" | "structure" | "full";

export interface CapitalConfig {
  initialBalance: number;
  defaultOrderUsdt: number;
  feeRate: number;
  allowChangePerTrade: boolean;
  maxRiskPct: number;
  requireStopLoss: boolean;
  /** 合约杠杆，默认 20x */
  leverage: number;
}

export interface TrainConfig {
  symbols: string[];
  timeframes: TrainTimeframe[];
  lookbackBars: number;
  sessionBars: number;
  /** 剩余可见 K 线 ≤ 此值时预加载下一批 */
  extendThresholdBars: number;
  randomizeSymbol: boolean;
  randomizeTimeframe: boolean;
  randomizeStart: boolean;
  hideSymbol: boolean;
  hideDate: boolean;
  preset: TrainPresetId;
  indicators: {
    ma: number[];
    volume: boolean;
    extraOff: boolean;
  };
  capital: CapitalConfig;
}

export interface Candle {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
}

export type MarketState = "uptrend" | "downtrend" | "range" | "chaos";
export type Bias = "long" | "short" | "flat";

export interface Judgment {
  atBar: number;
  market: MarketState;
  bias: Bias;
  keyHigh?: number;
  keyLow?: number;
  note: string;
  createdAt: number;
}

export type TradeSide = "long" | "short";
export type TradeResult = "win" | "loss" | "be" | "open";

export interface SimTrade {
  id: string;
  side: TradeSide;
  entryBar: number;
  entry: number;
  sl?: number;
  tp?: number;
  exitBar?: number;
  exit?: number;
  reasonIn: string;
  reasonOut?: string;
  rMultiple?: number;
  result?: TradeResult;
  orderUsdt: number;
  qty: number;
  fee: number;
  pnlUsdt?: number;
  balanceAfter?: number;
}

export interface TrainReview {
  reviewNote: string;
  processScore: 1 | 2 | 3 | 4 | 5;
  savedAt: number;
}

export type TrainDisplayTf = "15m" | "1h" | "4h";

export interface TrainSession {
  id: string;
  symbol: string;
  timeframe: TrainTimeframe;
  startTs: number;
  visibleCount: number;
  candles: Candle[];
  /** 15m / 1h / 4h 同段历史；推进以 15m visibleCount 为准 */
  candlesByTf?: Partial<Record<TrainDisplayTf, Candle[]>>;
  judgments: Judgment[];
  trades: SimTrade[];
  status: "running" | "ended";
  createdAt: number;
  endedAt?: number;
  config: TrainConfig;
  capital: CapitalConfig;
  balance: number;
  review?: TrainReview;
  /** 违规：未填判断就推进的次数 */
  skipJudgmentCount: number;
  /** 统计标记：是否带指标提示 */
  taggedWithHints: boolean;
}

export interface TrainStatsSummary {
  completedSessions: number;
  tradedSessions: number;
  totalPnlUsdt: number;
  totalPnlPct: number;
  avgPnlPerSession: number;
  maxDrawdownUsdt: number;
  maxDrawdownPct: number;
  trendHits: number;
  trendTotal: number;
  dirHits: number;
  dirTotal: number;
  sessionsWithJudgment: number;
  avgR: number;
  rSampleCount: number;
}

export interface TrainSessionCardView {
  id: string;
  symbolLabel: string;
  timeframe: string;
  pnlUsdt: number;
  pnlPct: number | null;
  passCount: number;
  visibleBars: number;
  totalBars: number;
  tradeCount: number;
  watchOnly: boolean;
  wins: number;
  losses: number;
  longCount: number;
  shortCount: number;
  maxSinglePnlUsdt: number;
  singleTradeLine: string | null;
  tradeLines: { index: number; line: string }[];
  endedAt: number;
}
