import type { CapitalConfig, SimTrade, TradeSide, TrainSession } from "./types";

/** orderUsdt = 保证金；名义 = 保证金 × 杠杆 */
export function calcQty(orderUsdt: number, entry: number, leverage = 20): number {
  if (!entry || !Number.isFinite(entry)) return 0;
  const lev = leverage > 0 ? leverage : 1;
  return (orderUsdt * lev) / entry;
}

export function calcFees(entry: number, exit: number, qty: number, feeRate: number): number {
  return entry * qty * feeRate + exit * qty * feeRate;
}

export function pnlForTrade(
  side: TradeSide,
  entry: number,
  exit: number,
  qty: number,
  feeRate: number,
): { pnl: number; fee: number } {
  const gross =
    side === "long" ? (exit - entry) * qty : (entry - exit) * qty;
  const fee = calcFees(entry, exit, qty, feeRate);
  return { pnl: gross - fee, fee };
}

export function riskUsdt(entry: number, sl: number | undefined, qty: number, feeRate: number): number {
  if (sl == null || !Number.isFinite(sl)) return Infinity;
  const loss = Math.abs(entry - sl) * qty;
  return loss + entry * qty * feeRate * 2;
}

/** 盲K 训练不做风控拦截，始终允许下单 */
export function validateOrderRisk(
  _balance: number,
  _capital: CapitalConfig,
  _entry: number,
  _sl: number | undefined,
  _qty: number,
): string | null {
  return null;
}

export function rMultiple(
  side: TradeSide,
  entry: number,
  exit: number,
  sl: number | undefined,
): number | undefined {
  if (sl == null || !Number.isFinite(sl)) return undefined;
  const risk = Math.abs(entry - sl);
  if (risk <= 0) return undefined;
  const move = side === "long" ? exit - entry : entry - exit;
  return move / risk;
}

/** 当前 bar 收盘价（含手续费估算） */
export function unrealizedPnlUsdt(
  trade: SimTrade,
  markPrice: number,
  feeRate: number,
): number {
  if (!markPrice || !Number.isFinite(markPrice)) return 0;
  return pnlForTrade(trade.side, trade.entry, markPrice, trade.qty, feeRate).pnl;
}

export function isOpenTrade(t: SimTrade): boolean {
  return (!t.result || t.result === "open") && t.exitBar == null;
}

/** 单笔收益率 = 盈亏 / 保证金（%） */
export function tradeRoePct(trade: SimTrade, pnlUsdt: number): number {
  if (!trade.orderUsdt || !Number.isFinite(pnlUsdt)) return 0;
  return (pnlUsdt / trade.orderUsdt) * 100;
}

export function tradeDisplayPnl(
  trade: SimTrade,
  markPrice: number,
  feeRate: number,
): { pnlUsdt: number; roePct: number; isOpen: boolean } {
  const open = isOpenTrade(trade);
  const pnlUsdt = open
    ? unrealizedPnlUsdt(trade, markPrice, feeRate)
    : (trade.pnlUsdt ?? 0);
  return { pnlUsdt, roePct: tradeRoePct(trade, pnlUsdt), isOpen: open };
}

export function classifyTradeResult(pnlUsdt: number): SimTrade["result"] {
  if (pnlUsdt > 0.01) return "win";
  if (pnlUsdt < -0.01) return "loss";
  return "be";
}

/** 推进 K 线后刷新未平仓浮盈浮亏（写入 trade.pnlUsdt） */
export function markOpenPositions(session: TrainSession): TrainSession {
  const bar = session.candles[Math.max(0, session.visibleCount - 1)];
  const mark = bar?.c ?? 0;
  if (!mark) return session;
  const feeRate = session.capital.feeRate;
  const trades = session.trades.map((t) => {
    if (!isOpenTrade(t)) return t;
    const { pnl, fee } = pnlForTrade(t.side, t.entry, mark, t.qty, feeRate);
    return { ...t, pnlUsdt: pnl, fee };
  });
  return { ...session, trades };
}

/** 本局总盈亏 = 已平仓入账 + 未平仓按现价 */
export function sessionTotalPnlUsdt(session: TrainSession): number {
  const mark = session.candles[Math.max(0, session.visibleCount - 1)]?.c ?? 0;
  const feeRate = session.capital.feeRate;
  let total = session.balance - session.capital.initialBalance;
  for (const t of session.trades) {
    if (isOpenTrade(t)) {
      total += unrealizedPnlUsdt(t, mark, feeRate);
    }
  }
  return total;
}

export function checkBarTriggers(
  trade: SimTrade,
  bar: { h: number; l: number; index: number },
): SimTrade | null {
  if (trade.result && trade.result !== "open") return null;
  if (trade.exitBar != null) return null;
  const { side, entry, sl, tp } = trade;
  let hit: "sl" | "tp" | null = null;
  let exit = entry;
  if (side === "long") {
    if (sl != null && bar.l <= sl) {
      hit = "sl";
      exit = sl;
    } else if (tp != null && bar.h >= tp) {
      hit = "tp";
      exit = tp;
    }
  } else {
    if (sl != null && bar.h >= sl) {
      hit = "sl";
      exit = sl;
    } else if (tp != null && bar.l <= tp) {
      hit = "tp";
      exit = tp;
    }
  }
  if (!hit) return null;
  const r = rMultiple(side, entry, exit, sl);
  let result: SimTrade["result"] = "be";
  if (r != null) {
    if (r > 0.05) result = "win";
    else if (r < -0.05) result = "loss";
  }
  return {
    ...trade,
    exitBar: bar.index,
    exit,
    rMultiple: r,
    result,
  };
}
