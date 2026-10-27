import { useEffect, useMemo, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { TrainChartPanel } from "../components/train/TrainChartPanel";
import { TrainTradeList } from "../components/train/TrainTradeList";
import { displaySymbol } from "../utils/symbol";
import { computeSessionStats } from "../train/stats";
import { getSession, upsertSession } from "../train/storage";
import type { TrainDisplayTf, TrainReview } from "../train/types";

export function TrainReviewPage() {
  const { id } = useParams<{ id: string }>();
  const nav = useNavigate();
  const session = id ? getSession(id) : undefined;
  const [reviewNote, setReviewNote] = useState("");
  const [processScore, setProcessScore] = useState<1 | 2 | 3 | 4 | 5>(3);
  const [chartTf, setChartTf] = useState<TrainDisplayTf>("15m");

  useEffect(() => {
    if (session?.review) {
      setReviewNote(session.review.reviewNote);
      setProcessScore(session.review.processScore);
    }
  }, [session?.id, session?.review]);

  const metrics = useMemo(
    () => (session ? computeSessionStats(session) : null),
    [session],
  );

  if (!session) {
    return (
      <div className="train-empty">
        <p>找不到该局</p>
        <button type="button" onClick={() => nav("/train?new=1")}>
          新一局
        </button>
      </div>
    );
  }

  const save = () => {
    if (reviewNote.trim().length < 8) {
      alert("请写至少 8 字的复盘");
      return;
    }
    const review: TrainReview = {
      reviewNote: reviewNote.trim(),
      processScore,
      savedAt: Date.now(),
    };
    upsertSession({ ...session, review, status: "ended" });
    nav("/train/stats");
  };

  return (
    <div className="train-review">
      <header className="train-review-head">
        <h1>
          复盘 · {displaySymbol(session.symbol)} · {session.timeframe}
        </h1>
        <p className="train-muted">
          {new Date(session.startTs * 1000).toLocaleString("zh-CN")} ·{" "}
          {session.taggedWithHints ? "带提示" : "裸K/结构"}
        </p>
      </header>

      <div className="train-review-chart train-reveal">
        <TrainChartPanel
          session={session}
          timeframe={chartTf}
          onTimeframeChange={setChartTf}
          revealAll
          trades={session.trades}
        />
      </div>

      {session.trades.length ? (
        <TrainTradeList
          session={session}
          markPrice={session.candles[session.candles.length - 1]?.c ?? 0}
        />
      ) : null}

      {metrics ? (
        <ul className="train-metrics">
          <li>
            趋势判断（随后 20 根）：{metrics.trendHits}/{metrics.trendTotal || "—"}
          </li>
          <li>
            方向偏差：{metrics.dirHits}/{metrics.dirTotal || "—"}
          </li>
          <li>过早进场（写等待却开仓）：{metrics.earlyEntries}</li>
          <li>违规跳过判断：{session.skipJudgmentCount}</li>
        </ul>
      ) : null}

      <ul className="train-judgment-timeline">
        {session.judgments.map((j) => (
          <li key={`${j.atBar}-${j.createdAt}`}>
            bar {j.atBar + 1} · {j.market} · {j.bias} · {j.note}
          </li>
        ))}
      </ul>

      <div className="train-review-form">
        <label>
          这局最大错误 / 最大正确（必填）
          <textarea value={reviewNote} onChange={(e) => setReviewNote(e.target.value)} rows={4} />
        </label>
        <label>
          过程分（1-5，不评盈亏）
          <input
            type="range"
            min={1}
            max={5}
            value={processScore}
            onChange={(e) => setProcessScore(Number(e.target.value) as 1 | 2 | 3 | 4 | 5)}
          />
          {processScore}
        </label>
        <button type="button" onClick={save}>
          保存并查看统计
        </button>
      </div>
    </div>
  );
}
