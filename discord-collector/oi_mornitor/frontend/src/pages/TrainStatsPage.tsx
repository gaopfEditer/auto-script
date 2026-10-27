import { useMemo, useState } from "react";
import { TrainStatsSessionCard } from "../components/train/TrainStatsSessionCard";
import { buildSessionCardView, computeAggregateStats, seedDemoSessions } from "../train/stats";
import { listSessions, reclaimTrainStorage, upsertSession } from "../train/storage";
import { displaySymbol } from "../utils/symbol";

const MIN_DIR_TREND_SAMPLE = 3;

function formatSample(hits: number, total: number): string {
  if (total < MIN_DIR_TREND_SAMPLE) return "—";
  const pct = Math.round((hits / total) * 100);
  return `${pct}% (${hits}/${total})`;
}

export function TrainStatsPage() {
  const [tick, setTick] = useState(0);
  const sessions = useMemo(() => listSessions(), [tick]);
  const stats = useMemo(() => computeAggregateStats(sessions), [sessions]);

  const history = useMemo(() => {
    return sessions
      .filter((s) => s.status === "ended")
      .sort((a, b) => (b.endedAt ?? b.createdAt) - (a.endedAt ?? a.createdAt))
      .map((s) => buildSessionCardView(s, displaySymbol(s.symbol)));
  }, [sessions]);

  const loadDemo = () => {
    reclaimTrainStorage(12);
    for (const s of seedDemoSessions()) {
      upsertSession(s);
    }
    setTick((t) => t + 1);
  };

  const judgmentLabel =
    stats.completedSessions > 0
      ? `${stats.sessionsWithJudgment}/${stats.completedSessions}`
      : "—";

  return (
    <div className="train-stats">
      <header className="train-stats-bar">
        <div className="train-stats-bar-main">
          <span>
            <strong>{stats.completedSessions}</strong> 局
          </span>
          <span>
            累计{" "}
            <span className={stats.totalPnlUsdt >= 0 ? "up" : "down"}>
              {stats.tradedSessions
                ? `${stats.totalPnlUsdt >= 0 ? "+" : ""}${stats.totalPnlUsdt.toFixed(1)} U (${stats.totalPnlPct >= 0 ? "+" : ""}${stats.totalPnlPct.toFixed(1)}%)`
                : "—"}
            </span>
          </span>
          <span>
            均局{" "}
            {stats.tradedSessions
              ? `${stats.avgPnlPerSession >= 0 ? "+" : ""}${stats.avgPnlPerSession.toFixed(1)} U`
              : "—"}
          </span>
          <span>
            最大回撤 {stats.maxDrawdownUsdt.toFixed(1)} U ({stats.maxDrawdownPct.toFixed(1)}%)
          </span>
          <span className="train-stats-bar-muted">
            判断 {judgmentLabel} · 方向 {formatSample(stats.dirHits, stats.dirTotal)} · 趋势{" "}
            {formatSample(stats.trendHits, stats.trendTotal)}
            {stats.rSampleCount > 0 ? (
              <>
                {" "}
                · 均R {stats.avgR.toFixed(2)}
              </>
            ) : null}
          </span>
        </div>
        <button type="button" className="ghost train-stats-demo-btn" onClick={loadDemo}>
          载入 10 局假数据
        </button>
      </header>

      {history.length === 0 ? (
        <p className="train-stats-empty">暂无已完成对局，结束训练后会出现在这里。</p>
      ) : (
        <div className="train-history-grid">
          {history.map((card) => (
            <TrainStatsSessionCard key={card.id} card={card} />
          ))}
        </div>
      )}
    </div>
  );
}
