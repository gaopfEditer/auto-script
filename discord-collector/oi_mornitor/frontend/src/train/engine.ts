import type { Bias, Judgment, MarketState, SimTrade, TrainDisplayTf, TrainSession } from "./types";
import {
  checkBarTriggers,
  classifyTradeResult,
  isOpenTrade,
  markOpenPositions,
  pnlForTrade,
  rMultiple,
} from "./capital";
import { target15mVisibleAfterTfSteps } from "./multiTf";

export const MIN_JUDGMENT_NOTE_LEN = 8;

export function currentBarIndex(session: TrainSession): number {
  return Math.max(0, session.visibleCount - 1);
}

export function canAdvance(session: TrainSession): boolean {
  return session.visibleCount < session.candles.length;
}

export function hasJudgmentForCurrentBar(session: TrainSession): boolean {
  const bar = currentBarIndex(session);
  return session.judgments.some((j) => j.atBar === bar);
}

export function validateJudgmentDraft(
  market: MarketState | "",
  bias: Bias | "",
  note: string,
): string | null {
  if (!market) return "请选择市场状态";
  if (!bias) return "请选择方向";
  if (note.trim().length < MIN_JUDGMENT_NOTE_LEN) {
    return `理由至少 ${MIN_JUDGMENT_NOTE_LEN} 个字`;
  }
  return null;
}

export function addJudgment(
  session: TrainSession,
  draft: Omit<Judgment, "atBar" | "createdAt">,
): TrainSession {
  const err = validateJudgmentDraft(draft.market, draft.bias, draft.note);
  if (err) throw new Error(err);
  const atBar = currentBarIndex(session);
  const next: Judgment = {
    ...draft,
    atBar,
    note: draft.note.trim(),
    createdAt: Date.now(),
  };
  const judgments = [...session.judgments.filter((j) => j.atBar !== atBar), next];
  return { ...session, judgments };
}

function settleTradeOnBar(
  session: TrainSession,
  trade: SimTrade,
  barIndex: number,
): { session: TrainSession; trade: SimTrade } {
  const bar = session.candles[barIndex];
  if (!bar) return { session, trade };
  const triggered = checkBarTriggers(trade, { h: bar.h, l: bar.l, index: barIndex });
  if (!triggered || triggered.exit == null) return { session, trade: triggered ?? trade };
  const { pnl, fee } = pnlForTrade(
    triggered.side,
    triggered.entry,
    triggered.exit,
    triggered.qty,
    session.capital.feeRate,
  );
  const balanceAfter = session.balance + pnl;
  const closed: SimTrade = {
    ...triggered,
    fee,
    pnlUsdt: pnl,
    balanceAfter,
    result: classifyTradeResult(pnl),
  };
  const trades = session.trades.map((t) => (t.id === closed.id ? closed : t));
  return {
    session: { ...session, balance: balanceAfter, trades },
    trade: closed,
  };
}

export function advanceBars(session: TrainSession, steps: number): TrainSession {
  if (steps <= 0) return session;
  if (!canAdvance(session)) return session;

  let s = { ...session };
  const target = Math.min(s.candles.length, s.visibleCount + steps);

  for (let newVisible = s.visibleCount + 1; newVisible <= target; newVisible++) {
    const barIdx = newVisible - 1;
    for (const t of s.trades) {
      if (t.result && t.result !== "open") continue;
      if (t.exitBar != null) continue;
      const res = settleTradeOnBar(s, t, barIdx);
      s = res.session;
    }
    s = { ...s, visibleCount: newVisible };
    s = markOpenPositions(s);
  }
  return s;
}

/** 按图表当前周期步进（1h 模式下走 1 根 = Reveal 下一根 1h，内部逐根结算 15m） */
export function advanceByTimeframe(
  session: TrainSession,
  tf: TrainDisplayTf,
  steps: number,
): TrainSession {
  const target = target15mVisibleAfterTfSteps(session, tf, steps);
  if (target == null || target <= session.visibleCount) return session;
  const steps15 = target - session.visibleCount;
  return advanceBars(session, steps15);
}

export function endSession(session: TrainSession): TrainSession {
  let s: TrainSession = {
    ...session,
    status: "ended",
    endedAt: Date.now(),
    visibleCount: session.candles.length,
  };
  for (let i = 0; i < s.candles.length; i++) {
    for (const t of s.trades) {
      if (t.result && t.result !== "open") continue;
      const res = settleTradeOnBar(s, t, i);
      s = res.session;
    }
  }
  return s;
}

export function closeTradeManual(
  session: TrainSession,
  tradeId: string,
  exitPrice: number,
  reasonOut: string,
): TrainSession {
  const bar = currentBarIndex(session);
  let s = { ...session };
  let changed = false;
  const trades = s.trades.map((t) => {
    if (t.id !== tradeId || !isOpenTrade(t)) return t;
    changed = true;
    const { pnl, fee } = pnlForTrade(t.side, t.entry, exitPrice, t.qty, s.capital.feeRate);
    const balanceAfter = s.balance + pnl;
    s = { ...s, balance: balanceAfter };
    const r = rMultiple(t.side, t.entry, exitPrice, t.sl);
    return {
      ...t,
      exitBar: bar,
      exit: exitPrice,
      reasonOut,
      fee,
      pnlUsdt: pnl,
      balanceAfter,
      rMultiple: r,
      result: classifyTradeResult(pnl),
    };
  });
  if (!changed) return session;
  return markOpenPositions({ ...s, trades });
}

/** 按当前 15m 收盘价市价平仓（可多次开平） */
export function closeTradeAtMark(session: TrainSession, tradeId: string): TrainSession {
  const mark = session.candles[currentBarIndex(session)]?.c;
  if (!mark) return session;
  return closeTradeManual(session, tradeId, mark, "市价平仓");
}

export function closeAllOpenAtMark(session: TrainSession): TrainSession {
  let s = session;
  for (const t of session.trades) {
    if (isOpenTrade(t)) s = closeTradeAtMark(s, t.id);
  }
  return s;
}

export function updateOpenTradeSlTp(
  session: TrainSession,
  tradeId: string,
  patch: { sl?: number | undefined; tp?: number | undefined },
): TrainSession {
  const trades = session.trades.map((t) => {
    if (t.id !== tradeId || !isOpenTrade(t)) return t;
    return {
      ...t,
      ...(patch.sl !== undefined ? { sl: patch.sl } : {}),
      ...(patch.tp !== undefined ? { tp: patch.tp } : {}),
    };
  });
  return { ...session, trades };
}

/** 平掉一半仓位，生成一笔已平记录并保留剩余持仓 */
export function halfCloseTradeAtMark(session: TrainSession, tradeId: string): TrainSession {
  const mark = session.candles[currentBarIndex(session)]?.c;
  if (!mark) return session;
  const t = session.trades.find((x) => x.id === tradeId && isOpenTrade(x));
  if (!t || t.qty <= 0) return session;
  const halfQty = t.qty / 2;
  const halfMargin = t.orderUsdt / 2;
  if (halfQty <= 0 || halfMargin <= 0) return closeTradeAtMark(session, tradeId);

  const bar = currentBarIndex(session);
  let s = { ...session };
  const { pnl, fee } = pnlForTrade(t.side, t.entry, mark, halfQty, s.capital.feeRate);
  const balanceAfter = s.balance + pnl;
  s = { ...s, balance: balanceAfter };

  const closedPart: SimTrade = {
    ...t,
    id: crypto.randomUUID(),
    qty: halfQty,
    orderUsdt: halfMargin,
    exitBar: bar,
    exit: mark,
    reasonOut: "减半平仓",
    fee,
    pnlUsdt: pnl,
    balanceAfter,
    result: classifyTradeResult(pnl),
  };

  const remainQty = t.qty - halfQty;
  const remainMargin = t.orderUsdt - halfMargin;
  const trades = session.trades.map((x) => {
    if (x.id !== tradeId) return x;
    return { ...x, qty: remainQty, orderUsdt: remainMargin, fee: 0, pnlUsdt: undefined };
  });
  return markOpenPositions({ ...s, trades: [...trades, closedPart] });
}

export function reverseTradeAtMark(session: TrainSession, tradeId: string): TrainSession {
  const t = session.trades.find((x) => x.id === tradeId && isOpenTrade(x));
  if (!t) return session;
  const margin = t.orderUsdt;
  const side = t.side === "long" ? ("short" as const) : ("long" as const);
  let s = closeTradeAtMark(session, tradeId);
  const bar = currentBarIndex(s);
  const mark = s.candles[bar]?.c ?? 0;
  if (!mark) return s;
  const lev = s.capital.leverage || 20;
  const qty = (margin * lev) / mark;
  const trade: SimTrade = {
    id: crypto.randomUUID(),
    side,
    entryBar: bar,
    entry: mark,
    reasonIn: side === "long" ? "反手做多" : "反手做空",
    orderUsdt: margin,
    qty,
    fee: 0,
    result: "open",
  };
  return markOpenPositions({ ...s, trades: [...s.trades, trade] });
}

export function firstOpenTradeId(session: TrainSession): string | undefined {
  return session.trades.find((t) => isOpenTrade(t))?.id;
}
