import { useCallback, useEffect, useMemo, useState } from "react";
import { MercuHeader } from "../components/MercuHeader";
import { useRadarSSE } from "../hooks/useRadarSSE";
import { useSpecialFocus } from "../hooks/useSpecialFocus";
import { displaySymbol } from "../utils/symbol";
import {
  alertStatsLeverage,
  alertStatsPnlPct,
  formatAlertStatsTime,
  outcomeLabel,
  type AlertOutcome,
  type AlertStatsRecord,
} from "../utils/patternAlertWinRate";

type KindOption = { id: string; label: string; side: string };

type BacktestSummary = {
  total: number;
  wins: number;
  losses: number;
  flats: number;
  errors: number;
  pending: number;
  winRate: number | null;
  totalPnlPct: number | null;
};

type ByIntervalRow = BacktestSummary & { interval: string; count: number };

type BacktestItem = {
  symbol: string;
  interval: string;
  kind: string;
  typeLabel: string;
  patternLabel?: string;
  side: string;
  signalAt: number;
  entry: number;
  outcome?: string;
  movePct?: number | null;
  pnlPct?: number | null;
  exitPrice?: number | null;
  error?: string;
};

type BacktestJob = {
  id: string;
  status: string;
  error?: string | null;
  progress?: {
    phase?: string;
    done?: number;
    total?: number;
    current?: string;
    symbols?: number;
  };
  summary?: BacktestSummary | null;
  filteredSummary?: BacktestSummary | null;
  byInterval?: ByIntervalRow[];
  params?: { universe?: { count?: number; note?: string }; coverage?: CoverageInfo };
  storageStats?: { mb?: number };
  items?: BacktestItem[];
  total?: number;
  totalAll?: number;
  page?: number;
  pages?: number;
  settleRules?: string;
};

type CoverageInfo = {
  total: number;
  ready: number;
  percent: number;
  missingSample?: string[];
};

type PrefetchSegment = {
  index: number;
  startMs: number;
  endMs: number;
  status: string;
  done: number;
  total: number;
};

type PrefetchJob = {
  id: string;
  status: string;
  error?: string | null;
  progress?: {
    phase?: string;
    segmentIndex?: number;
    segmentTotal?: number;
    segmentStartMs?: number;
    segmentEndMs?: number;
    done?: number;
    total?: number;
    current?: string;
    coverage?: CoverageInfo;
  };
  segments?: PrefetchSegment[];
  params?: {
    startMs?: number;
    endMs?: number;
    chunkDays?: number;
    coverage?: CoverageInfo;
    universe?: { note?: string };
  };
  storageStats?: { mb?: number };
};

function toLocalInputValue(d: Date): string {
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function parseLocalInputMs(v: string): number {
  return new Date(v).getTime();
}

function fmtPct(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "—";
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(1)}%`;
}

function fmtDateRange(startMs?: number, endMs?: number): string {
  if (!startMs || !endMs) return "—";
  const fmt = (ms: number) =>
    new Date(ms).toLocaleDateString("zh-CN", { month: "2-digit", day: "2-digit" });
  return `${fmt(startMs)} ~ ${fmt(endMs)}`;
}

function fmtPrice(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return v.toFixed(2);
  if (Math.abs(v) >= 1) return v.toFixed(4);
  return v.toFixed(6).replace(/\.?0+$/, "") || "0";
}

function backtestItemToRecord(row: BacktestItem): AlertStatsRecord {
  const side = row.side === "bull" ? "long" : row.side === "bear" ? "short" : "flat";
  return {
    key: `${row.symbol}-${row.signalAt}-${row.kind}`,
    symbol: row.symbol.replace(/USDT$/i, ""),
    tradeSymbol: row.symbol,
    dir: row.side === "bull" ? "多" : row.side === "bear" ? "空" : "—",
    side,
    signalAt: row.signalAt,
    entry: row.entry,
    tier: /^(BTC|ETH|SOL)/i.test(row.symbol) ? "major" : "altcoin",
    stepPct: 5,
    verifyAt: row.signalAt + 3 * 3600_000,
    outcome: (row.outcome || "pending") as AlertOutcome,
    exitPrice: row.exitPrice ?? undefined,
    movePct: row.movePct ?? undefined,
    error: row.error,
    typeLabel: row.typeLabel,
    interval: row.interval,
  };
}

function fmtPnl(rec: AlertStatsRecord): { text: string; cls: string; title?: string } {
  if (rec.outcome === "pending") return { text: "待核实", cls: "muted" };
  if (rec.outcome === "error") {
    const reason = rec.error || "未知错误";
    return { text: "核实失败", cls: "neg", title: reason };
  }
  if (rec.outcome === "flat") {
    const tip =
      rec.exitPrice != null && Number.isFinite(rec.exitPrice)
        ? `结算价 ${fmtPrice(rec.exitPrice)}`
        : undefined;
    return { text: "平 · ≈0", cls: "muted", title: tip };
  }
  const pnl = alertStatsPnlPct(rec);
  if (pnl == null) return { text: "已核 · —", cls: "muted" };
  const lev = alertStatsLeverage(rec);
  const sign = pnl >= 0 ? "+" : "";
  const tipParts: string[] = [];
  if (rec.exitPrice != null && Number.isFinite(rec.exitPrice)) {
    tipParts.push(`结算价 ${fmtPrice(rec.exitPrice)}`);
  }
  if (rec.outcome === "take_profit") {
    tipParts.push("止盈");
  } else if (rec.outcome === "stop_loss") {
    tipParts.push("止损");
  }
  const suffix = rec.outcome === "take_profit" || rec.outcome === "stop_loss" ? "" : "";
  if (rec.outcome === "take_profit") {
    return {
      text: `${sign}${pnl.toFixed(1)}% (@${lev}x)`,
      cls: "pos",
      title: tipParts.join("\n") || undefined,
    };
  }
  if (rec.outcome === "stop_loss") {
    return {
      text: `${sign}${pnl.toFixed(1)}% (@${lev}x)`,
      cls: "neg",
      title: tipParts.join("\n") || undefined,
    };
  }
  return {
    text: `${sign}${pnl.toFixed(1)}% (@${lev}x)${suffix}`,
    cls: pnl >= 0 ? "pos" : "neg",
    title: tipParts.join("\n") || undefined,
  };
}

export function BacktestPage() {
  const { snapshot, online } = useRadarSSE();
  const { symbols: focusSymbols, remove: removeFocus } = useSpecialFocus();

  const [kindOptions, setKindOptions] = useState<KindOption[]>([]);
  const [intervals, setIntervals] = useState<string[]>(["15m", "1h", "4h"]);
  const [selectedKinds, setSelectedKinds] = useState<Set<string>>(new Set());
  const [selectedIntervals, setSelectedIntervals] = useState<Set<string>>(new Set(["15m", "1h", "4h"]));
  const [symbolScope, setSymbolScope] = useState<"top200" | "pool" | "majors" | "all">("top200");
  const [maxSymbols, setMaxSymbols] = useState(200);
  const [maxDays, setMaxDays] = useState(730);
  const [chunkDays, setChunkDays] = useState(30);
  const [universeNote, setUniverseNote] = useState("");
  const [fetchStartLocal, setFetchStartLocal] = useState("");
  const [fetchEndLocal, setFetchEndLocal] = useState("");
  const [btStartLocal, setBtStartLocal] = useState("");
  const [btEndLocal, setBtEndLocal] = useState("");
  const [settleRules, setSettleRules] = useState("");
  const [klineNote, setKlineNote] = useState("");

  const [prefetchJob, setPrefetchJob] = useState<PrefetchJob | null>(null);
  const [coverage, setCoverage] = useState<CoverageInfo | null>(null);
  const [coverageLoading, setCoverageLoading] = useState(false);

  const [job, setJob] = useState<BacktestJob | null>(null);
  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState("all");
  const [intervalFilter, setIntervalFilter] = useState("all");
  const [fetchLoading, setFetchLoading] = useState(false);
  const [btLoading, setBtLoading] = useState(false);
  const [bootErr, setBootErr] = useState("");

  useEffect(() => {
    const end = new Date();
    const start = new Date(end.getTime() - 30 * 86400_000);
    const fetchStart = new Date(end.getTime() - 180 * 86400_000);
    setFetchEndLocal(toLocalInputValue(end));
    setFetchStartLocal(toLocalInputValue(fetchStart));
    setBtEndLocal(toLocalInputValue(end));
    setBtStartLocal(toLocalInputValue(start));
  }, []);

  useEffect(() => {
    fetch("/api/backtest/structure/options")
      .then((r) => r.json())
      .then((body) => {
        if (!body?.ok) throw new Error(body?.error || "加载选项失败");
        const kinds: KindOption[] = body.kindOptions || [];
        const ivs: string[] = body.intervals || ["15m", "1h", "4h"];
        setKindOptions(kinds);
        setIntervals(ivs);
        setSelectedKinds(new Set((body.defaultKinds as string[]) || kinds.map((k) => k.id)));
        setSelectedIntervals(new Set(ivs));
        setSettleRules(String(body.settleRules || ""));
        setKlineNote(String(body.klineSourceNote || ""));
        setUniverseNote(String(body.universeNote || ""));
        if (body.defaultSymbolScope) setSymbolScope(body.defaultSymbolScope);
        if (body.defaultMaxSymbols) setMaxSymbols(Number(body.defaultMaxSymbols));
        if (body.defaultMaxDays) setMaxDays(Number(body.defaultMaxDays));
      })
      .catch((e) => setBootErr(e instanceof Error ? e.message : String(e)));
  }, []);

  const checkCoverage = useCallback(async () => {
    setCoverageLoading(true);
    try {
      const startMs = parseLocalInputMs(fetchStartLocal);
      const endMs = parseLocalInputMs(fetchEndLocal);
      const r = await fetch("/api/backtest/kline/coverage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startMs, endMs, symbolScope, maxSymbols }),
      });
      const body = await r.json();
      if (!body?.ok) throw new Error(body?.error || "覆盖率查询失败");
      setCoverage(body.coverage as CoverageInfo);
    } catch (e) {
      setBootErr(e instanceof Error ? e.message : String(e));
    } finally {
      setCoverageLoading(false);
    }
  }, [fetchStartLocal, fetchEndLocal, symbolScope, maxSymbols]);

  const pollPrefetch = useCallback(async (jobId: string) => {
    const r = await fetch(`/api/backtest/kline/prefetch/${encodeURIComponent(jobId)}`);
    const body = await r.json();
    if (!body?.ok) throw new Error(body?.error || "拉取查询失败");
    setPrefetchJob(body as PrefetchJob);
    if (body.params?.coverage) setCoverage(body.params.coverage as CoverageInfo);
    return body as PrefetchJob;
  }, []);

  const pollJob = useCallback(
    async (jobId: string, p: number, typeF: string, intervalF: string) => {
      const qs = new URLSearchParams({
        page: String(p),
        pageSize: "100",
        type: typeF,
        interval: intervalF,
      });
      const r = await fetch(`/api/backtest/structure/${encodeURIComponent(jobId)}?${qs}`);
      const body = await r.json();
      if (!body?.ok) throw new Error(body?.error || "查询失败");
      setJob(body as BacktestJob);
      return body as BacktestJob;
    },
    [],
  );

  useEffect(() => {
    if (!prefetchJob?.id || prefetchJob.status === "done" || prefetchJob.status === "failed") return;
    const id = setInterval(() => {
      void pollPrefetch(prefetchJob.id).catch(() => undefined);
    }, 1200);
    return () => clearInterval(id);
  }, [prefetchJob?.id, prefetchJob?.status, pollPrefetch]);

  useEffect(() => {
    if (!job?.id || job.status === "done" || job.status === "failed") return;
    const id = setInterval(() => {
      void pollJob(job.id, page, typeFilter, intervalFilter).catch(() => undefined);
    }, 1500);
    return () => clearInterval(id);
  }, [job?.id, job.status, page, typeFilter, intervalFilter, pollJob]);

  useEffect(() => {
    if (!job?.id || job.status !== "done") return;
    void pollJob(job.id, page, typeFilter, intervalFilter).catch(() => undefined);
  }, [job?.id, job?.status, page, typeFilter, intervalFilter, pollJob]);

  const onFetch = async () => {
    setFetchLoading(true);
    setBootErr("");
    try {
      const startMs = parseLocalInputMs(fetchStartLocal);
      const endMs = parseLocalInputMs(fetchEndLocal);
      const r = await fetch("/api/backtest/kline/prefetch", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startMs, endMs, chunkDays, symbolScope, maxSymbols, maxDays: 1095 }),
      });
      const body = await r.json();
      if (!body?.ok) throw new Error(body?.error || "拉取启动失败");
      setPrefetchJob(body as PrefetchJob);
    } catch (e) {
      setBootErr(e instanceof Error ? e.message : String(e));
    } finally {
      setFetchLoading(false);
    }
  };

  const onRunBacktest = async () => {
    setBtLoading(true);
    setBootErr("");
    try {
      const startMs = parseLocalInputMs(btStartLocal);
      const endMs = parseLocalInputMs(btEndLocal);
      const fetchStart = parseLocalInputMs(fetchStartLocal);
      const fetchEnd = parseLocalInputMs(fetchEndLocal);
      if (startMs < fetchStart || endMs > fetchEnd) {
        throw new Error("回测时间须在已选拉取范围内");
      }
      const r = await fetch("/api/backtest/structure", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          startMs,
          endMs,
          intervals: [...selectedIntervals],
          kinds: [...selectedKinds],
          symbolScope,
          maxSymbols,
          maxDays,
          skipFetch: true,
        }),
      });
      const body = await r.json();
      if (!body?.ok) throw new Error(body?.error || "回测启动失败");
      setJob(body as BacktestJob);
      setPage(1);
      setTypeFilter("all");
      setIntervalFilter("all");
    } catch (e) {
      setBootErr(e instanceof Error ? e.message : String(e));
    } finally {
      setBtLoading(false);
    }
  };

  const prefetchPct = useMemo(() => {
    const segs = prefetchJob?.segments || [];
    if (!segs.length) {
      const done = prefetchJob?.progress?.done ?? 0;
      const total = prefetchJob?.progress?.total ?? 0;
      return total ? Math.min(100, Math.round((done / total) * 100)) : 0;
    }
    const segTotal = segs.reduce((s, g) => s + (g.total || 0), 0);
    const segDone = segs.reduce((s, g) => s + (g.done || 0), 0);
    return segTotal ? Math.min(100, Math.round((segDone / segTotal) * 100)) : 0;
  }, [prefetchJob]);

  const scanPct = useMemo(() => {
    const done = job?.progress?.done ?? 0;
    const total = job?.progress?.total ?? 0;
    return total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  }, [job?.progress]);

  const typeOptions = useMemo(() => {
    const labels = new Set<string>();
    for (const k of kindOptions) labels.add(k.label);
    return [...labels].sort();
  }, [kindOptions]);

  const toggleKind = (id: string) => {
    setSelectedKinds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const toggleInterval = (iv: string) => {
    setSelectedIntervals((prev) => {
      const next = new Set(prev);
      if (next.has(iv)) next.delete(iv);
      else next.add(iv);
      return next;
    });
  };

  const listSummary = job?.filteredSummary ?? job?.summary;

  return (
    <div className="mercu-app">
      <MercuHeader
        online={online}
        scanTs={snapshot.scan_ts}
        poolMeta={snapshot.pool_meta}
        poolSize={snapshot.pool_size}
        focusSymbols={focusSymbols}
        onRemoveFocus={(sym) => void removeFocus(sym)}
      />
      <div className="bt-page">
        <aside className="bt-sidebar">
          <h1 className="bt-title">结构形态回测</h1>
          <p className="bt-desc">
            先分段拉 K 线入库，再选回测区间扫描。三周期分开看胜率。
          </p>

          <section className="bt-section">
            <h2 className="bt-section-title">1. K 线拉取</h2>
            <label className="bt-field">
              <span>拉取开始</span>
              <input
                type="datetime-local"
                value={fetchStartLocal}
                onChange={(e) => setFetchStartLocal(e.target.value)}
              />
            </label>
            <label className="bt-field">
              <span>拉取结束</span>
              <input
                type="datetime-local"
                value={fetchEndLocal}
                onChange={(e) => setFetchEndLocal(e.target.value)}
              />
            </label>
            <label className="bt-field">
              <span>分段（天）</span>
              <select value={chunkDays} onChange={(e) => setChunkDays(Number(e.target.value))}>
                <option value={30}>30 天/段</option>
                <option value={60}>60 天/段</option>
                <option value={90}>90 天/段</option>
              </select>
            </label>
            <label className="bt-field">
              <span>币种范围</span>
              <select value={symbolScope} onChange={(e) => setSymbolScope(e.target.value as typeof symbolScope)}>
                <option value="top200">Top200 流动性</option>
                <option value="pool">雷达池</option>
                <option value="majors">BTC/ETH/SOL</option>
                <option value="all">全市场</option>
              </select>
            </label>
            {symbolScope === "top200" && universeNote ? (
              <p className="bt-rules bt-universe-note">{universeNote}</p>
            ) : null}
            <div className="bt-btn-row">
              <button type="button" className="bt-run secondary" disabled={coverageLoading} onClick={() => void checkCoverage()}>
                {coverageLoading ? "检查中…" : "检查覆盖率"}
              </button>
              <button type="button" className="bt-run" disabled={fetchLoading} onClick={() => void onFetch()}>
                {fetchLoading ? "启动中…" : "拉取 K 线"}
              </button>
            </div>
            {coverage ? (
              <p className="bt-rules">
                本地覆盖 {coverage.ready}/{coverage.total}（{coverage.percent}%）
                {coverage.percent < 82 ? " · 建议先拉取" : " · 可回测"}
              </p>
            ) : null}
          </section>

          <section className="bt-section">
            <h2 className="bt-section-title">2. 回测扫描</h2>
            <label className="bt-field">
              <span>回测开始</span>
              <input type="datetime-local" value={btStartLocal} onChange={(e) => setBtStartLocal(e.target.value)} />
            </label>
            <label className="bt-field">
              <span>回测结束</span>
              <input type="datetime-local" value={btEndLocal} onChange={(e) => setBtEndLocal(e.target.value)} />
            </label>
            <div className="bt-field">
              <span>入场周期</span>
              <div className="bt-chips">
                {intervals.map((iv) => (
                  <button
                    key={iv}
                    type="button"
                    className={`bt-chip${selectedIntervals.has(iv) ? " on" : ""}`}
                    onClick={() => toggleInterval(iv)}
                  >
                    {iv}
                  </button>
                ))}
              </div>
            </div>
            <div className="bt-field">
              <span>信号类型</span>
              <div className="bt-checks">
                {kindOptions.map((k) => (
                  <label key={k.id} className="bt-check">
                    <input type="checkbox" checked={selectedKinds.has(k.id)} onChange={() => toggleKind(k.id)} />
                    <span>{k.label}</span>
                  </label>
                ))}
              </div>
            </div>
            <label className="bt-field">
              <span>最大跨度（天）</span>
              <input
                type="number"
                min={1}
                max={1095}
                value={maxDays}
                onChange={(e) => setMaxDays(Number(e.target.value) || 730)}
              />
            </label>
            {klineNote ? <p className="bt-rules">{klineNote}</p> : null}
            {settleRules ? <p className="bt-rules">{settleRules}</p> : null}
            {bootErr ? <p className="bt-error">{bootErr}</p> : null}
            <button
              type="button"
              className="bt-run"
              disabled={btLoading || selectedKinds.size === 0 || selectedIntervals.size === 0}
              onClick={() => void onRunBacktest()}
            >
              {btLoading ? "启动中…" : "开始回测"}
            </button>
          </section>
        </aside>

        <main className="bt-main">
          <section className="bt-panel">
            <h2 className="bt-panel-title">K 线拉取进度</h2>
            {!prefetchJob ? (
              <p className="bt-empty-inline">选择拉取时间后点击「拉取 K 线」；长区间会按段依次入库。</p>
            ) : (
              <>
                <div className="bt-status-bar">
                  <span className={`bt-status ${prefetchJob.status}`}>
                    {prefetchJob.status === "running" && "拉取中"}
                    {prefetchJob.status === "done" && "拉取完成"}
                    {prefetchJob.status === "failed" && "拉取失败"}
                    {prefetchJob.status === "pending" && "排队中"}
                  </span>
                  {prefetchJob.status === "running" ? (
                    <>
                      <div className="bt-progress">
                        <div className="bt-progress-fill" style={{ width: `${prefetchPct}%` }} />
                      </div>
                      <span className="bt-muted">
                        段 {((prefetchJob.progress?.segmentIndex ?? 0) + 1)}/
                        {prefetchJob.progress?.segmentTotal ?? "?"}{" "}
                        · {prefetchJob.progress?.done ?? 0}/{prefetchJob.progress?.total ?? 0}
                        {prefetchJob.progress?.current ? ` · ${prefetchJob.progress.current}` : ""}
                      </span>
                    </>
                  ) : null}
                  {prefetchJob.error ? <span className="bt-error">{prefetchJob.error}</span> : null}
                </div>
                {prefetchJob.segments && prefetchJob.segments.length > 0 ? (
                  <ul className="bt-segments">
                    {prefetchJob.segments.map((seg) => (
                      <li key={seg.index} className={`bt-seg bt-seg-${seg.status}`}>
                        <span>段 {seg.index + 1}</span>
                        <span>{fmtDateRange(seg.startMs, seg.endMs)}</span>
                        <span>{seg.done}/{seg.total || "—"}</span>
                        <span>{seg.status === "done" ? "完成" : seg.status === "running" ? "进行中" : "待拉"}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {prefetchJob.params?.coverage ? (
                  <p className="bt-rules">
                    拉取后覆盖 {prefetchJob.params.coverage.ready}/{prefetchJob.params.coverage.total}（
                    {prefetchJob.params.coverage.percent}%）
                    {prefetchJob.storageStats?.mb != null ? ` · 库 ${prefetchJob.storageStats.mb} MB` : ""}
                  </p>
                ) : null}
              </>
            )}
          </section>

          <section className="bt-panel bt-panel-grow">
            <h2 className="bt-panel-title">回测结果</h2>
            {!job ? (
              <p className="bt-empty-inline">拉取完成后选择回测时间，点击「开始回测」。</p>
            ) : (
              <>
                <div className="bt-status-bar">
                  <span className={`bt-status ${job.status}`}>
                    {job.status === "running" && "扫描中"}
                    {job.status === "done" && "已完成"}
                    {job.status === "failed" && "失败"}
                    {job.status === "pending" && "排队中"}
                  </span>
                  {job.status === "running" ? (
                    <>
                      <div className="bt-progress">
                        <div className="bt-progress-fill" style={{ width: `${scanPct}%` }} />
                      </div>
                      <span className="bt-muted">
                        {job.progress?.done ?? 0}/{job.progress?.total ?? 0}
                        {job.progress?.current ? ` · ${job.progress.current}` : ""}
                      </span>
                    </>
                  ) : null}
                  {job.error ? <span className="bt-error">{job.error}</span> : null}
                </div>

                {job.byInterval && job.byInterval.length > 0 ? (
                  <div className="bt-by-interval">
                    <div className="bt-interval-grid">
                      {job.byInterval.map((row) => (
                        <div key={row.interval} className="bt-interval-card">
                          <div className="bt-interval-head">{row.interval}</div>
                          <div className="bt-interval-stats">
                            <div>
                              <span className="bt-stat-val">{row.count}</span>
                              <span className="bt-stat-lab">信号</span>
                            </div>
                            <div>
                              <span className="bt-stat-val">
                                {row.winRate == null ? "—" : `${(row.winRate * 100).toFixed(1)}%`}
                              </span>
                              <span className="bt-stat-lab">胜率</span>
                            </div>
                            <div>
                              <span className={`bt-stat-val ${(row.totalPnlPct ?? 0) >= 0 ? "up" : "down"}`}>
                                {fmtPct(row.totalPnlPct)}
                              </span>
                              <span className="bt-stat-lab">合计</span>
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}

                {job.status === "done" ? (
                  <>
                    <div className="pattern-wr-filters bt-wr-filters">
                      <label className="pattern-wr-type-filter">
                        <span>类型</span>
                        <select
                          value={typeFilter}
                          onChange={(e) => {
                            setTypeFilter(e.target.value);
                            setPage(1);
                          }}
                        >
                          <option value="all">全部类型</option>
                          {typeOptions.map((t) => (
                            <option key={t} value={t}>
                              {t}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="pattern-wr-type-filter">
                        <span>周期</span>
                        <select
                          value={intervalFilter}
                          onChange={(e) => {
                            setIntervalFilter(e.target.value);
                            setPage(1);
                          }}
                        >
                          <option value="all">全部周期</option>
                          {intervals.map((iv) => (
                            <option key={iv} value={iv}>
                              {iv}
                            </option>
                          ))}
                        </select>
                      </label>
                      {listSummary ? (
                        <span className="bt-filter-summary">
                          筛选 {listSummary.total} 条
                          {listSummary.winRate != null ? ` · 胜率 ${(listSummary.winRate * 100).toFixed(1)}%` : ""}
                          {listSummary.totalPnlPct != null ? ` · ${fmtPct(listSummary.totalPnlPct)}` : ""}
                          {job.totalAll != null && job.total !== job.totalAll
                            ? `（共 ${job.totalAll}）`
                            : ""}
                        </span>
                      ) : null}
                    </div>

                    <div className="pattern-wr-table-wrap">
                      {(job.items || []).length === 0 ? (
                        <p className="pattern-wr-empty">该筛选下暂无信号</p>
                      ) : (
                        <table className="pattern-wr-table">
                          <thead>
                            <tr>
                              <th>时间</th>
                              <th>币种</th>
                              <th>方向</th>
                              <th>类型</th>
                              <th>周期</th>
                              <th>入场</th>
                              <th>结果</th>
                              <th>回溯盈亏</th>
                            </tr>
                          </thead>
                          <tbody>
                            {(job.items || []).map((row) => {
                              const rec = backtestItemToRecord(row);
                              const pnl = fmtPnl(rec);
                              return (
                                <tr key={rec.key}>
                                  <td className="mono">{formatAlertStatsTime(row.signalAt)}</td>
                                  <td>
                                    <strong>${displaySymbol(row.symbol)}</strong>
                                  </td>
                                  <td>
                                    <span
                                      className={`pattern-wr-dir ${
                                        rec.dir === "多" ? "long" : rec.dir === "空" ? "short" : "flat"
                                      }`}
                                    >
                                      {rec.dir}
                                    </span>
                                  </td>
                                  <td className="muted" title={row.patternLabel}>
                                    {row.typeLabel || "—"}
                                  </td>
                                  <td className="muted">{row.interval || "—"}</td>
                                  <td className="mono">{fmtPrice(row.entry)}</td>
                                  <td>
                                    <span className={`pattern-wr-out oc-${row.outcome || "pending"}`}>
                                      {outcomeLabel(rec.outcome)}
                                    </span>
                                  </td>
                                  <td className={`mono ${pnl.cls}`} title={pnl.title}>
                                    {pnl.text}
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                      )}
                    </div>

                    {(job.pages ?? 1) > 1 ? (
                      <div className="pattern-wr-pager bt-pager">
                        <button type="button" disabled={page <= 1} onClick={() => setPage((p) => Math.max(1, p - 1))}>
                          上一页
                        </button>
                        <span>
                          {page}/{job.pages}
                        </span>
                        <button
                          type="button"
                          disabled={page >= (job.pages ?? 1)}
                          onClick={() => setPage((p) => p + 1)}
                        >
                          下一页
                        </button>
                      </div>
                    ) : null}
                  </>
                ) : null}
              </>
            )}
          </section>
        </main>
      </div>
    </div>
  );
}
