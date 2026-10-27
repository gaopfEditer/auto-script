import { useCallback, useEffect, useRef, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { TrainChartPanel } from "../components/train/TrainChartPanel";
import { TrainSidePanel } from "../components/train/TrainSidePanel";
import { displaySymbol } from "../utils/symbol";
import { calcQty, isOpenTrade, markOpenPositions, sessionTotalPnlUsdt } from "../train/capital";
import {
  addJudgment,
  advanceByTimeframe,
  closeTradeAtMark,
  currentBarIndex,
  endSession,
  firstOpenTradeId,
  halfCloseTradeAtMark,
  reverseTradeAtMark,
  updateOpenTradeSlTp,
  validateJudgmentDraft,
} from "../train/engine";
import {
  extendTrainSessionCandles,
  sessionNeedsExtend,
} from "../train/extendSession";
import { canAdvanceTf, candlesForTf, tfVisibleBarIndex } from "../train/multiTf";
import { clearActiveSessionId, getSession, upsertSession } from "../train/storage";
import type { Bias, MarketState, SimTrade, TrainDisplayTf, TrainSession } from "../train/types";

export function TrainSessionPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const [session, setSession] = useState<TrainSession | null>(() =>
    id ? getSession(id) ?? null : null,
  );
  const [market, setMarket] = useState<MarketState | "">("");
  const [bias, setBias] = useState<Bias | "">("");
  const [note, setNote] = useState("");
  const [formErr, setFormErr] = useState("");
  const [orderUsdt, setOrderUsdt] = useState(100);
  const [sl, setSl] = useState<number | undefined>();
  const [tp, setTp] = useState<number | undefined>();
  const [playing, setPlaying] = useState(false);
  const [chartTf, setChartTf] = useState<TrainDisplayTf>("15m");
  const playRef = useRef<number | null>(null);
  const extendingRef = useRef(false);
  const [extending, setExtending] = useState(false);
  const [focusTradeId, setFocusTradeId] = useState<string | null>(null);
  const chartTfRef = useRef(chartTf);
  chartTfRef.current = chartTf;
  const focusTradeIdRef = useRef(focusTradeId);
  focusTradeIdRef.current = focusTradeId;

  const persist = useCallback((s: TrainSession) => {
    setSession(s);
    upsertSession(s);
  }, []);

  const tryExtendSession = useCallback(
    async (s: TrainSession) => {
      if (!sessionNeedsExtend(s) || extendingRef.current) return s;
      extendingRef.current = true;
      setExtending(true);
      try {
        const next = await extendTrainSessionCandles(s);
        if (next.candles.length > s.candles.length) {
          persist(next);
          return next;
        }
        return s;
      } catch (e) {
        setFormErr(e instanceof Error ? e.message : String(e));
        return s;
      } finally {
        extendingRef.current = false;
        setExtending(false);
      }
    },
    [persist],
  );

  useEffect(() => {
    if (!id) return;
    const s = getSession(id);
    if (!s) {
      if (localStorage.getItem("train_active_session_id") === id) {
        clearActiveSessionId();
      }
      setSession(null);
      return;
    }
    let next = s;
    const capPatch: Partial<typeof s.capital> = {};
    if (s.capital.requireStopLoss) capPatch.requireStopLoss = false;
    if (!s.capital.leverage || s.capital.leverage < 1) capPatch.leverage = 20;
    const patchedCap = Object.keys(capPatch).length > 0;
    if (patchedCap) {
      next = { ...s, capital: { ...s.capital, ...capPatch } };
    }
    next = markOpenPositions(next);
    if (patchedCap) upsertSession(next);
    setSession(next);
  }, [id]);

  useEffect(() => {
    if (!session) return;
    setOrderUsdt(session.capital.defaultOrderUsdt);
  }, [session?.id]);

  const justAdvance = useCallback(
    (steps: number) => {
      if (!session || session.status !== "running") return;
      setFormErr("");
      try {
        let s = session;
        const jErr =
          market && bias && note.trim().length >= 8
            ? validateJudgmentDraft(market, bias, note)
            : "skip";
        if (!jErr && market && bias && note.trim().length >= 8) {
          s = addJudgment(s, {
            market: market as MarketState,
            bias: bias as Bias,
            note,
          });
        }
        const tf = chartTfRef.current;
        if (!canAdvanceTf(s, tf)) {
          setPlaying(false);
          return;
        }
        s = advanceByTimeframe(s, tf, steps);
        persist(s);
        void tryExtendSession(s);
        if (!canAdvanceTf(s, tf)) {
          setPlaying(false);
        }
      } catch (e) {
        setFormErr(e instanceof Error ? e.message : String(e));
      }
    },
    [session, market, bias, note, persist, nav, tryExtendSession],
  );

  useEffect(() => {
    if (!session || session.status !== "running") return;
    if (sessionNeedsExtend(session)) {
      void tryExtendSession(session);
    }
  }, [session?.visibleCount, session?.candles.length, session?.id, session?.status, tryExtendSession]);

  const openTrade = useCallback(
    (side: "long" | "short") => {
      if (!session) return;
      const bar = currentBarIndex(session);
      const entry = session.candles[bar]?.c ?? 0;
      const usdt =
        orderUsdt > 0 ? orderUsdt : session.capital.defaultOrderUsdt || 100;
      const lev = session.capital.leverage || 20;
      const qty = calcQty(usdt, entry || 1, lev);
      const trade: SimTrade = {
        id: crypto.randomUUID(),
        side,
        entryBar: bar,
        entry,
        sl,
        tp,
        reasonIn: side === "long" ? "做多" : "做空",
        orderUsdt: usdt,
        qty,
        fee: 0,
        result: "open",
      };
      persist(markOpenPositions({ ...session, trades: [...session.trades, trade] }));
      setFocusTradeId(trade.id);
      setFormErr("");
    },
    [session, orderUsdt, sl, tp, persist],
  );

  const resolveActionTradeId = useCallback(
    (s: TrainSession) => {
      const id = focusTradeIdRef.current;
      if (id && s.trades.some((t) => t.id === id && isOpenTrade(t))) return id;
      return firstOpenTradeId(s);
    },
    [],
  );

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!session || session.status !== "running") return;
      if (e.target instanceof HTMLInputElement || e.target instanceof HTMLTextAreaElement) {
        if (e.key !== "Escape") return;
      }
      if (e.key === "Escape") {
        const ended = endSession(session);
        persist(ended);
        nav(`/train/review/${ended.id}`);
      } else if (e.key === " ") {
        e.preventDefault();
        justAdvance(1);
      } else if (e.key === "1") justAdvance(1);
      else if (e.key === "5") justAdvance(5);
      else if (e.key === "l" || e.key === "L") openTrade("long");
      else if (e.key === "s" || e.key === "S") openTrade("short");
      else if (e.key === "c" || e.key === "C") {
        const tid = resolveActionTradeId(session);
        if (tid) persist(closeTradeAtMark(session, tid));
      } else if (e.key === "x" || e.key === "X") {
        const tid = resolveActionTradeId(session);
        if (tid) {
          const next = reverseTradeAtMark(session, tid);
          persist(next);
          const openId = firstOpenTradeId(next);
          if (openId) setFocusTradeId(openId);
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [session, justAdvance, openTrade, persist, nav, resolveActionTradeId]);

  useEffect(() => {
    if (!playing) {
      if (playRef.current) window.clearInterval(playRef.current);
      playRef.current = null;
      return;
    }
    playRef.current = window.setInterval(() => justAdvance(1), 1200);
    return () => {
      if (playRef.current) window.clearInterval(playRef.current);
    };
  }, [playing, justAdvance]);

  if (!session) {
    return (
      <div className="train-empty">
        <p>找不到该局</p>
        <Link to="/train?new=1">重新开始</Link>
      </div>
    );
  }

  if (session.status === "ended") {
    nav(`/train/review/${session.id}`, { replace: true });
    return null;
  }

  const symLabel = session.config.hideSymbol ? "????" : displaySymbol(session.symbol);
  const bar = tfVisibleBarIndex(session, chartTf);
  const tfCandles = candlesForTf(session, chartTf);
  const mark15 =
    session.candles[currentBarIndex(session)]?.c ??
    tfCandles[bar]?.c ??
    0;
  const lastC = tfCandles[bar]?.c ?? mark15;
  const sessionPnl = sessionTotalPnlUsdt(session);
  const equity = session.capital.initialBalance + sessionPnl;

  return (
    <div className="train-session">
      <header className="train-session-head">
        <div>
          <strong>{symLabel}</strong>
          <span className="train-muted">
            {chartTf} · bar {bar + 1}/{tfCandles.length || session.candles.length}
          </span>
        </div>
        <div className="train-head-actions">
          <Link to="/train?new=1" className="ghost">
            新一局
          </Link>
          <button
            type="button"
            className="ghost"
            onClick={() => {
              const ended = endSession(session);
              persist(ended);
              nav(`/train/review/${ended.id}`);
            }}
          >
            结束 (Esc)
          </button>
        </div>
      </header>

      <div className="train-session-body">
        <div className="train-chart-pane">
          <TrainChartPanel
            session={session}
            timeframe={chartTf}
            onTimeframeChange={setChartTf}
            trades={session.trades}
            highlightTradeId={focusTradeId}
          />
        </div>

        <TrainSidePanel
          session={session}
          chartTf={chartTf}
          advanceMeta={`${bar + 1}/${tfCandles.length} · ${chartTf}`}
          equity={equity}
          sessionPnl={sessionPnl}
          markPrice={mark15}
          lastC={lastC}
          orderUsdt={orderUsdt}
          onOrderUsdt={setOrderUsdt}
          sl={sl}
          tp={tp}
          onSl={setSl}
          onTp={setTp}
          playing={playing}
          onTogglePlay={() => setPlaying((p) => !p)}
          extending={extending}
          formErr={formErr}
          focusTradeId={focusTradeId}
          onFocusTrade={setFocusTradeId}
          onAdvance={justAdvance}
          onOpen={openTrade}
          onClose={(tradeId) => persist(closeTradeAtMark(session, tradeId))}
          onHalf={(tradeId) => persist(halfCloseTradeAtMark(session, tradeId))}
          onReverse={(tradeId) => {
            const next = reverseTradeAtMark(session, tradeId);
            persist(next);
            const openId = firstOpenTradeId(next);
            setFocusTradeId(openId ?? null);
          }}
          onUpdateSlTp={(tradeId, patch) =>
            persist(updateOpenTradeSlTp(session, tradeId, patch))
          }
          market={market}
          bias={bias}
          note={note}
          onMarket={setMarket}
          onBias={setBias}
          onNote={setNote}
        />
      </div>
    </div>
  );
}
