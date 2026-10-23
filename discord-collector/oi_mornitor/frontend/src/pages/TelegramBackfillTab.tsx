import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  alertStatsPnlPct,
  formatAlertStatsTime,
  outcomeLabel,
  type AlertOutcome,
} from "../utils/patternAlertWinRate";

type ChatTarget = { id: string; label: string };
type RangePreset = { id: string; label: string; days: number };

type Summary = {
  total?: number;
  wins?: number;
  losses?: number;
  winRate?: number | null;
  totalPnlPct?: number | null;
};

type BucketRow = Summary & { id: string; label: string; count: number };

type BackfillItem = {
  symbol: string;
  interval: string;
  typeLabel: string;
  side: string;
  signalAt: number;
  entry: number;
  outcome?: string;
  pnlPct?: number | null;
  chatLabel?: string;
};

type BackfillJob = {
  id: string;
  status: string;
  error?: string | null;
  params?: {
    rangeDays?: number;
    sinceMs?: number;
    untilMs?: number;
    mode?: string;
    messageCount?: number;
    parsedCount?: number;
    telethonError?: string;
  };
  progress?: { phase?: string; done?: number; total?: number; current?: string };
  summary?: Summary | null;
  byWeek?: BucketRow[];
  byMonth?: BucketRow[];
  byType?: BucketRow[];
  items?: BackfillItem[];
  itemTotal?: number;
};

type JobListRow = {
  id: string;
  status: string;
  rangeDays?: number;
  startedAt?: number;
  total?: number;
  winRate?: number | null;
};

function fmtPct(v: number | null | undefined): string {
  if v == null || Number.isNaN(v)) return "—";
  return `${(v * 100).toFixed(1)}%`;
}

function fmtPnl(v: number | null | undefined): string {
  if v == null || Number.isNaN(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

function SummaryCards({ summary }: { summary: Summary | null | undefined }) {
  if (!summary) return null;
  return (
    <div className="tg-bf-summary">
      <div className="tg-bf-stat">
        <span className="tg-bf-stat-k">信号数</span>
        <span className="tg-bf-stat-v">{summary.total ?? 0}</span>
      </div>
      <div className="tg-bf-stat">
        <span className="tg-bf-stat-k">胜率</span>
        <span className="tg-bf-stat-v">{fmtPct(summary.winRate ?? null)}</span>
      </div>
      <div className="tg-bf-stat">
        <span className="tg-bf-stat-k">合计盈亏</span>
        <span className="tg-bf-stat-v">{fmtPnl(summary.totalPnlPct ?? null)}</span>
      </div>
      <div className="tg-bf-stat">
        <span className="tg-bf-stat-k">胜 / 负</span>
        <span className="tg-bf-stat-v">
          {summary.wins ?? 0} / {summary.losses ?? 0}
        </span>
      </div>
    </div>
  );
}

function BucketTable({ title, rows }: { title: string; rows: BucketRow[] | undefined }) {
  const list = rows ?? [];
  if (!list.length) return null;
  return (
    <div className="tg-bf-block">
      <h3 className="tg-bf-block-title">{title}</h3>
      <div className="pattern-wr-table-wrap">
        <table className="pattern-wr-table">
          <thead>
            <tr>
              <th>区间</th>
              <th>笔数</th>
              <th>胜率</th>
              <th>合计盈亏</th>
            </tr>
          </thead>
          <tbody>
            {list.map((r) => (
              <tr key={r.id}>
                <td>{r.label}</td>
                <td>{r.count}</td>
                <td>{fmtPct(r.winRate ?? null)}</td>
                <td>{fmtPnl(r.totalPnlPct ?? null)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}

export function TelegramBackfillTab() {
  const [chats, setChats] = useState<ChatTarget[]>([]);
  const [presets, setPresets] = useState<RangePreset[]>([]);
  const [hint, setHint] = useState("");
  const [rangeId, setRangeId] = useState("30d");
  const [selectedChats, setSelectedChats] = useState<Set<string>>(new Set());
  const [mode, setMode] = useState<"telethon" | "stats">("telethon");
  const [useCache, setUseCache] = useState(true);
  const [job, setJob] = useState<BackfillJob | null>(null);
  const [jobList, setJobList] = useState<JobListRow[]>([]);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const pollRef = useRef<number | null>(null);

  const loadOptions = useCallback(async () => {
    const res = await fetch("/api/telegram-backfill/options");
    const data = await res.json();
    if (!data.ok) return;
    const targets: ChatTarget[] = data.chatTargets ?? [];
    setChats(targets);
    setPresets(data.rangePresets ?? []);
    setHint(String(data.hint ?? ""));
    setSelectedChats(new Set(targets.map((t) => t.id)));
    if (data.defaultRangeId) setRangeId(String(data.defaultRangeId));
  }, []);

  const loadJobList = useCallback(async () => {
    const res = await fetch("/api/telegram-backfill/jobs?limit=20");
    const data = await res.json();
    if (data.ok) setJobList(data.jobs ?? []);
  }, []);

  const loadLatest = useCallback(async () => {
    const res = await fetch("/api/telegram-backfill/latest");
    const data = await res.json();
    if (data.ok && data.job) setJob(data.job as BackfillJob);
  }, []);

  const pollJob = useCallback(async (id: string) => {
    const res = await fetch(`/api/telegram-backfill/${id}?page=1&pageSize=200`);
    const data = await res.json();
    if (!data.ok) return;
    setJob(data as BackfillJob);
    if (data.status === "running") return;
    void loadJobList();
  }, [loadJobList]);

  useEffect(() => {
    void loadOptions();
    void loadJobList();
    void loadLatest();
  }, [loadOptions, loadJobList, loadLatest]);

  useEffect(() => {
    if (pollRef.current) window.clearInterval(pollRef.current);
    if (!job || job.status !== "running") return;
    const id = job.id;
    pollRef.current = window.setInterval(() => void pollJob(id), 2500);
    return () => {
      if (pollRef.current) window.clearInterval(pollRef.current);
    };
  }, [job, pollJob]);

  const toggleChat = (id: string) => {
    setSelectedChats((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const start = async (forceRefresh = false) => {
    setErr("");
    setBusy(true);
    try {
      const chatIds = [...selectedChats];
      const res = await fetch("/api/telegram-backfill", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          rangeId,
          chatIds,
          mode,
          useCache,
          forceRefresh,
        }),
      });
      const data = await res.json();
      if (!data.ok) {
        setErr(String(data.error ?? "启动失败"));
        return;
      }
      setJob(data as BackfillJob);
      void loadJobList();
    } catch (e) {
      setErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  const selectCachedJob = async (id: string) => {
    setErr("");
    const res = await fetch(`/api/telegram-backfill/${id}?page=1&pageSize=200`);
    const data = await res.json();
    if (!data.ok) {
      setErr(String(data.error ?? "读取缓存失败"));
      return;
    }
    setJob(data as BackfillJob);
  };

  const progressLabel = useMemo(() => {
    if (!job?.progress) return "";
    const p = job.progress;
    const phase = p.phase ?? "";
    if (phase === "fetch") return `拉取群消息 ${p.done ?? 0}/${p.total ?? 0} · ${p.current ?? ""}`;
    if (phase === "fetch5m") return `补全 5m K 线 ${p.done ?? 0}/${p.total ?? 0} · ${p.current ?? ""}`;
    if (phase === "settle") return `结算 ${p.done ?? 0}/${p.total ?? 0}`;
    if (phase === "stats") return "读取本地胜率库…";
    return phase;
  }, [job]);

  return (
    <div className="tg-bf-page">
      <aside className="bt-sidebar">
        <h1 className="bt-title">Telegram 回溯</h1>
        <p className="bt-desc">
          按推送配置的群组拉取近 1～3 个月形态卡片，解析后按与回测相同的 5m 规则结算，并汇总周/月胜率。
        </p>
        {hint ? <p className="bt-rules">{hint}</p> : null}

        <section className="bt-section">
          <h2 className="bt-section-title">时间范围</h2>
          <div className="bt-chips">
            {presets.map((p) => (
              <button
                key={p.id}
                type="button"
                className={`bt-chip${rangeId === p.id ? " on" : ""}`}
                onClick={() => setRangeId(p.id)}
              >
                {p.label}
              </button>
            ))}
          </div>
        </section>

        <section className="bt-section">
          <h2 className="bt-section-title">群组</h2>
          <div className="tg-bf-chat-list">
            {chats.map((c) => (
              <label key={c.id} className="bt-check">
                <input
                  type="checkbox"
                  checked={selectedChats.has(c.id)}
                  onChange={() => toggleChat(c.id)}
                />
                <span title={c.id}>{c.label}</span>
              </label>
            ))}
          </div>
        </section>

        <section className="bt-section">
          <h2 className="bt-section-title">数据源</h2>
          <label className="bt-field">
            <span>拉取方式</span>
            <select value={mode} onChange={(e) => setMode(e.target.value as "telethon" | "stats")}>
              <option value="telethon">Telethon 群历史（推荐）</option>
              <option value="stats">仅本地 telegram_push 胜率库</option>
            </select>
          </label>
          <label className="bt-check bt-field-inline">
            <input type="checkbox" checked={useCache} onChange={(e) => setUseCache(e.target.checked)} />
            命中相同参数时使用本地缓存
          </label>
        </section>

        <div className="bt-btn-row">
          <button type="button" className="bt-run" disabled={busy || !selectedChats.size} onClick={() => void start(false)}>
            {busy ? "启动中…" : "开始回溯"}
          </button>
          <button
            type="button"
            className="bt-run secondary"
            disabled={busy || !selectedChats.size}
            onClick={() => void start(true)}
          >
            强制刷新
          </button>
        </div>
        {err ? <p className="bt-error">{err}</p> : null}
      </aside>

      <main className="bt-main">
        <section className="bt-panel bt-panel-grow">
          <h2 className="bt-panel-title">回溯结果</h2>
          {job?.status === "running" ? (
            <p className="bt-rules">{progressLabel || "任务进行中…"}</p>
          ) : null}
          {job?.error ? <p className="bt-error">{job.error}</p> : null}
          {job?.params?.telethonError && job.params.mode === "stats_fallback" ? (
            <p className="bt-rules">Telethon 不可用，已回退本地胜率库：{job.params.telethonError}</p>
          ) : null}
          {job?.params?.messageCount != null ? (
            <p className="bt-muted">
              消息 {job.params.messageCount} 条 · 解析卡片 {job.params.parsedCount ?? 0} 条 · 模式{" "}
              {job.params.mode ?? mode}
            </p>
          ) : null}

          <SummaryCards summary={job?.summary} />
          <BucketTable title="周统计（北京 ISO 周）" rows={job?.byWeek} />
          <BucketTable title="月统计" rows={job?.byMonth} />
          <BucketTable title="按类型" rows={job?.byType} />

          {(job?.items?.length ?? 0) > 0 ? (
            <div className="tg-bf-block">
              <h3 className="tg-bf-block-title">明细（最多 200 条）</h3>
              <div className="pattern-wr-table-wrap">
                <table className="pattern-wr-table">
                  <thead>
                    <tr>
                      <th>时间</th>
                      <th>币</th>
                      <th>周期</th>
                      <th>类型</th>
                      <th>结果</th>
                      <th>盈亏</th>
                    </tr>
                  </thead>
                  <tbody>
                    {job!.items!.map((r, i) => (
                      <tr key={`${r.signalAt}-${r.symbol}-${i}`}>
                        <td>{formatAlertStatsTime(r.signalAt)}</td>
                        <td>{r.symbol}</td>
                        <td>{r.interval}</td>
                        <td>{r.typeLabel}</td>
                        <td>{outcomeLabel((r.outcome ?? "pending") as AlertOutcome)}</td>
                        <td>{fmtPnl(alertStatsPnlPct(r as never))}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          ) : (
            !job && <p className="bt-empty-inline">选择范围与群组后点击「开始回溯」，或从下方缓存记录打开。</p>
          )}
        </section>

        <section className="bt-panel">
          <h2 className="bt-panel-title">本地缓存</h2>
          {!jobList.length ? <p className="bt-empty-inline">暂无缓存任务。</p> : null}
          <ul className="bt-job-list">
            {jobList.map((row) => (
              <li key={row.id}>
                <button type="button" className={`bt-job-row${job?.id === row.id ? " active" : ""}`} onClick={() => void selectCachedJob(row.id)}>
                  <span className="bt-job-started">
                    {row.rangeDays ? `${row.rangeDays} 天` : "—"} · {row.status}
                  </span>
                  <span className="bt-job-range">
                    {row.total ?? 0} 笔 · 胜率 {fmtPct(row.winRate ?? null)}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      </main>
    </div>
  );
}
