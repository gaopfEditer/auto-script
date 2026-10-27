/** 结算 V2（对齐 pattern_settle_profile.py） */
import type { AlertStatsRecord } from "./patternAlertWinRate";

const VERIFY_MS: Record<string, number> = {
  "15m": 3 * 60 * 60_000,
  "30m": 4 * 60 * 60_000,
  "1h": 6 * 60 * 60_000,
  "4h": 12 * 60 * 60_000,
};
const MCAP_VERIFY_MULT: Record<string, number> = { t1: 1.5, t2: 1, t3: 0.67 };
const ATR_K: Record<string, number> = { t1: 1.5, t2: 2, t3: 2.5 };
const CAP_PCT: Record<string, number> = { t1: 0.02, t2: 0.03, t3: 0.04 };

export type SettlePlanV2 = {
  profileId: string;
  slPrice: number;
  tp1Price: number;
  tp2Price: number;
  batchWeights: [number, number, number];
  runnerTrailPct: number;
  verifyDelayMs: number;
  riskR: number;
  tp1R: number;
  tp2R: number;
};

function preset(typeLabel: string): {
  id: string;
  tp1R: number;
  tp2R: number;
  weights: [number, number, number];
  trail: number;
} {
  const lab = typeLabel;
  if (
    ["二次探底", "Spring", "spring", "流动性掠夺", "顶部结构", "头肩", "M顶", "圆弧"].some((x) =>
      lab.includes(x),
    )
  ) {
    return { id: "structure", tp1R: 1.5, tp2R: 3, weights: [0.3, 0.3, 0.4], trail: 7 };
  }
  if (lab.includes("量价确认") || lab.includes("量价推进")) {
    return { id: "vp_breakout", tp1R: 1, tp2R: 2, weights: [0.4, 0.3, 0.3], trail: 5 };
  }
  if (["高潮反转", "努力无", "努力无果"].some((x) => lab.includes(x))) {
    return { id: "reversal", tp1R: 1, tp2R: 2, weights: [0.5, 0.3, 0.2], trail: 3 };
  }
  return { id: "default", tp1R: 1, tp2R: 2, weights: [0.3, 0.3, 0.4], trail: 5 };
}

export function resolveVerifyDelayMs(rec: Pick<AlertStatsRecord, "interval" | "tradeSymbol" | "symbol" | "assetClass" | "mcapTier">): number {
  const iv = String(rec.interval || "15m").toLowerCase();
  const base = VERIFY_MS[iv] ?? VERIFY_MS["15m"]!;
  const tier = String(rec.mcapTier || "t3").toLowerCase();
  const mult = MCAP_VERIFY_MULT[tier] ?? 1;
  if (rec.assetClass === "equity") return 4 * 60 * 60_000;
  return Math.round(base * mult);
}

export function buildSettlePlanV2(
  rec: AlertStatsRecord,
  atr?: number | null,
): SettlePlanV2 {
  const isShort = rec.side === "short";
  const entry = rec.entry;
  const tier = String(rec.mcapTier || "t3").toLowerCase();
  const atrK = ATR_K[tier] ?? 2;
  const cap = CAP_PCT[tier] ?? 0.03;
  const typeLabel = String(rec.typeLabel || "");
  const iv = String(rec.interval || "15m");

  const invRaw = (rec as { invalid_level?: number; invalidLevel?: number }).invalid_level
    ?? (rec as { invalidLevel?: number }).invalidLevel;
  const invalid = invRaw != null && Number.isFinite(Number(invRaw)) ? Number(invRaw) : null;
  const atrVal = atr != null && atr > 0 ? atr : entry * cap;

  let sl: number;
  let risk: number;
  let tp1: number;
  let tp2: number;

  if (isShort) {
    const cands = [entry * (1 + cap)];
    if (invalid != null && invalid > entry) cands.push(invalid);
    cands.push(entry + atrK * atrVal);
    sl = Math.min(...cands);
    risk = Math.max(sl - entry, entry * 0.001);
    tp1 = entry - risk;
    tp2 = entry - risk * 2;
  } else {
    const cands = [entry * (1 - cap)];
    if (invalid != null && invalid < entry) cands.push(invalid);
    cands.push(entry - atrK * atrVal);
    sl = Math.max(...cands);
    risk = Math.max(entry - sl, entry * 0.001);
    tp1 = entry + risk;
    tp2 = entry + risk * 2;
  }

  const p = preset(typeLabel);
  if (isShort) {
    tp1 = entry - risk * p.tp1R;
    tp2 = entry - risk * p.tp2R;
  } else {
    tp1 = entry + risk * p.tp1R;
    tp2 = entry + risk * p.tp2R;
  }

  return {
    profileId: `${p.id}_${tier}_${iv}`,
    slPrice: sl,
    tp1Price: tp1,
    tp2Price: tp2,
    batchWeights: p.weights,
    runnerTrailPct: p.trail,
    verifyDelayMs: resolveVerifyDelayMs(rec),
    riskR: risk,
    tp1R: p.tp1R,
    tp2R: p.tp2R,
  };
}

export const SETTLE_RULES_SUMMARY_V2 =
  "V2：SL=结构invalid与ATR×k、cap%取更紧 · TP=1R/2R 分类型 · 核实窗按周期×市值梯队 · 观察档默认不计胜率";
