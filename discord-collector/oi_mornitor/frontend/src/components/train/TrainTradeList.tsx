import { memo } from "react";
import { isOpenTrade, tradeDisplayPnl } from "../../train/capital";
import type { SimTrade, TrainSession } from "../../train/types";

interface Props {
  session: TrainSession;
  markPrice: number;
  onClose?: (tradeId: string) => void;
  onCloseAll?: () => void;
}

export const TrainTradeList = memo(function TrainTradeList({
  session,
  markPrice,
  onClose,
  onCloseAll,
}: Props) {
  const openCount = session.trades.filter((t) => isOpenTrade(t)).length;
  if (!session.trades.length) return null;

  return (
    <div className="train-trades-block">
      <div className="train-trades-head">
        <span>成交记录 ({session.trades.length})</span>
        {openCount > 1 && onCloseAll ? (
          <button type="button" className="train-close-all" onClick={onCloseAll}>
            全平
          </button>
        ) : null}
      </div>
      <ul className="train-trade-list">
        {session.trades.map((t, i) => (
          <TrainTradeRow
            key={t.id}
            index={i + 1}
            trade={t}
            markPrice={markPrice}
            feeRate={session.capital.feeRate}
            onClose={onClose}
          />
        ))}
      </ul>
    </div>
  );
});

function TrainTradeRow({
  index,
  trade,
  markPrice,
  feeRate,
  onClose,
}: {
  index: number;
  trade: SimTrade;
  markPrice: number;
  feeRate: number;
  onClose?: (id: string) => void;
}) {
  const { pnlUsdt, roePct, isOpen } = tradeDisplayPnl(trade, markPrice, feeRate);
  const sideLabel = trade.side === "long" ? "多" : "空";

  return (
    <li className={`train-trade-item${isOpen ? " is-open" : ""}`}>
      <div className="train-trade-main">
        <span className="train-trade-idx">#{index}</span>
        <span className={trade.side === "long" ? "up" : "down"}>{sideLabel}</span>
        <span className="train-muted">@ {trade.entry.toFixed(4)}</span>
        <span className="train-muted">· {trade.orderUsdt.toFixed(0)}U</span>
        {!isOpen && trade.exit != null ? (
          <span className="train-muted"> → {trade.exit.toFixed(4)}</span>
        ) : null}
      </div>
      <div className="train-trade-pnl">
        <span className={roePct >= 0 ? "up" : "down"}>
          {roePct >= 0 ? "+" : ""}
          {roePct.toFixed(2)}%
        </span>
        <span className={pnlUsdt >= 0 ? "up" : "down"}>
          {" "}
          ({pnlUsdt >= 0 ? "+" : ""}
          {pnlUsdt.toFixed(2)} U{isOpen ? " 浮" : ""})
        </span>
        {isOpen && onClose ? (
          <button type="button" className="train-close-one" onClick={() => onClose(trade.id)}>
            平仓
          </button>
        ) : (
          <span className="train-muted"> · {trade.result ?? "—"}</span>
        )}
      </div>
    </li>
  );
}
