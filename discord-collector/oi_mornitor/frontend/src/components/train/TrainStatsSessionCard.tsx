import { memo } from "react";
import { Link } from "react-router-dom";
import type { TrainSessionCardView } from "../../train/types";

function relativeTime(ts: number): string {
  const d = Date.now() - ts;
  if (d < 60_000) return "刚刚";
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)}h 前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

interface Props {
  card: TrainSessionCardView;
}

export const TrainStatsSessionCard = memo(function TrainStatsSessionCard({ card }: Props) {
  const positive = !card.watchOnly && card.pnlUsdt >= 0;
  const negative = !card.watchOnly && card.pnlUsdt < 0;
  const multi = card.tradeCount > 1;

  return (
    <Link
      to={`/train/review/${card.id}`}
      className={`train-history-card${positive ? " is-win" : ""}${negative ? " is-loss" : ""}${card.watchOnly ? " is-watch" : ""}`}
    >
      <div className="train-history-card-inner">
        <div className="train-history-row train-history-top">
          <span className="train-history-symbol">
            {card.symbolLabel} · {card.timeframe}
          </span>
          <span className={`train-history-pnl${positive ? " up" : ""}${negative ? " down" : ""}`}>
            {card.watchOnly ? "—" : `${card.pnlUsdt >= 0 ? "+" : ""}${card.pnlUsdt.toFixed(1)} U`}
          </span>
        </div>
        <p className="train-history-row train-history-meta">
          过段 {card.passCount}
          {card.totalBars ? ` · ${card.visibleBars}/${card.totalBars} 根` : null}
        </p>
        {card.watchOnly ? (
          <>
            <p className="train-history-row">交易 0 笔 · 仅观看</p>
            <p className="train-history-row train-history-muted">盈亏率 —</p>
          </>
        ) : (
          <>
            <p className="train-history-row">
              盈亏率{" "}
              <span className={positive ? "up" : "down"}>
                {card.pnlPct != null ? `${card.pnlPct >= 0 ? "+" : ""}${card.pnlPct.toFixed(2)}%` : "—"}
              </span>
              <span className="train-history-muted"> · 交易 {card.tradeCount} 笔</span>
              {multi ? (
                <span>
                  {" "}
                  {card.wins}胜{card.losses}负
                </span>
              ) : null}
            </p>
            {card.singleTradeLine ? (
              <p className="train-history-row">{card.singleTradeLine}</p>
            ) : multi ? (
              <>
                <p className="train-history-row">
                  多 {card.longCount} / 空 {card.shortCount} · 最大单笔{" "}
                  {card.maxSinglePnlUsdt >= 0 ? "+" : ""}
                  {card.maxSinglePnlUsdt.toFixed(0)} U
                </p>
                <p className="train-history-row train-history-hover-hint">悬停看明细</p>
              </>
            ) : null}
          </>
        )}
        <p className="train-history-row train-history-time">{relativeTime(card.endedAt)}</p>
      </div>
      {multi ? (
        <div className="train-history-popover" role="tooltip">
          {card.tradeLines.map((t) => (
            <div key={t.index}>{t.line}</div>
          ))}
        </div>
      ) : null}
    </Link>
  );
});
