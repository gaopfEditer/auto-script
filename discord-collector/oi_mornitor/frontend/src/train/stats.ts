import { tradeRoePct } from "./capital";
import { DEFAULT_TRAIN_CONFIG } from "./defaults";
import { extendBatch15mForSession } from "./extendSession";
import type { SimTrade, TrainSession, TrainSessionCardView, TrainStatsSummary } from "./types";

function trendLabel(candles: { h: number; l: number }[]): "up" | "down" | "range" {
  if (candles.length < 2) return "range";
  let hh = 0;
  let ll = 0;
  for (let i = 1; i < candles.length; i++) {
    if (candles[i].h > candles[i - 1].h) hh++;
    if (candles[i].l < candles[i - 1].l) ll++;
  }
  if (hh >= candles.length * 0.55 && ll < candles.length * 0.35) return "up";
  if (ll >= candles.length * 0.55 && hh < candles.length * 0.35) return "down";
  return "range";
}

function mapMarketToTrend(m: string): "up" | "down" | "range" | "chaos" {
  if (m === "uptrend") return "up";
  if (m === "downtrend") return "down";
  if (m === "range") return "range";
  return "chaos";
}

function forwardDirection(candles: { c: number }[], from: number, n: number): "long" | "short" | "flat" {
  const slice = candles.slice(from + 1, from + 1 + n);
  if (!slice.length) return "flat";
  const start = candles[from]?.c;
  const end = slice[slice.length - 1]?.c;
  if (!start || !end) return "flat";
  const pct = ((end - start) / start) * 100;
  if (pct > 0.15) return "long";
  if (pct < -0.15) return "short";
  return "flat";
}

export function computeSessionStats(session: TrainSession): {
  trendHits: number;
  trendTotal: number;
  dirHits: number;
  dirTotal: number;
  earlyEntries: number;
  tradeCount: number;
} {
  let trendHits = 0;
  let trendTotal = 0;
  let dirHits = 0;
  let dirTotal = 0;
  let earlyEntries = 0;

  for (const j of session.judgments) {
    const fwd = session.candles.slice(j.atBar + 1, j.atBar + 21);
    if (fwd.length >= 10) {
      trendTotal++;
      const actual = trendLabel(fwd);
      const expected = mapMarketToTrend(j.market);
      if (expected !== "chaos" && actual === expected) trendHits++;
    }
    if (fwd.length >= 10 && j.bias !== "flat") {
      dirTotal++;
      const fd = forwardDirection(session.candles, j.atBar, 20);
      if (fd === j.bias) dirHits++;
    }
    if (j.bias === "flat") {
      const opened = session.trades.some(
        (t) => t.entryBar === j.atBar || t.entryBar === j.atBar + 1,
      );
      if (opened) earlyEntries++;
    }
  }

  return {
    trendHits,
    trendTotal,
    dirHits,
    dirTotal,
    earlyEntries,
    tradeCount: session.trades.filter((t) => t.result && t.result !== "open").length,
  };
}

export function closedTrades(session: TrainSession): SimTrade[] {
  return session.trades.filter((t) => t.result && t.result !== "open");
}

export function sessionPassCount(session: TrainSession): number {
  const initial = session.config.lookbackBars + session.config.sessionBars;
  const batch = extendBatch15mForSession(session);
  if (session.candles.length <= initial) return 1;
  return 1 + Math.ceil((session.candles.length - initial) / batch);
}

export function sessionPnlUsdt(session: TrainSession): number {
  return session.balance - session.capital.initialBalance;
}

function formatTradeSide(side: SimTrade["side"]): string {
  return side === "long" ? "多" : "空";
}

function formatTradeDetailLine(index: number, t: SimTrade): string {
  const side = formatTradeSide(t.side);
  const pnl = t.pnlUsdt ?? 0;
  const roe = tradeRoePct(t, pnl);
  const exit = t.exit != null ? "平" : "—";
  const pnlStr = `${pnl >= 0 ? "+" : ""}${pnl.toFixed(1)} U`;
  return `#${index} ${side} @${t.entry.toFixed(2)}  ${exit}  ${pnlStr} (${roe >= 0 ? "+" : ""}${roe.toFixed(1)}%)`;
}

export function buildSessionCardView(
  session: TrainSession,
  symbolLabel: string,
): TrainSessionCardView {
  const closed = closedTrades(session);
  const watchOnly = closed.length === 0;
  const initial = session.capital.initialBalance;
  const pnlUsdt = watchOnly ? 0 : sessionPnlUsdt(session);
  const pnlPct = watchOnly ? null : (pnlUsdt / initial) * 100;

  let wins = 0;
  let losses = 0;
  let longCount = 0;
  let shortCount = 0;
  let maxSinglePnlUsdt = 0;
  for (const t of closed) {
    const p = t.pnlUsdt ?? 0;
    if (p > 0.01) wins++;
    else if (p < -0.01) losses++;
    if (t.side === "long") longCount++;
    else shortCount++;
    if (p > maxSinglePnlUsdt) maxSinglePnlUsdt = p;
  }

  const globalIndex = new Map(session.trades.map((t, i) => [t.id, i + 1]));
  const tradeLines = closed.map((t) => ({
    index: globalIndex.get(t.id) ?? 0,
    line: formatTradeDetailLine(globalIndex.get(t.id) ?? 0, t),
  }));

  let singleTradeLine: string | null = null;
  if (closed.length === 1) {
    const t = closed[0]!;
    const pnl = t.pnlUsdt ?? 0;
    const roe = tradeRoePct(t, pnl);
    singleTradeLine = `该笔  ${formatTradeSide(t.side)} @${t.entry.toFixed(2)}  → 平  ${roe >= 0 ? "+" : ""}${roe.toFixed(2)}%`;
  }

  return {
    id: session.id,
    symbolLabel,
    timeframe: session.timeframe,
    pnlUsdt,
    pnlPct,
    passCount: sessionPassCount(session),
    visibleBars: session.visibleCount,
    totalBars: session.candles.length,
    tradeCount: closed.length,
    watchOnly,
    wins,
    losses,
    longCount,
    shortCount,
    maxSinglePnlUsdt,
    singleTradeLine,
    tradeLines,
    endedAt: session.endedAt ?? session.createdAt,
  };
}

export function computeAggregateStats(sessions: TrainSession[]): TrainStatsSummary {
  const ended = sessions.filter((s) => s.status === "ended");
  if (!ended.length) {
    return {
      completedSessions: 0,
      tradedSessions: 0,
      totalPnlUsdt: 0,
      totalPnlPct: 0,
      avgPnlPerSession: 0,
      maxDrawdownUsdt: 0,
      maxDrawdownPct: 0,
      trendHits: 0,
      trendTotal: 0,
      dirHits: 0,
      dirTotal: 0,
      sessionsWithJudgment: 0,
      avgR: 0,
      rSampleCount: 0,
    };
  }

  let trendHits = 0;
  let trendTotal = 0;
  let dirHits = 0;
  let dirTotal = 0;
  let sessionsWithJudgment = 0;
  const rs: number[] = [];
  let totalPnl = 0;
  let tradedSessions = 0;
  let tradedInitialSum = 0;
  let sessionPnlSumForAvg = 0;

  let peak = 0;
  let maxDd = 0;
  let maxDdPct = 0;

  for (const s of ended) {
    if (s.judgments.length > 0) sessionsWithJudgment++;
    const one = computeSessionStats(s);
    trendHits += one.trendHits;
    trendTotal += one.trendTotal;
    dirHits += one.dirHits;
    dirTotal += one.dirTotal;

    const closed = closedTrades(s);
    const sessionPnl = closed.length ? sessionPnlUsdt(s) : 0;
    if (closed.length) {
      tradedSessions++;
      tradedInitialSum += s.capital.initialBalance;
      totalPnl += sessionPnl;
      sessionPnlSumForAvg += sessionPnl;
    }

    let eq = s.capital.initialBalance;
    peak = Math.max(peak, eq);
    for (const t of closed) {
      if (t.pnlUsdt != null) {
        eq += t.pnlUsdt;
        peak = Math.max(peak, eq);
        const dd = peak - eq;
        maxDd = Math.max(maxDd, dd);
        if (peak > 0) maxDdPct = Math.max(maxDdPct, (dd / peak) * 100);
      }
      if (t.rMultiple != null) rs.push(t.rMultiple);
    }
  }

  return {
    completedSessions: ended.length,
    tradedSessions,
    totalPnlUsdt: totalPnl,
    totalPnlPct: tradedInitialSum > 0 ? (totalPnl / tradedInitialSum) * 100 : 0,
    avgPnlPerSession: tradedSessions ? sessionPnlSumForAvg / tradedSessions : 0,
    maxDrawdownUsdt: maxDd,
    maxDrawdownPct: maxDdPct,
    trendHits,
    trendTotal,
    dirHits,
    dirTotal,
    sessionsWithJudgment,
    avgR: rs.length ? rs.reduce((a, b) => a + b, 0) / rs.length : 0,
    rSampleCount: rs.length,
  };
}

export function seedDemoSessions(): TrainSession[] {
  const now = Date.now();
  const out: TrainSession[] = [];
  for (let i = 0; i < 10; i++) {
    const candles = Array.from({ length: 230 }, (_, j) => {
      const base = 100 + Math.sin(j / 8) * 5 + i;
      return {
        t: now / 1000 - (230 - j) * 900,
        o: base,
        h: base + 1,
        l: base - 1,
        c: base + 0.2,
        v: 1000 + j,
      };
    });
    const initial = DEFAULT_TRAIN_CONFIG.capital.initialBalance;
    const hasTrades = i % 3 !== 0;
    const trades: TrainSession["trades"] = [];
    let balance = initial;
    if (hasTrades) {
      const entry = candles[180].c;
      const qty = (100 * 20) / entry;
      const pnl = i % 2 === 0 ? 196 : -42;
      balance = initial + pnl;
      trades.push({
        id: `demo-t-${i}`,
        side: i % 4 === 0 ? "short" : "long",
        entryBar: 180,
        entry,
        exitBar: 200,
        exit: entry * (1 + (i % 2 === 0 ? 0.02 : -0.01)),
        reasonIn: "demo",
        reasonOut: "demo",
        orderUsdt: 100,
        qty,
        fee: 1.2,
        pnlUsdt: pnl,
        balanceAfter: balance,
        result: pnl > 0 ? "win" : "loss",
      });
      if (i === 1) {
        for (let k = 0; k < 4; k++) {
          const e = candles[190 + k].c;
          const pk = k % 2 === 0 ? 12 : -4;
          trades.push({
            id: `demo-t-${i}-${k}`,
            side: k % 2 ? "short" : "long",
            entryBar: 190 + k,
            entry: e,
            exitBar: 195 + k,
            exit: e * 1.001,
            reasonIn: "demo",
            reasonOut: "demo",
            orderUsdt: 50,
            qty: (50 * 20) / e,
            fee: 0.5,
            pnlUsdt: pk,
            result: pk > 0 ? "win" : "loss",
          });
        }
        balance = initial + trades.reduce((a, t) => a + (t.pnlUsdt ?? 0), 0);
      }
    }
    out.push({
      id: `demo-${i}`,
      symbol: i % 2 ? "BTCUSDT" : "BNBUSDT",
      timeframe: i % 5 === 0 ? "4h" : "15m",
      startTs: candles[149].t,
      visibleCount: Math.min(candles.length, 200 + i * 15),
      candles,
      judgments:
        i % 4 === 0
          ? []
          : [
              {
                atBar: 149,
                market: "range",
                bias: "flat",
                note: "等待突破确认后再考虑进场",
                createdAt: now - 3600000,
              },
            ],
      trades,
      status: "ended",
      createdAt: now - 7200000 - i * 600000,
      endedAt: now - 3600000 - i * 900000,
      config: { ...DEFAULT_TRAIN_CONFIG },
      capital: { ...DEFAULT_TRAIN_CONFIG.capital },
      balance,
      skipJudgmentCount: i === 3 ? 1 : 0,
      taggedWithHints: false,
      review: {
        reviewNote: i % 2 ? "过早进场" : "结构位守住了",
        processScore: ((i % 5) + 1) as 1 | 2 | 3 | 4 | 5,
        savedAt: now,
      },
    });
  }
  return out;
}
