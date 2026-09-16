import { useCallback, useEffect, useMemo, useRef, useState } from "react";
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

type ByTypeRow = BacktestSummary & { typeLabel?: string; label?: string; count: number };

type BacktestListRow = {
  id: string;
  status: string;
  error?: string | null;
  startedAt?: number;
  finishedAt?: number;
  startMs?: number;
  endMs?: number;
  intervals?: string[];
  partial?: boolean;
  total?: number;
  winRate?: number | null;
  totalPnlPct?: number | null;
};

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
  intervalSummary?: BacktestSummary | null;
  byInterval?: ByIntervalRow[];
  byType?: ByTypeRow[];
  params?: {
    startMs?: number;
    endMs?: number;
    universe?: { count?: number; note?: string };
    coverage?: CoverageInfo;
    partial?: boolean;
  };
  startedAt?: number;
  finishedAt?: number;
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
  barsExpected?: number;
  barsStored?: number;
  barPercent?: number;
  missingSample?: string[];
};

type PrefetchSegment = {
  index: number;
  startMs: number;
  endMs: number;
  status: string;
  done: number;
  total: number;
  percent?: number;
  barPercent?: number;
  barsExpected?: number;
  barsStored?: number;
  ready?: number;
  pairTotal?: number;
};

/** 每 5 分钟从本地库刷新入库进度 */
const COVERAGE_REFRESH_MS = 5 * 60 * 1000;

type StorageStats = { mb?: number; files?: number; bytes?: number };

const BT_PREFETCH_LS = "oi_bt_prefetch_v2";
const BT_PREFETCH_LS_LEGACY = "oi_bt_prefetch_v1";

type SavedPrefetchPrefs = {
  fetchStartLocal?: string;
  fetchEndLocal?: string;
  btStartLocal?: string;
  btEndLocal?: string;
  chunkDays?: number;
  symbolScope?: string;
  maxSymbols?: number;
  maxDays?: number;
  selectedKinds?: string[];
  selectedIntervals?: string[];
  jobId?: string;
  btJobId?: string;
  btSnapshot?: BacktestJob | null;
  btJobList?: BacktestListRow[];
  coverage?: CoverageInfo;
  coverageSegments?: PrefetchSegment[];
  prefetchSnapshot?: PrefetchJob | null;
};

function defaultDateLocals() {
  const end = new Date();
  const btStart = new Date(end.getTime() - 30 * 86400_000);
  const fetchStart = new Date(end.getTime() - 180 * 86400_000);
  return {
    fetchEndLocal: toLocalInputValue(end),
    fetchStartLocal: toLocalInputValue(fetchStart),
    btEndLocal: toLocalInputValue(end),
    btStartLocal: toLocalInputValue(btStart),
  };
}

function loadSavedPrefs(): SavedPrefetchPrefs {
  try {
    let raw = localStorage.getItem(BT_PREFETCH_LS);
    if (!raw) raw = localStorage.getItem(BT_PREFETCH_LS_LEGACY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as SavedPrefetchPrefs;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function savePrefs(patch: SavedPrefetchPrefs) {
  try {
    localStorage.setItem(BT_PREFETCH_LS, JSON.stringify({ ...loadSavedPrefs(), ...patch }));
  } catch {
    /* ignore */
  }
}

function jobToListRow(j: BacktestJob): BacktestListRow {
  return {
    id: j.id,
    status: j.status,
    error: j.error,
    startedAt: j.startedAt,
    finishedAt: j.finishedAt,
    startMs: j.params?.startMs,
    endMs: j.params?.endMs,
    partial: j.params?.partial,
    total: j.totalAll ?? j.summary?.total ?? 0,
    winRate: j.summary?.winRate ?? null,
    totalPnlPct: j.summary?.totalPnlPct ?? null,
  };
}

function upsertJobList(rows: BacktestListRow[], extra?: BacktestListRow | null): BacktestListRow[] {
  const byId = new Map<string, BacktestListRow>();
  for (const r of rows) {
    if (r?.id) byId.set(r.id, r);
  }
  if (extra?.id) byId.set(extra.id, extra);
  return [...byId.values()]
    .sort((a, b) => (b.startedAt || 0) - (a.startedAt || 0))
    .slice(0, 40);
}

function persistBtLocal(job: BacktestJob, prevList?: BacktestListRow[]): BacktestListRow[] {
  const merged = upsertJobList(prevList ?? loadSavedPrefs().btJobList ?? [], jobToListRow(job));
  const base = { ...loadSavedPrefs(), btJobId: job.id, btSnapshot: job, btJobList: merged };
  try {
    localStorage.setItem(BT_PREFETCH_LS, JSON.stringify(base));
  } catch {
    try {
      localStorage.setItem(
        BT_PREFETCH_LS,
        JSON.stringify({ ...base, btSnapshot: { ...job, items: (job.items || []).slice(0, 40) } }),
      );
    } catch {
      /* quota */
    }
  }
  return merged;
}

function segBarPercent(seg: PrefetchSegment): number {
  if (seg.barPercent != null && Number.isFinite(seg.barPercent)) return seg.barPercent;
  if (seg.percent != null && Number.isFinite(seg.percent)) return seg.percent;
  if (seg.total > 0) return Math.round((seg.done / seg.total) * 1000) / 10;
  return 0;
}

function segStatusLabel(seg: PrefetchSegment): string {
  const pct = segBarPercent(seg);
  if (seg.status === "done") return `完成 ${pct}%`;
  if (seg.status === "running") return `进行中 ${pct}%`;
  if (seg.status === "partial") return `部分 ${pct}%`;
  if (seg.status === "failed") return "失败";
  return "待拉";
}

function fmtCompactNum(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return "—";
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 10_000) return `${(n / 1_000).toFixed(1)}k`;
  return n.toLocaleString("zh-CN");
}

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
    barsStored?: number;
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

function isPrefetchInterrupted(job: PrefetchJob | null | undefined): boolean {
  return job?.status === "failed" && String(job.error || "").includes("服务重启");
}

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

function fmtPnlSum(v: number | null | undefined): string {
  if (v == null || !Number.isFinite(v)) return "合计 —";
  return `合计 ${v > 0 ? "+" : ""}${v.toFixed(1)}%`;
}

function fmtExpect(total: number | null | undefined, count: number): string {
  if (total == null || !Number.isFinite(total) || count <= 0) return "期望 —";
  const ev = total / count;
  return `期望 ${ev > 0 ? "+" : ""}${ev.toFixed(2)}%`;
}

type BtStatRow = { count?: number; winRate?: number | null; totalPnlPct?: number | null } | null;

/** 类型/周期下拉：次数 · 盈率总和 · 均笔期望 */
function formatBtTypeOption(label: string, row?: BtStatRow): string {
  const n = row?.count ?? 0;
  return `${label} · ${n}次 · ${fmtPnlSum(row?.totalPnlPct)} · ${fmtExpect(row?.totalPnlPct, n)}`;
}

function formatBtIntervalOption(iv: string, row?: BtStatRow): string {
  if (!row) return iv;
  const n = row.count ?? 0;
  return `${iv} · ${n}次 · ${fmtPnlSum(row.totalPnlPct)} · ${fmtExpect(row.totalPnlPct, n)}`;
}

function fmtJobStarted(startedAt?: number | null): string {
  if (startedAt == null || !Number.isFinite(startedAt) || startedAt <= 0) return "—";
  const ms = startedAt < 1e12 ? startedAt * 1000 : startedAt;
  return new Date(ms).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function fmtJobRange(startMs?: number | null, endMs?: number | null): string {
  if (!startMs || !endMs) return "—";
  const fmt = (ms: number) =>
    new Date(ms).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
    });
  return `${fmt(startMs)} ~ ${fmt(endMs)}`;
}

function jobStatusLabel(row: { status?: string; partial?: boolean }): string {
  if (row.status === "running") return "扫描中";
  if (row.status === "pending") return "排队中";
  if (row.status === "failed") return "失败";
  if (row.status === "done" && row.partial) return "部分完成";
  if (row.status === "done") return "已完成";
  return row.status || "";
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
  const initSaved = useMemo(() => loadSavedPrefs(), []);
  const initDates = useMemo(() => defaultDateLocals(), []);

  const [kindOptions, setKindOptions] = useState<KindOption[]>([]);
  const [intervals, setIntervals] = useState<string[]>(
    () => initSaved.selectedIntervals?.length ? initSaved.selectedIntervals : ["15m", "1h", "4h"],
  );
  const [selectedKinds, setSelectedKinds] = useState<Set<string>>(
    () => new Set(initSaved.selectedKinds || []),
  );
  const [selectedIntervals, setSelectedIntervals] = useState<Set<string>>(
    () => new Set(initSaved.selectedIntervals || ["15m", "1h", "4h"]),
  );
  const [symbolScope, setSymbolScope] = useState<"top200" | "pool" | "majors" | "all">(
    () => (initSaved.symbolScope as "top200" | "pool" | "majors" | "all" | undefined) || "top200",
  );
  const [maxSymbols, setMaxSymbols] = useState(() => initSaved.maxSymbols ?? 200);
  const [maxDays, setMaxDays] = useState(() => initSaved.maxDays ?? 730);
  const [chunkDays, setChunkDays] = useState(() => initSaved.chunkDays ?? 30);
  const [universeNote, setUniverseNote] = useState("");
  const [fetchStartLocal, setFetchStartLocal] = useState(
    () => initSaved.fetchStartLocal || initDates.fetchStartLocal,
  );
  const [fetchEndLocal, setFetchEndLocal] = useState(
    () => initSaved.fetchEndLocal || initDates.fetchEndLocal,
  );
  const [btStartLocal, setBtStartLocal] = useState(
    () => initSaved.btStartLocal || initDates.btStartLocal,
  );
  const [btEndLocal, setBtEndLocal] = useState(() => initSaved.btEndLocal || initDates.btEndLocal);
  const [settleRules, setSettleRules] = useState("");
  const [klineNote, setKlineNote] = useState("");

  const [prefetchJob, setPrefetchJob] = useState<PrefetchJob | null>(() => {
    const snap = initSaved.prefetchSnapshot ?? null;
    if (!snap) return null;
    if (isPrefetchInterrupted(snap)) {
      return {
        ...snap,
        status: "pending",
        error: null,
        progress: { ...snap.progress, current: "服务已恢复，继续拉取…" },
      };
    }
    return snap;
  });
  const [coverageSegments, setCoverageSegments] = useState<PrefetchSegment[] | null>(
    () => initSaved.coverageSegments ?? null,
  );
  const [storageStats, setStorageStats] = useState<StorageStats | null>(null);
  const [coverage, setCoverage] = useState<CoverageInfo | null>(() => initSaved.coverage ?? null);
  const [coverageLoading, setCoverageLoading] = useState(false);
  const [coverageUpdatedAt, setCoverageUpdatedAt] = useState<number | null>(null);
  const [ingestBarsPerMin, setIngestBarsPerMin] = useState<number | null>(null);
  const restoreOnceRef = useRef(false);
  const autoResumePrefetchRef = useRef(false);
  const lastBarsStoredRef = useRef<{ ts: number; bars: number } | null>(null);

  const [job, setJob] = useState<BacktestJob | null>(() => initSaved.btSnapshot ?? null);
  const [jobList, setJobList] = useState<BacktestListRow[]>(() => {
    const list = initSaved.btJobList ?? [];
    return initSaved.btSnapshot?.id ? upsertJobList(list, jobToListRow(initSaved.btSnapshot)) : list;
  });
  const [page, setPage] = useState(1);
  const [typeFilter, setTypeFilter] = useState("all");
  const [intervalFilter, setIntervalFilter] = useState("all");
  const [fetchLoading, setFetchLoading] = useState(false);
  const [btLoading, setBtLoading] = useState(false);
  const [bootErr, setBootErr] = useState("");

  useEffect(() => {
    const saved = loadSavedPrefs();
    fetch("/api/backtest/structure/options")
      .then((r) => r.json())
      .then((body) => {
        if (!body?.ok) throw new Error(body?.error || "加载选项失败");
        const kinds: KindOption[] = body.kindOptions || [];
        const ivs: string[] = body.intervals || ["15m", "1h", "4h"];
        setKindOptions(kinds);
        setIntervals(ivs);
        const defaultKinds = (body.defaultKinds as string[]) || kinds.map((k) => k.id);
        if (saved.selectedKinds?.length) {
          const valid = saved.selectedKinds.filter((id) => kinds.some((k) => k.id === id));
          setSelectedKinds(new Set(valid.length ? valid : defaultKinds));
        } else {
          setSelectedKinds(new Set(defaultKinds));
        }
        if (saved.selectedIntervals?.length) {
          const validIv = saved.selectedIntervals.filter((iv) => ivs.includes(iv));
          setSelectedIntervals(new Set(validIv.length ? validIv : ivs));
        } else {
          setSelectedIntervals(new Set(ivs));
        }
        setSettleRules(String(body.settleRules || ""));
        setKlineNote(String(body.klineSourceNote || ""));
        setUniverseNote(String(body.universeNote || ""));
        if (!saved.symbolScope && body.defaultSymbolScope) {
          setSymbolScope(body.defaultSymbolScope);
        }
        if (!saved.maxSymbols && body.defaultMaxSymbols) {
          setMaxSymbols(Number(body.defaultMaxSymbols));
        }
        if (!saved.maxDays && body.defaultMaxDays) {
          setMaxDays(Number(body.defaultMaxDays));
        }
        if (body.storageStats) setStorageStats(body.storageStats as StorageStats);
      })
      .catch((e) => setBootErr(e instanceof Error ? e.message : String(e)));
  }, []);

  useEffect(() => {
    const t = window.setTimeout(() => {
      savePrefs({
        fetchStartLocal,
        fetchEndLocal,
        btStartLocal,
        btEndLocal,
        chunkDays,
        symbolScope,
        maxSymbols,
        maxDays,
        selectedKinds: [...selectedKinds],
        selectedIntervals: [...selectedIntervals],
        coverage: coverage ?? undefined,
        coverageSegments: coverageSegments ?? undefined,
      });
    }, 300);
    return () => window.clearTimeout(t);
  }, [
    fetchStartLocal,
    fetchEndLocal,
    btStartLocal,
    btEndLocal,
    chunkDays,
    symbolScope,
    maxSymbols,
    maxDays,
    selectedKinds,
    selectedIntervals,
    coverage,
    coverageSegments,
  ]);

  const checkCoverage = useCallback(async (opts?: { silent?: boolean }) => {
    const silent = opts?.silent ?? false;
    if (!silent) setCoverageLoading(true);
    try {
      const startMs = parseLocalInputMs(fetchStartLocal);
      const endMs = parseLocalInputMs(fetchEndLocal);
      const r = await fetch("/api/backtest/kline/coverage", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ startMs, endMs, symbolScope, maxSymbols, chunkDays }),
      });
      const body = await r.json();
      if (!body?.ok) throw new Error(body?.error || "覆盖率查询失败");
      const cov = body.coverage as CoverageInfo;
      const segs = Array.isArray(body.segments) ? (body.segments as PrefetchSegment[]) : null;
      const now = Date.now();
      const barsStored = cov.barsStored ?? 0;
      const prev = lastBarsStoredRef.current;
      if (prev && barsStored >= prev.bars) {
        const mins = (now - prev.ts) / 60_000;
        if (mins >= 0.5) {
          setIngestBarsPerMin(Math.round((barsStored - prev.bars) / mins));
        }
      }
      lastBarsStoredRef.current = { ts: now, bars: barsStored };
      setCoverageUpdatedAt(now);
      setCoverage(cov);
      setCoverageSegments(segs);
      if (body.storageStats) setStorageStats(body.storageStats as StorageStats);
      savePrefs({
        fetchStartLocal,
        fetchEndLocal,
        btStartLocal,
        btEndLocal,
        chunkDays,
        symbolScope,
        maxSymbols,
        maxDays,
        coverage: cov,
        coverageSegments: segs ?? undefined,
      });
    } catch (e) {
      if (!silent) setBootErr(e instanceof Error ? e.message : String(e));
    } finally {
      if (!silent) setCoverageLoading(false);
    }
  }, [fetchStartLocal, fetchEndLocal, btStartLocal, btEndLocal, symbolScope, maxSymbols, maxDays, chunkDays]);

  const loadJobList = useCallback(async () => {
    const local = loadSavedPrefs();
    let serverRows: BacktestListRow[] = [];
    try {
      const r = await fetch("/api/backtest/structure/jobs?limit=40");
      const body = await r.json();
      if (body?.ok && Array.isArray(body.jobs)) serverRows = body.jobs as BacktestListRow[];
    } catch {
      /* 服务重启时用本地列表 */
    }
    let merged = upsertJobList(local.btJobList ?? [], local.btSnapshot ? jobToListRow(local.btSnapshot) : null);
    for (const row of serverRows) merged = upsertJobList(merged, row);
    setJobList(merged);
    savePrefs({ btJobList: merged });
    return merged;
  }, []);

  const restoreBacktestJob = useCallback(async () => {
    const saved = loadSavedPrefs();
    const tryBt = async (jobId: string) => {
      const qs = new URLSearchParams({
        page: "1",
        pageSize: "100",
        type: "all",
        interval: "all",
      });
      const r = await fetch(`/api/backtest/structure/${encodeURIComponent(jobId)}?${qs}`);
      const body = await r.json();
      if (!body?.ok) return null;
      return body as BacktestJob;
    };
    const rows = await loadJobList();
    const ids = [saved.btJobId, saved.btSnapshot?.id, rows[0]?.id].filter(
      (id, i, arr) => Boolean(id) && arr.indexOf(id) === i,
    ) as string[];
    for (const id of ids) {
      const live = await tryBt(id).catch(() => null);
      if (live) {
        setJob(live);
        setJobList(persistBtLocal(live, rows));
        return;
      }
    }
    if (saved.btSnapshot?.id) {
      setJob(saved.btSnapshot);
      setJobList(upsertJobList(rows, jobToListRow(saved.btSnapshot)));
      return;
    }
    try {
      const latestRes = await fetch("/api/backtest/structure/latest");
      const latestBody = await latestRes.json();
      const latestId = String(latestBody?.job?.id || "").trim();
      if (!latestBody?.ok || !latestId) return;
      const live = await tryBt(latestId);
      if (live) {
        setJob(live);
        setJobList(persistBtLocal(live, rows));
      }
    } catch {
      /* ignore */
    }
  }, [loadJobList]);

  const restorePrefetchState = useCallback(async () => {
    if (!fetchStartLocal || !fetchEndLocal) return;
    void checkCoverage({ silent: true }).catch(() => undefined);
    const saved = loadSavedPrefs();
    const tryJob = async (jobId: string) => {
      const r = await fetch(`/api/backtest/kline/prefetch/${encodeURIComponent(jobId)}`);
      const body = await r.json();
      if (!body?.ok) return null;
      return body as PrefetchJob;
    };
    if (saved.jobId) {
      const liveJob = await tryJob(saved.jobId).catch(() => null);
      if (liveJob) {
        setPrefetchJob(liveJob);
        savePrefs({ jobId: liveJob.id, prefetchSnapshot: liveJob });
        if (isPrefetchInterrupted(liveJob) && !autoResumePrefetchRef.current) {
          autoResumePrefetchRef.current = true;
          setPrefetchJob({
            ...liveJob,
            status: "pending",
            error: null,
            progress: { ...liveJob.progress, current: "服务已恢复，继续拉取…" },
          });
          const startMs = parseLocalInputMs(fetchStartLocal);
          const endMs = parseLocalInputMs(fetchEndLocal);
          const r = await fetch("/api/backtest/kline/prefetch", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ startMs, endMs, chunkDays, symbolScope, maxSymbols, maxDays: 1095 }),
          });
          const body = await r.json();
          if (body?.ok) {
            setPrefetchJob(body as PrefetchJob);
            savePrefs({ jobId: body.id, prefetchSnapshot: body });
          }
        }
        return;
      }
    }
    const latestRes = await fetch("/api/backtest/kline/prefetch/latest");
    const latestBody = await latestRes.json();
    const latest = latestBody?.job as PrefetchJob | null | undefined;
    if (latest?.id && (latest.status === "running" || latest.status === "pending")) {
      setPrefetchJob(latest);
      savePrefs({ jobId: latest.id, prefetchSnapshot: latest });
    }
  }, [checkCoverage, fetchStartLocal, fetchEndLocal, chunkDays, symbolScope, maxSymbols]);

  useEffect(() => {
    if (restoreOnceRef.current || !fetchStartLocal || !fetchEndLocal) return;
    restoreOnceRef.current = true;
    void restorePrefetchState().catch(() => undefined);
    void restoreBacktestJob().catch(() => undefined);
  }, [fetchStartLocal, fetchEndLocal, restorePrefetchState, restoreBacktestJob]);

  const pollPrefetch = useCallback(async (jobId: string) => {
    const r = await fetch(`/api/backtest/kline/prefetch/${encodeURIComponent(jobId)}`);
    const body = await r.json();
    if (!body?.ok) throw new Error(body?.error || "拉取查询失败");
    const job = body as PrefetchJob;
    setPrefetchJob(job);
    if (job.params?.coverage) setCoverage(job.params.coverage as CoverageInfo);
    savePrefs({ jobId: job.id, prefetchSnapshot: job });
    return job;
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
      const next = body as BacktestJob;
      setJob(next);
      setJobList(persistBtLocal(next));
      return next;
    },
    [],
  );

  const openHistoryJob = async (jobId: string) => {
    if (!jobId) return;
    setPage(1);
    setTypeFilter("all");
    setIntervalFilter("all");
    try {
      await pollJob(jobId, 1, "all", "all");
    } catch (e) {
      const saved = loadSavedPrefs().btSnapshot;
      if (saved?.id === jobId) {
        setJob(saved);
        return;
      }
      setBootErr(e instanceof Error ? e.message : String(e));
    }
  };

  useEffect(() => {
    if (
      !prefetchJob?.id ||
      prefetchJob.id === "starting" ||
      prefetchJob.status === "done" ||
      (prefetchJob.status === "failed" && !isPrefetchInterrupted(prefetchJob))
    ) {
      if (prefetchJob?.status === "done") {
        void checkCoverage({ silent: true }).catch(() => undefined);
        savePrefs({ jobId: prefetchJob.id, prefetchSnapshot: prefetchJob });
      } else if (prefetchJob?.status === "failed") {
        savePrefs({ jobId: prefetchJob.id, prefetchSnapshot: prefetchJob });
      }
      return;
    }
    const id = setInterval(() => {
      void pollPrefetch(prefetchJob.id).catch(() => undefined);
    }, 1200);
    return () => clearInterval(id);
  }, [prefetchJob?.id, prefetchJob?.status, pollPrefetch, checkCoverage]);

  useEffect(() => {
    if (!fetchStartLocal || !fetchEndLocal) return;
    const tick = () => void checkCoverage({ silent: true }).catch(() => undefined);
    const id = window.setInterval(tick, COVERAGE_REFRESH_MS);
    return () => window.clearInterval(id);
  }, [fetchStartLocal, fetchEndLocal, symbolScope, maxSymbols, chunkDays, checkCoverage]);

  useEffect(() => {
    if (!job?.id || job.status === "done" || job.status === "failed") return;
    const id = setInterval(() => {
      void pollJob(job.id, page, typeFilter, intervalFilter).catch(() => undefined);
    }, 1500);
    return () => clearInterval(id);
  }, [job?.id, job?.status, page, typeFilter, intervalFilter, pollJob]);

  useEffect(() => {
    if (!job?.id) return;
    if (job.status !== "done" && job.status !== "running" && job.status !== "failed") return;
    void pollJob(job.id, page, typeFilter, intervalFilter).catch(() => undefined);
  }, [job?.id, job?.status, page, typeFilter, intervalFilter, pollJob]);

  useEffect(() => {
    void loadJobList().catch(() => undefined);
  }, [job?.id, job?.status, loadJobList]);

  const onFetch = async () => {
    setFetchLoading(true);
    setBootErr("");
    setPrefetchJob({
      id: "starting",
      status: "pending",
      progress: { current: "正在启动拉取任务…" },
    });
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
      const job = body as PrefetchJob;
      setPrefetchJob(job);
      lastBarsStoredRef.current = null;
      setIngestBarsPerMin(null);
      void checkCoverage({ silent: true }).catch(() => undefined);
      savePrefs({
        jobId: job.id,
        prefetchSnapshot: job,
        fetchStartLocal,
        fetchEndLocal,
        btStartLocal,
        btEndLocal,
        chunkDays,
        symbolScope,
        maxSymbols,
        maxDays,
      });
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      const msg =
        raw === "Failed to fetch"
          ? "无法连接 OI 后端（8765），请确认服务在线后重试"
          : raw;
      setBootErr(msg);
      setPrefetchJob((prev) =>
        prev?.id === "starting" ? { ...prev, status: "failed", error: msg } : prev,
      );
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
      const btJob = body as BacktestJob;
      setJob(btJob);
      setJobList(persistBtLocal(btJob));
      savePrefs({ btStartLocal, btEndLocal, btJobId: btJob.id });
      setPage(1);
      setTypeFilter("all");
      setIntervalFilter("all");
      void loadJobList().catch(() => undefined);
    } catch (e) {
      const raw = e instanceof Error ? e.message : String(e);
      setBootErr(
        raw === "Failed to fetch"
          ? "无法连接 OI 后端（8765 正忙或刚重启）。覆盖率扫描不再堵死接口，请刷新后再点「开始回测」"
          : raw,
      );
    } finally {
      setBtLoading(false);
    }
  };

  const prefetchPct = useMemo(() => {
    const jobRunning = prefetchJob?.status === "running" || prefetchJob?.status === "pending";
    const bars = Math.max(coverage?.barsStored ?? 0, prefetchJob?.progress?.barsStored ?? 0);
    if (jobRunning && bars <= 0) {
      const prog = prefetchJob?.progress;
      const st = prog?.segmentTotal ?? prefetchJob?.segments?.length ?? 0;
      const idx = prog?.segmentIndex ?? 0;
      const tot = prog?.total ?? 0;
      const done = prog?.done ?? 0;
      if (st > 0 && tot > 0) {
        return Math.min(100, Math.round(((idx * tot + done) / (st * tot)) * 1000) / 10);
      }
    }
    if (coverage?.barPercent != null && Number.isFinite(coverage.barPercent)) {
      return Math.min(100, Math.round(coverage.barPercent * 10) / 10);
    }
    const segs = coverageSegments || [];
    if (segs.length) {
      const totalBars = segs.reduce((s, g) => s + (g.barsExpected ?? g.total ?? 0), 0);
      const storedBars = segs.reduce((s, g) => s + (g.barsStored ?? 0), 0);
      if (totalBars > 0) {
        return Math.min(100, Math.round((storedBars / totalBars) * 1000) / 10);
      }
    }
    const prog = prefetchJob?.progress;
    const done = prog?.done ?? 0;
    const total = prog?.total ?? 0;
    return total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  }, [coverage, coverageSegments, prefetchJob?.progress, prefetchJob?.segments, prefetchJob?.status]);

  const scanPct = useMemo(() => {
    const done = job?.progress?.done ?? 0;
    const total = job?.progress?.total ?? 0;
    return total ? Math.min(100, Math.round((done / total) * 100)) : 0;
  }, [job?.progress]);

  const typeOptions = useMemo(() => {
    const rows = job?.byType ?? [];
    if (rows.length) {
      return rows.map((row) => ({
        label: String(row.typeLabel || row.label || ""),
        count: row.count,
        winRate: row.winRate,
        totalPnlPct: row.totalPnlPct,
      })).filter((r) => r.label);
    }
    const labels = new Set<string>();
    for (const k of kindOptions) labels.add(k.label);
    return [...labels].sort().map((label) => ({
      label,
      count: 0,
      winRate: null as number | null,
      totalPnlPct: null as number | null,
    }));
  }, [job?.byType, kindOptions]);

  useEffect(() => {
    if (typeFilter === "all") return;
    if (!typeOptions.some((t) => t.label === typeFilter)) {
      setTypeFilter("all");
      setPage(1);
    }
  }, [typeFilter, typeOptions]);

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

  const displaySegments = useMemo(() => {
    const jobRunning = prefetchJob?.status === "running" || prefetchJob?.status === "pending";
    const jobSegs = prefetchJob?.segments;
    if (jobRunning && jobSegs?.length) {
      return jobSegs.map((seg) => {
        const cov = coverageSegments?.find((c) => c.index === seg.index);
        const barsStored = cov?.barsStored ?? seg.barsStored ?? 0;
        const barsExpected = cov?.barsExpected ?? seg.barsExpected;
        return {
          ...seg,
          barsStored,
          barsExpected,
          barPercent:
            barsExpected && barsExpected > 0
              ? Math.round((barsStored / barsExpected) * 1000) / 10
              : undefined,
        };
      });
    }
    const base = coverageSegments?.length ? coverageSegments : jobSegs ?? null;
    if (!base?.length || prefetchJob?.status !== "running") return base;
    const segIdx = prefetchJob.progress?.segmentIndex;
    if (segIdx == null) return base;
    return base.map((seg) =>
      seg.index === segIdx && seg.status !== "done" ? { ...seg, status: "running" } : seg,
    );
  }, [coverageSegments, prefetchJob?.segments, prefetchJob?.status, prefetchJob?.progress?.segmentIndex]);

  const coverageRefreshLabel = useMemo(() => {
    if (!coverageUpdatedAt) return null;
    const t = new Date(coverageUpdatedAt).toLocaleTimeString("zh-CN", {
      hour: "2-digit",
      minute: "2-digit",
    });
    const speed =
      ingestBarsPerMin != null && ingestBarsPerMin > 0
        ? ` · 入库 ${fmtCompactNum(ingestBarsPerMin)} 条/分`
        : "";
    return `入库进度 ${t} 更新${speed} · 每 5 分钟刷新`;
  }, [coverageUpdatedAt, ingestBarsPerMin]);

  const showKlinePanel =
    prefetchJob != null || (coverage != null && coverage.total > 0) || (displaySegments?.length ?? 0) > 0;

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
            先分段拉 K 线入库，再选回测区间扫描。三周期分开看合计盈亏与均笔期望。
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
              <button
                type="button"
                className="bt-run"
                disabled={fetchLoading}
                onClick={() => void onFetch()}
              >
                {fetchLoading || prefetchJob?.status === "running" || prefetchJob?.status === "pending"
                  ? prefetchJob?.status === "running"
                    ? "拉取中…"
                    : "启动中…"
                  : "拉取 K 线"}
              </button>
            </div>
            {prefetchJob?.status === "running" || prefetchJob?.status === "pending" ? (
              <p className="bt-rules">
                {prefetchJob.progress?.current || "正在连接行情源…"}
                {prefetchJob.progress?.total
                  ? ` · ${prefetchJob.progress.done ?? 0}/${prefetchJob.progress.total}`
                  : ""}
              </p>
            ) : null}
            {prefetchJob?.status === "failed" && prefetchJob.error ? (
              <p className="bt-error">{prefetchJob.error}</p>
            ) : null}
            {bootErr ? <p className="bt-error">{bootErr}</p> : null}
            {storageStats?.mb != null ? (
              <p className="bt-rules">
                本地库 {storageStats.mb} MB
                {storageStats.files != null ? ` · ${storageStats.files} 文件` : ""}
                {coverage
                  ? ` · 当前范围覆盖 ${coverage.ready}/${coverage.total}（${coverage.percent}%）`
                  : " · 刷新后会按本地库恢复分段进度"}
              </p>
            ) : null}
            {coverage ? (
              <p className="bt-rules">
                入库 {fmtCompactNum(coverage.barsStored)}/{fmtCompactNum(coverage.barsExpected)}（
                {coverage.barPercent ?? coverage.percent}%）
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
            {!showKlinePanel ? (
              <p className="bt-empty-inline">选择拉取时间后点击「拉取 K 线」；长区间会按段依次入库。</p>
            ) : (
              <>
                {prefetchJob ? (
                  <div className="bt-status-bar">
                    <span className={`bt-status ${prefetchJob.status}`}>
                      {prefetchJob.status === "running" && "拉取中"}
                      {prefetchJob.status === "done" && "拉取完成"}
                      {prefetchJob.status === "failed" && "拉取失败"}
                      {prefetchJob.status === "pending" && "排队中"}
                    </span>
                    {prefetchJob.status === "running" || prefetchJob.status === "pending" ? (
                      <>
                        <div className="bt-progress">
                          <div className="bt-progress-fill" style={{ width: `${prefetchPct}%` }} />
                        </div>
                        <span className="bt-muted">
                          {Math.max(coverage?.barsStored ?? 0, prefetchJob.progress?.barsStored ?? 0) > 0
                            ? "入库"
                            : "任务"}{" "}
                          {prefetchPct}%
                          {coverage?.barsExpected != null ? (
                            <>
                              {" "}
                              · {fmtCompactNum(Math.max(coverage.barsStored ?? 0, prefetchJob.progress?.barsStored ?? 0))}/
                              {fmtCompactNum(coverage.barsExpected)} 条
                            </>
                          ) : prefetchJob.progress?.barsStored ? (
                            <> · {fmtCompactNum(prefetchJob.progress.barsStored)} 条</>
                          ) : null}
                          {prefetchJob.progress?.total
                            ? ` · ${prefetchJob.progress.done ?? 0}/${prefetchJob.progress.total} 对`
                            : null}
                          {prefetchJob.progress?.current
                            ? ` · ${prefetchJob.progress.current}`
                            : " · 正在连接行情源…"}
                        </span>
                      </>
                    ) : null}
                    {prefetchJob.error ? <span className="bt-error">{prefetchJob.error}</span> : null}
                  </div>
                ) : displaySegments && displaySegments.length > 0 ? (
                  <div className="bt-status-bar">
                    <span className="bt-status done">本地缓存</span>
                    <div className="bt-progress">
                      <div className="bt-progress-fill" style={{ width: `${prefetchPct}%` }} />
                    </div>
                    <span className="bt-muted">覆盖进度 {prefetchPct}% · 刷新后从本地库恢复</span>
                  </div>
                ) : (
                  <p className="bt-rules">
                    无进行中的拉取任务；选择时间后会自动检查本地库分段覆盖。
                  </p>
                )}
                {coverageRefreshLabel ? (
                  <p className="bt-rules bt-coverage-refresh">{coverageRefreshLabel}</p>
                ) : null}
                {displaySegments && displaySegments.length > 0 ? (
                  <ul className="bt-segments">
                    {displaySegments.map((seg) => (
                      <li key={seg.index} className={`bt-seg bt-seg-${seg.status}`}>
                        <span>段 {seg.index + 1}</span>
                        <span>{fmtDateRange(seg.startMs, seg.endMs)}</span>
                        <span>
                          {seg.barsExpected != null
                            ? `${fmtCompactNum(seg.barsStored ?? 0)}/${fmtCompactNum(seg.barsExpected)} 条`
                            : `${fmtCompactNum(seg.done)}/${fmtCompactNum(seg.total)} 对`}
                          （{segBarPercent(seg)}%）
                        </span>
                        <span>{segStatusLabel(seg)}</span>
                      </li>
                    ))}
                  </ul>
                ) : null}
                {prefetchJob?.params?.coverage ? (
                  <p className="bt-rules">
                    拉取后覆盖 {prefetchJob.params.coverage.ready}/{prefetchJob.params.coverage.total}（
                    {prefetchJob.params.coverage.percent}%）
                    {prefetchJob.storageStats?.mb != null ? ` · 库 ${prefetchJob.storageStats.mb} MB` : ""}
                  </p>
                ) : coverage ? (
                  <p className="bt-rules">
                    入库 {fmtCompactNum(coverage.barsStored)}/{fmtCompactNum(coverage.barsExpected)}（
                    {coverage.barPercent ?? coverage.percent}%）
                    {storageStats?.mb != null ? ` · 库 ${storageStats.mb} MB` : ""}
                  </p>
                ) : null}
              </>
            )}
          </section>

          <section className="bt-panel bt-panel-grow">
            <h2 className="bt-panel-title">回测结果</h2>
            {jobList.length > 0 ? (
              <ul className="bt-job-list">
                {jobList.map((row) => (
                  <li key={row.id}>
                    <button
                      type="button"
                      className={`bt-job-row ${job?.id === row.id ? "active" : ""} ${row.status}`}
                      onClick={() => void openHistoryJob(row.id)}
                    >
                      <span className="bt-job-started">{fmtJobStarted(row.startedAt)}</span>
                      <span className="bt-job-range">{fmtJobRange(row.startMs, row.endMs)}</span>
                      <span className={`bt-status ${row.status}`}>{jobStatusLabel(row)}</span>
                      <span className="bt-job-meta">
                        {row.total ? `${row.total} 信号` : "—"}
                        {row.totalPnlPct != null ? ` · ${fmtPct(row.totalPnlPct)}` : ""}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
            ) : null}
            {!job && jobList.length === 0 ? (
              <p className="bt-empty-inline">拉取完成后选择回测时间，点击「开始回测」。完成后会出现在上方列表。</p>
            ) : !job ? (
              <p className="bt-empty-inline">点选上方一次回测，查看明细。</p>
            ) : (
              <>
                <div className="bt-status-bar">
                  <span className={`bt-status ${job.status}`}>
                    {job.status === "running" && "扫描中"}
                    {job.status === "done" && (job.params?.partial ? "部分完成" : "已完成")}
                    {job.status === "failed" && "失败"}
                    {job.status === "pending" && "排队中"}
                  </span>
                  {job.status === "running" || job.status === "pending" ? (
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
                  {job.summary ? (
                    <span className="bt-live-wr">
                      {job.status === "running" ? "实时合计 " : "合计 "}
                      {fmtPct(job.summary.totalPnlPct)}
                      {job.summary.total > 0 && job.summary.totalPnlPct != null
                        ? ` · 期望 ${fmtPct(job.summary.totalPnlPct / job.summary.total)}`
                        : ""}
                      {job.totalAll != null ? ` · ${job.totalAll} 次` : ""}
                    </span>
                  ) : job.status === "running" ? (
                    <span className="bt-muted">实时合计 —（尚无已结算信号）</span>
                  ) : null}
                  {job.error ? <span className="bt-error">{job.error}</span> : null}
                </div>
                {job.params?.startMs && job.params?.endMs ? (
                  <p className="bt-rules">
                    开始 {fmtJobStarted(job.startedAt)} · 区间 {fmtJobRange(job.params.startMs, job.params.endMs)}
                  </p>
                ) : null}
                {job.params?.partial ? (
                  <p className="bt-rules">扫描中断，以下为已扫部分。可重新点「开始回测」补全。</p>
                ) : null}

                {job.summary ? (
                  <div className="bt-summary-grid">
                    <div className="bt-stat">
                      <span className="bt-stat-val">{job.summary.total}</span>
                      <span className="bt-stat-lab">{job.status === "running" ? "已扫信号" : "信号"}</span>
                    </div>
                    <div className="bt-stat">
                      <span className="bt-stat-val">
                        {job.summary.winRate == null ? "—" : `${(job.summary.winRate * 100).toFixed(1)}%`}
                      </span>
                      <span className="bt-stat-lab">{job.status === "running" ? "实时胜率" : "胜率"}</span>
                    </div>
                    <div className="bt-stat">
                      <span className={`bt-stat-val ${(job.summary.totalPnlPct ?? 0) >= 0 ? "up" : "down"}`}>
                        {fmtPct(job.summary.totalPnlPct)}
                      </span>
                      <span className="bt-stat-lab">合计盈亏</span>
                    </div>
                    <div className="bt-stat">
                      <span className="bt-stat-val">
                        {job.summary.wins}/{job.summary.losses}
                      </span>
                      <span className="bt-stat-lab">胜 / 负</span>
                    </div>
                  </div>
                ) : null}

                {job.byInterval && job.byInterval.length > 0 ? (
                  <div className="bt-by-interval">
                    <div className="bt-interval-grid">
                      {job.byInterval.map((row) => (
                        <button
                          key={row.interval}
                          type="button"
                          className={`bt-interval-card ${intervalFilter === row.interval ? "active" : ""}`}
                          onClick={() => {
                            setIntervalFilter((prev) => (prev === row.interval ? "all" : row.interval));
                            setTypeFilter("all");
                            setPage(1);
                          }}
                        >
                          <div className="bt-interval-head">{row.interval}</div>
                          <div className="bt-interval-stats">
                            <div>
                              <span className="bt-stat-val">{row.count}</span>
                              <span className="bt-stat-lab">触发</span>
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
                        </button>
                      ))}
                    </div>
                  </div>
                ) : null}

                {job.status === "done" || job.status === "failed" || (job.totalAll ?? 0) > 0 ? (
                  <>
                    <div className="pattern-wr-filters bt-wr-filters">
                      <label className="pattern-wr-type-filter">
                        <span>周期</span>
                        <select
                          value={intervalFilter}
                          onChange={(e) => {
                            setIntervalFilter(e.target.value);
                            setTypeFilter("all");
                            setPage(1);
                          }}
                          aria-label="按周期筛选类型统计"
                        >
                          <option value="all">
                            {formatBtIntervalOption(
                              "全部周期",
                              job.summary
                                ? {
                                    count: job.summary.total,
                                    winRate: job.summary.winRate,
                                    totalPnlPct: job.summary.totalPnlPct,
                                  }
                                : null,
                            )}
                          </option>
                          {(job.byInterval?.length
                            ? job.byInterval.map((row) => row.interval)
                            : intervals
                          ).map((iv) => {
                            const row = job.byInterval?.find((r) => r.interval === iv);
                            return (
                              <option key={iv} value={iv}>
                                {formatBtIntervalOption(iv, row)}
                              </option>
                            );
                          })}
                        </select>
                      </label>
                      <label className="pattern-wr-type-filter">
                        <span>类型</span>
                        <select
                          value={typeFilter}
                          onChange={(e) => {
                            setTypeFilter(e.target.value);
                            setPage(1);
                          }}
                          aria-label="按类型筛选（当前周期）"
                        >
                          <option value="all">
                            {formatBtTypeOption("全部类型", {
                              count: job.intervalSummary?.total ?? 0,
                              winRate: job.intervalSummary?.winRate ?? null,
                              totalPnlPct: job.intervalSummary?.totalPnlPct ?? null,
                            })}
                          </option>
                          {typeOptions.map((t) => (
                            <option key={t.label} value={t.label}>
                              {formatBtTypeOption(t.label, t)}
                            </option>
                          ))}
                        </select>
                      </label>
                      {listSummary ? (
                        <span className="bt-filter-summary">
                          筛选 {listSummary.total} 条
                          {listSummary.totalPnlPct != null ? ` · 合计 ${fmtPct(listSummary.totalPnlPct)}` : ""}
                          {listSummary.total > 0 && listSummary.totalPnlPct != null
                            ? ` · 期望 ${fmtPct(listSummary.totalPnlPct / listSummary.total)}`
                            : ""}
                          {listSummary.winRate != null ? ` · 胜率 ${(listSummary.winRate * 100).toFixed(1)}%` : ""}
                          {job.totalAll != null && job.total !== job.totalAll
                            ? `（共 ${job.totalAll}）`
                            : ""}
                        </span>
                      ) : null}
                    </div>

                    <div className="pattern-wr-table-wrap">
                      {(job.items || []).length === 0 ? (
                        <p className="pattern-wr-empty">
                          {job.status === "running" ? "扫描中，该筛选下暂无已结算信号" : "该筛选下暂无信号"}
                        </p>
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
