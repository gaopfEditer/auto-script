import { memo, useState } from "react";
import { calcQty, isOpenTrade, tradeDisplayPnl } from "../../train/capital";
import { canAdvanceTf } from "../../train/multiTf";
import type { Bias, MarketState, SimTrade, TrainDisplayTf, TrainSession } from "../../train/types";

interface Props {
  session: TrainSession;
  chartTf: TrainDisplayTf;
  advanceMeta: string;
  equity: number;
  sessionPnl: number;
  markPrice: number;
  lastC: number;
  orderUsdt: number;
  onOrderUsdt: (n: number) => void;
  sl?: number;
  tp?: number;
  onSl: (v: number | undefined) => void;
  onTp: (v: number | undefined) => void;
  playing: boolean;
  onTogglePlay: () => void;
  extending: boolean;
  formErr: string;
  focusTradeId: string | null;
  onFocusTrade: (id: string | null) => void;
  onAdvance: (steps: number) => void;
  onOpen: (side: "long" | "short") => void;
  onClose: (tradeId: string) => void;
  onHalf: (tradeId: string) => void;
  onReverse: (tradeId: string) => void;
  onUpdateSlTp: (tradeId: string, patch: { sl?: number; tp?: number }) => void;
  market: MarketState | "";
  bias: Bias | "";
  note: string;
  onMarket: (m: MarketState | "") => void;
  onBias: (b: Bias | "") => void;
  onNote: (s: string) => void;
}

export const TrainSidePanel = memo(function TrainSidePanel({
  session,
  chartTf,
  advanceMeta,
  equity,
  sessionPnl,
  markPrice,
  lastC,
  orderUsdt,
  onOrderUsdt,
  sl,
  tp,
  onSl,
  onTp,
  playing,
  onTogglePlay,
  extending,
  formErr,
  focusTradeId,
  onFocusTrade,
  onAdvance,
  onOpen,
  onClose,
  onHalf,
  onReverse,
  onUpdateSlTp,
  market,
  bias,
  note,
  onMarket,
  onBias,
  onNote,
}: Props) {
  const [judgmentOpen, setJudgmentOpen] = useState(false);
  const [newSlTpOpen, setNewSlTpOpen] = useState(false);

  const leverage = session.capital.leverage || 20;
  const canAdvance = canAdvanceTf(session, chartTf);
  const openTrades = session.trades.filter((t) => isOpenTrade(t));
  const closedCount = session.trades.length - openTrades.length;
  const hasOpen = openTrades.length > 0;
  const qtyPreview = calcQty(orderUsdt, lastC || 1, leverage);
  const notional = orderUsdt * leverage;

  return (
    <aside className="train-side-panel">
      <div className="train-side-equity">
        <strong>{equity.toFixed(0)}</strong>
        <span className="train-muted"> U</span>
        <span className="train-muted"> · </span>
        <span className={sessionPnl >= 0 ? "up" : "down"}>
          {sessionPnl >= 0 ? "+" : ""}
          {sessionPnl.toFixed(0)}
        </span>
        {hasOpen ? <span className="train-side-equity-hint">含浮盈</span> : null}
      </div>

      <section className="train-side-section train-side-advance">
        <div className="train-advance-row">
          <button type="button" disabled={!canAdvance} onClick={() => onAdvance(1)}>
            下一根 <kbd>Space</kbd>
          </button>
          <button type="button" disabled={!canAdvance} onClick={() => onAdvance(5)}>
            +5 <kbd>5</kbd>
          </button>
          <button type="button" disabled={!canAdvance} onClick={onTogglePlay}>
            {playing ? "暂停" : "播放"}
          </button>
        </div>
        <p className="train-side-meta">
          {advanceMeta}
          {extending ? " · 续载…" : null}
        </p>
      </section>

      <div className="train-side-divider" />

      <section className="train-side-section train-side-positions">
        {hasOpen ? (
          <ul className="train-pos-list">
            {session.trades.map((t, i) => {
              if (!isOpenTrade(t)) return null;
              return (
                <PositionCard
                  key={t.id}
                  index={i + 1}
                  trade={t}
                  markPrice={markPrice}
                  feeRate={session.capital.feeRate}
                  leverage={leverage}
                  focused={focusTradeId === t.id}
                  onFocus={() => onFocusTrade(t.id)}
                  onClose={() => onClose(t.id)}
                  onHalf={() => onHalf(t.id)}
                  onReverse={() => onReverse(t.id)}
                  onUpdateSlTp={(patch) => onUpdateSlTp(t.id, patch)}
                />
              );
            })}
          </ul>
        ) : (
          <p className="train-pos-empty">无持仓{closedCount > 0 ? ` · 已平 ${closedCount} 笔` : ""}</p>
        )}
      </section>

      <div className="train-side-divider" />

      <section
        className={`train-side-section train-side-open${hasOpen ? " is-secondary" : ""}`}
      >
        <div className={`train-order-row${hasOpen ? " compact" : ""}`}>
          <button
            type="button"
            className={hasOpen ? "ghost-long" : "active-long"}
            onClick={() => onOpen("long")}
          >
            {hasOpen ? "再开多" : "做多"} <kbd>L</kbd>
          </button>
          <button
            type="button"
            className={hasOpen ? "ghost-short" : "active-short"}
            onClick={() => onOpen("short")}
          >
            {hasOpen ? "再开空" : "做空"} <kbd>S</kbd>
          </button>
        </div>
        {!hasOpen ? (
          <div className="train-quick-amt">
            {[50, 100, 200, 500].map((n) => (
              <button
                key={n}
                type="button"
                className={orderUsdt === n ? "active" : ""}
                onClick={() => onOrderUsdt(n)}
              >
                {n}
              </button>
            ))}
          </div>
        ) : null}
        <label className="train-order-amt">
          {!hasOpen ? "保证金 U" : "U"}
          <input
            type="number"
            value={orderUsdt}
            onChange={(e) => onOrderUsdt(Number(e.target.value) || 0)}
          />
        </label>
        <p className="train-order-preview">
          {leverage}x · 名义 {notional.toFixed(0)}U · ≈{qtyPreview.toFixed(4)} @ {lastC.toFixed(4)}
        </p>
        {!newSlTpOpen ? (
          <button type="button" className="train-link-btn" onClick={() => setNewSlTpOpen(true)}>
            + 止损止盈
          </button>
        ) : (
          <div className="train-inline-sl-tp">
            <label>
              SL
              <input
                type="number"
                value={sl ?? ""}
                onChange={(e) => onSl(e.target.value ? Number(e.target.value) : undefined)}
              />
            </label>
            <label>
              TP
              <input
                type="number"
                value={tp ?? ""}
                onChange={(e) => onTp(e.target.value ? Number(e.target.value) : undefined)}
              />
            </label>
          </div>
        )}
        {hasOpen ? (
          <p className="train-hint-11">可多次开平、锁仓用再开反向</p>
        ) : null}
      </section>

      <div className="train-side-divider" />

      <section className="train-side-section train-side-judge">
        {!judgmentOpen ? (
          <button type="button" className="train-judge-collapsed" onClick={() => setJudgmentOpen(true)}>
            判断（可选）<span className="train-muted">展开</span>
          </button>
        ) : (
          <>
            <div className="train-judge-head">
              <span>判断（可选）</span>
              <button type="button" className="train-link-btn" onClick={() => setJudgmentOpen(false)}>
                收起
              </button>
            </div>
            <div className="train-seg compact">
              {(["uptrend", "downtrend", "range", "chaos"] as const).map((m) => (
                <button
                  key={m}
                  type="button"
                  className={market === m ? "active" : ""}
                  onClick={() => onMarket(m)}
                >
                  {m}
                </button>
              ))}
            </div>
            <div className="train-seg compact">
              {(["long", "short", "flat"] as const).map((b) => (
                <button
                  key={b}
                  type="button"
                  className={bias === b ? "active" : ""}
                  onClick={() => onBias(b)}
                >
                  {b}
                </button>
              ))}
            </div>
            <textarea
              className="train-judge-note"
              placeholder="8 字内，走下一根时保存"
              value={note}
              onChange={(e) => onNote(e.target.value)}
              rows={2}
            />
          </>
        )}
      </section>

      {formErr ? <p className="train-error">{formErr}</p> : null}
    </aside>
  );
});

function PositionCard({
  index,
  trade,
  markPrice,
  feeRate,
  leverage,
  focused,
  onFocus,
  onClose,
  onHalf,
  onReverse,
  onUpdateSlTp,
}: {
  index: number;
  trade: SimTrade;
  markPrice: number;
  feeRate: number;
  leverage: number;
  focused: boolean;
  onFocus: () => void;
  onClose: () => void;
  onHalf: () => void;
  onReverse: () => void;
  onUpdateSlTp: (patch: { sl?: number; tp?: number }) => void;
}) {
  const [slTpOpen, setSlTpOpen] = useState(false);
  const { pnlUsdt, roePct } = tradeDisplayPnl(trade, markPrice, feeRate);
  const sideLabel = trade.side === "long" ? "多" : "空";
  const notional = trade.orderUsdt * leverage;

  return (
    <li className={`train-pos-card${focused ? " is-focused" : ""}`}>
      <button type="button" className="train-pos-head" onClick={onFocus}>
        <span className="train-trade-idx">#{index}</span>
        <span className={trade.side === "long" ? "up" : "down"}>{sideLabel}</span>
        <span className="train-muted">@{trade.entry.toFixed(4)}</span>
      </button>
      <p className="train-pos-meta">
        名义 {notional.toFixed(0)}U · 保证金 {trade.orderUsdt.toFixed(0)}U · {leverage}x
      </p>
      <p className="train-pos-pnl">
        <span className={pnlUsdt >= 0 ? "up" : "down"}>
          {pnlUsdt >= 0 ? "+" : ""}
          {pnlUsdt.toFixed(2)} U
        </span>
        <span className={roePct >= 0 ? "up" : "down"}>
          {" "}
          {roePct >= 0 ? "+" : ""}
          {roePct.toFixed(2)}%
        </span>
      </p>
      <div className="train-pos-actions">
        <button type="button" className="train-btn-outline" onClick={onClose}>
          平仓 <kbd>C</kbd>
        </button>
        <button type="button" className="train-btn-outline" onClick={onHalf}>
          减半
        </button>
        <button type="button" className="train-btn-secondary" onClick={onReverse}>
          反手 <kbd>X</kbd>
        </button>
      </div>
      {!slTpOpen ? (
        <p className="train-pos-sl-tp">
          止损 {trade.sl != null ? trade.sl.toFixed(4) : "—"} · 止盈{" "}
          {trade.tp != null ? trade.tp.toFixed(4) : "—"}
          <button type="button" className="train-link-btn" onClick={() => setSlTpOpen(true)}>
            + 止损止盈
          </button>
        </p>
      ) : (
        <div className="train-inline-sl-tp">
          <label>
            SL
            <input
              type="number"
              value={trade.sl ?? ""}
              onChange={(e) =>
                onUpdateSlTp({ sl: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </label>
          <label>
            TP
            <input
              type="number"
              value={trade.tp ?? ""}
              onChange={(e) =>
                onUpdateSlTp({ tp: e.target.value ? Number(e.target.value) : undefined })
              }
            />
          </label>
        </div>
      )}
    </li>
  );
}
