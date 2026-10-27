/**
 * 扫流动性 / 反转持续性评分 — 与后端 strategy/sweep_momentum.py 对齐。
 * 输入：形态页已有的 candles + oiByTime，不额外请求交易所。
 */
import type { PatternCandle } from "../types";

const VOL_LOOKBACK = 14;
const OI_FLUSH_PCT = -1.5;
const OI_ATTACK_PCT = 2.0;
const VOL_SPIKE_MULT = 2.0;
const SWEEP_WICK_RATIO = 0.5;

export interface SweepMomentumReport {
  symbol?: string;
  timestamp?: string | null;
  price_close: number;
  vol_ratio: number;
  oi_delta_pct: number | null;
  sustainability_score: number;
  signal_type: "看涨反转扫荡" | "看跌反转扫荡" | "普通震荡";
  is_bullish_sweep: boolean;
  is_bearish_sweep: boolean;
  lower_shadow_ratio: number;
  upper_shadow_ratio: number;
  body_ratio: number;
  reasons: string[];
}

export function evaluateSweepMomentum(
  candles: PatternCandle[],
  opts?: {
    oiByTime?: Map<number, number>;
    symbol?: string;
  },
): SweepMomentumReport | null {
  const n = candles.length;
  if (n < 2) return null;
  const i = n - 1;
  const cur = candles[i];
  const o = cur.open;
  const h = cur.high;
  const l = cur.low;
  const c = cur.close;
  const totalRange = h - l;
  if (!(totalRange > 0) || ![o, h, l, c].every(Number.isFinite)) return null;

  const body = Math.abs(c - o);
  const lowerShadow = Math.min(o, c) - l;
  const upperShadow = h - Math.max(o, c);

  const start = Math.max(0, i - VOL_LOOKBACK);
  let volSum = 0;
  let volN = 0;
  for (let j = start; j < i; j++) {
    const v = candles[j].volume ?? 0;
    if (v > 0) {
      volSum += v;
      volN += 1;
    }
  }
  const avgVol = volN > 0 ? volSum / volN : 0;
  const curVol = cur.volume ?? 0;
  const volRatio = avgVol > 0 ? curVol / avgVol : 0;

  let oiDeltaPct: number | null = null;
  const oiMap = opts?.oiByTime;
  if (oiMap) {
    const prev = candles[i - 1];
    const curOi = oiMap.get(cur.time);
    const prevOi = oiMap.get(prev.time);
    if (
      curOi != null &&
      prevOi != null &&
      prevOi > 0 &&
      Number.isFinite(curOi) &&
      Number.isFinite(prevOi)
    ) {
      oiDeltaPct = ((curOi - prevOi) / prevOi) * 100;
    }
  }

  const isBullishSweep =
    lowerShadow / totalRange > SWEEP_WICK_RATIO && c > o;
  const isBearishSweep =
    upperShadow / totalRange > SWEEP_WICK_RATIO && c < o;

  let score = 0;
  const reasons: string[] = [];

  if (isBullishSweep || isBearishSweep) {
    score += 30;
    reasons.push("K线呈现明显长影线探针 (Pinbar/Sweep)");
  }

  if (oiDeltaPct != null) {
    if (oiDeltaPct < OI_FLUSH_PCT) {
      score += 40;
      reasons.push(
        `OI 出现断崖式下跌 (${oiDeltaPct.toFixed(2)}%)，高倍杠杆已被系统强制清算`,
      );
    } else if (oiDeltaPct > OI_ATTACK_PCT) {
      score -= 20;
      reasons.push(
        `OI 不降反升 (+${oiDeltaPct.toFixed(2)}%)，存在主力单边主动开仓对攻风险，易二次击穿`,
      );
    }
  }

  if (volRatio > VOL_SPIKE_MULT) {
    score += 30;
    reasons.push(
      `成交量异常放大 (${volRatio.toFixed(1)}x 均量)，说明对手盘大量承接换手`,
    );
  }

  const signalType: SweepMomentumReport["signal_type"] = isBullishSweep
    ? "看涨反转扫荡"
    : isBearishSweep
      ? "看跌反转扫荡"
      : "普通震荡";

  return {
    symbol: opts?.symbol,
    timestamp: null,
    price_close: c,
    vol_ratio: Math.round(volRatio * 100) / 100,
    oi_delta_pct:
      oiDeltaPct != null ? Math.round(oiDeltaPct * 100) / 100 : null,
    sustainability_score: Math.max(0, Math.min(100, score)),
    signal_type: signalType,
    is_bullish_sweep: isBullishSweep,
    is_bearish_sweep: isBearishSweep,
    lower_shadow_ratio: Math.round((lowerShadow / totalRange) * 1000) / 1000,
    upper_shadow_ratio: Math.round((upperShadow / totalRange) * 1000) / 1000,
    body_ratio: Math.round((body / totalRange) * 1000) / 1000,
    reasons,
  };
}
