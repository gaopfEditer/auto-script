import { useCallback, useEffect, useMemo, useState } from "react";
import { Link } from "react-router-dom";
import { MercuHeader } from "../components/MercuHeader";

type SettlementSummary = {
  label?: string;
  mode?: string;
  count: number;
  wins: number;
  losses: number;
  win_rate: number | null;
  tp_sl_settle_win_rate: number | null;
  tp_sl_settled: number;
  expired_ratio: number;
  gross_pct_sum: number;
  fee_pct_sum: number;
  net_pct_sum: number;
  avg_giveback_r: number;
};

type ComparePayload = {
  ok?: boolean;
  trade_count: number;
  fixture?: string;
  source?: string;
  horizon?: {
    count: number;
    h1_win_rate: number | null;
    h4_win_rate: number | null;
    h8_win_rate: number | null;
    note?: string;
  };
  settlements: Record<string, SettlementSummary>;
  modes?: string[];
};

function pct(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

function num(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return "—";
  return n.toFixed(digits);
}

function SummaryCard({ title, s }: { title: string; s: SettlementSummary }) {
  return (
    <div className="btc-settle-card">
      <h3>{title}</h3>
      <dl className="btc-settle-dl">
        <div>
          <dt>笔数</dt>
          <dd>{s.count}</dd>
        </div>
        <div>
          <dt>盈 / 亏</dt>
          <dd>{s.wins} / {s.losses}</dd>
        </div>
        <div>
          <dt>毛 / 费 / 净 %</dt>
          <dd>
            {num(s.gross_pct_sum)} / {num(s.fee_pct_sum)} / <strong>{num(s.net_pct_sum)}</strong>
          </dd>
        </div>
        <div>
          <dt>胜率（净&gt;0）</dt>
          <dd>{pct(s.win_rate)}</dd>
        </div>
        <div>
          <dt>SL/TP 结算胜率</dt>
          <dd title="经止损/止盈/结构出场的子集">{pct(s.tp_sl_settle_win_rate)}</dd>
        </div>
        <div>
          <dt>到期平仓占比</dt>
          <dd>{pct(s.expired_ratio)}</dd>
        </div>
        <div>
          <dt>平均回吐 R</dt>
          <dd>{num(s.avg_giveback_r, 3)}</dd>
        </div>
      </dl>
    </div>
  );
}

export function BtcBacktestView() {
  const [data, setData] = useState<ComparePayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const [view, setView] = useState<"side" | "trail" | "protect">("side");

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const res = await fetch("/api/ai-judge/btc-settlement-compare");
      const json = (await res.json()) as ComparePayload;
      if (!res.ok || json.ok === false) {
        throw new Error("加载失败");
      }
      setData(json);
    } catch (e) {
      setError(e instanceof Error ? e.message : "未知错误");
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const trail = data?.settlements?.entry_sl_tp_trail;
  const protect = data?.settlements?.entry_sl_tp_protect;
  const horizon = data?.horizon;

  const deltaNet = useMemo(() => {
    if (!trail || !protect) return null;
    return protect.net_pct_sum - trail.net_pct_sum;
  }, [trail, protect]);

  return (
    <div className="page-root">
      <MercuHeader />
      <main className="page-main btc-backtest-main">
        <div className="btc-backtest-head">
          <div>
            <h1>AI BTC · 15m 出场对照</h1>
            <p className="muted">
              净盈亏来自 <code>entry_sl_tp_trail</code>（现行 composite，<strong>默认</strong>）与{" "}
              <code>entry_sl_tp_protect</code>（守利润，<strong>仅实验对照</strong>，当前参数未达上线标准）；
              下方 <strong>+1h / +4h / +8h</strong> 仅看收盘价方向，<strong>不受</strong> TP/SL 规则影响。
            </p>
          </div>
          <div className="btc-backtest-actions">
            <Link to="/backtest" className="btn-link">← 结构回测</Link>
            <button type="button" className="btn" onClick={() => void load()} disabled={loading}>
              {loading ? "刷新中…" : "重跑对照"}
            </button>
          </div>
        </div>

        {error && <p className="error-banner">{error}</p>}

        {horizon && (
          <section className="btc-horizon-strip">
            <span>Horizon 胜率（不经 TP/SL）</span>
            <span>+1h {pct(horizon.h1_win_rate)}</span>
            <span>+4h {pct(horizon.h4_win_rate)}</span>
            <span>+8h {pct(horizon.h8_win_rate)}</span>
            <span className="muted">n={horizon.count}</span>
          </section>
        )}

        <div className="btc-view-toggle">
          <button
            type="button"
            className={view === "side" ? "active" : ""}
            onClick={() => setView("side")}
          >
            并排
          </button>
          <button
            type="button"
            className={view === "trail" ? "active" : ""}
            onClick={() => setView("trail")}
          >
            仅 composite
          </button>
          <button
            type="button"
            className={view === "protect" ? "active" : ""}
            onClick={() => setView("protect")}
          >
            仅守利润
          </button>
        </div>

        {data && (
          <p className="muted small">
            来源：{data.source} · {data.fixture ?? "—"} · {data.trade_count} 笔
            {deltaNet != null && (
              <> · 守利润 − composite 净%：<strong>{num(deltaNet)}</strong></>
            )}
          </p>
        )}

        <div className={`btc-settle-grid ${view === "side" ? "side-by-side" : "single"}`}>
          {(view === "side" || view === "trail") && trail && (
            <SummaryCard title={trail.label ?? "现行 composite"} s={trail} />
          )}
          {(view === "side" || view === "protect") && protect && (
            <SummaryCard title={protect.label ?? "守利润 protect"} s={protect} />
          )}
        </div>

        {trail && protect && (
          <table className="btc-compare-table">
            <thead>
              <tr>
                <th>指标</th>
                <th>现行 composite</th>
                <th>守利润 protect</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td>SL/TP 结算胜率</td>
                <td>{pct(trail.tp_sl_settle_win_rate)}</td>
                <td>{pct(protect.tp_sl_settle_win_rate)}</td>
              </tr>
              <tr>
                <td>净% 合计</td>
                <td>{num(trail.net_pct_sum)}</td>
                <td>{num(protect.net_pct_sum)}</td>
              </tr>
              <tr>
                <td>到期占比</td>
                <td>{pct(trail.expired_ratio)}</td>
                <td>{pct(protect.expired_ratio)}</td>
              </tr>
              <tr>
                <td>均回吐 R</td>
                <td>{num(trail.avg_giveback_r, 3)}</td>
                <td>{num(protect.avg_giveback_r, 3)}</td>
              </tr>
            </tbody>
          </table>
        )}

        <section className="btc-backtest-help">
          <h2>本机一键重跑（51 笔或自定义）</h2>
          <pre className="code-block">
{`cd discord-collector
PYTHONPATH=. python3 oi_mornitor/scripts/compare_btc_settlement_modes.py
# 或指定缓存 trades JSON：
PYTHONPATH=. python3 oi_mornitor/scripts/compare_btc_settlement_modes.py --fixture /path/to/your_51_trades.json
curl -s -X POST http://127.0.0.1:8765/api/ai-judge/btc-settlement-compare -d '{"trades":[...]}' | jq .`}
          </pre>
          <p className="muted">
            环境变量 <code>BTC_AI_BACKTEST_FIXTURE</code> 可改默认 fixture 路径；费率默认万 4/边（<code>BTC_BACKTEST_FEE_RATE_PER_SIDE</code>）。
          </p>
        </section>
      </main>
    </div>
  );
}
