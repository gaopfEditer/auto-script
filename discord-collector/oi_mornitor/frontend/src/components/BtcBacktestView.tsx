import { memo, useCallback, useEffect, useMemo, useState } from "react";

export interface BacktestFuturePoint {
  offset_h: number;
  time_iso: string;
  close: number;
  high: number;
  low: number;
  raw_ret_pct: number;
  dir_ret_pct: number;
}

export interface BacktestOutcome {
  eval_side: string;
  signal_side: string;
  future_bars_available: number;
  price_1h: number | null;
  price_4h: number | null;
  price_8h: number | null;
  price_24h: number | null;
  raw_ret_1h_pct: number | null;
  raw_ret_4h_pct: number | null;
  raw_ret_8h_pct: number | null;
  raw_ret_24h_pct: number | null;
  dir_ret_1h_pct: number | null;
  dir_ret_4h_pct: number | null;
  dir_ret_8h_pct: number | null;
  dir_ret_24h_pct: number | null;
  mfe_4h_pct: number;
  mae_4h_pct: number;
  fav_4h_price: number;
  adv_4h_price: number;
  mfe_8h_pct: number;
  mae_8h_pct: number;
  fav_8h_price: number;
  adv_8h_price: number;
  mfe_24h_pct: number;
  mae_24h_pct: number;
  fav_24h_price: number;
  adv_24h_price: number;
  verdict: string;
  verdict_label: string;
  future_path: BacktestFuturePoint[];
  realized_pct?: number | null;
  realized_r?: number | null;
  settlement?: string | null;
  tight_sl_sim?: {
    status?: string;
    result?: string;
    sim_outcome?: string;
    sim_label?: string;
    label?: string;
    summary?: string;
    realized_r?: number;
    realized_pct?: number;
    realized_pct_gross?: number;
    realized_pct_net?: number;
    fee_total_pct?: number;
    hit_tp1?: boolean;
    hit_tp2?: boolean;
    hit_sl?: boolean;
    moved_be?: boolean;
    bars_held?: number;
    bars_to_resolve?: number;
    legs?: Array<{ size: number; price: number; pnl_pct: number; why: string }>;
    exit_price?: number | null;
    settlement?: string;
  } | null;
}

export interface BacktestSignalItem {
  id: string;
  seq: number;
  bar_open_sec: number;
  bar_close_sec: number;
  bar_open_iso: string;
  bar_close_iso: string;
  ts: string;
  symbol: string;
  symbol_base?: string;
  timeframe: string;
  signal_name: string;
  signal_kinds: string[];
  signal_sources: string[];
  signal_side: "long" | "short";
  price: number;
  candle: {
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
  };
  gate_result: "pass" | "reject";
  gate_reasons: string[];
  action: "LONG" | "SHORT" | "WATCH" | "NO_TRADE";
  ai_status?: "judged" | "skipped" | "error" | "gate_blocked" | string;
  llm_error?: string | null;
  soft_gate?: boolean;
  analysis_only?: boolean;
  confidence: number | null;
  confidence_pct?: number | null;
  confidence_band?: string | null;
  tight_sl_strategy?: Record<string, any> | null;
  composite_trade_plan?: Record<string, any> | null;
  trade_plan?: Record<string, any> | null;
  entry?: any;
  sl?: any;
  tp?: any;
  trail?: string | null;
  entry_watch: string | null;
  sl_watch: string | null;
  conflicts: string[];
  evidence_refs: string[];
  rationale: string | null;
  formatted_text?: string;
  llm?: {
    technical?: Record<string, unknown>;
    flow_oi?: Record<string, unknown>;
    bull?: Record<string, unknown>;
    bear?: Record<string, unknown>;
    trader?: Record<string, unknown>;
  } | null;
  snapshot: Record<string, any>;
  no_lookahead_proof: {
    strict_cutoff_close_iso: string;
    strict_cutoff_close_ms: number;
    bars_fed: Record<string, number>;
    htf_partial_synthesized: boolean;
    future_bars_exposed_to_agent: number;
  };
  outcome: BacktestOutcome;
}

export interface BacktestPatternStat {
  pattern: string;
  total: number;
  gate_pass: number;
  gate_reject: number;
  saved_count: number;
  avg_dir_ret_4h_pct: number;
  avg_mfe_4h_pct: number;
  avg_mfe_8h_pct: number;
}

export interface BacktestSummary {
  window_start: string;
  window_end: string;
  days: number;
  total_signals: number;
  gate_pass_count: number;
  gate_reject_count: number;
  gate_pass_rate_pct: number;
  action_counts: Record<string, number>;
  ai_status_counts?: Record<string, number>;
  ai_judged_count?: number;
  ai_do_count?: number;
  ai_dont_count?: number;
  ai_error_count?: number;
  ai_skipped_count?: number;
  active_trade_count: number;
  ai_win_rate_4h_pct: number | null;
  ai_win_rate_8h_pct: number | null;
  ai_avg_ret_4h_pct: number;
  ai_avg_ret_8h_pct: number;
  ai_avg_mfe_4h_pct: number;
  ai_avg_mae_4h_pct: number;
  ai_avg_mfe_8h_pct: number;
  ai_avg_mae_8h_pct: number;
  gate_pass_win_rate_4h_pct: number;
  gate_pass_win_rate_8h_pct: number;
  gate_pass_avg_ret_4h_pct: number;
  gate_pass_avg_ret_8h_pct: number;
  gate_pass_avg_mfe_4h_pct: number;
  gate_pass_avg_mae_4h_pct: number;
  gate_pass_avg_mfe_8h_pct: number;
  gate_pass_avg_mae_8h_pct: number;
  raw_all_win_rate_4h_pct: number;
  raw_all_win_rate_8h_pct: number;
  raw_all_avg_ret_4h_pct: number;
  raw_all_avg_ret_8h_pct: number;
  saved_by_gate_count: number;
  saved_by_ai_count: number;
  total_saved_count: number;
  missed_by_gate_count: number;
  missed_by_ai_count: number;
  verdict_counts: Record<string, number>;
  pattern_stats: BacktestPatternStat[];
  tight_sl_15m_stats?: {
    total_signals: number;
    high_conf_count: number;
    sim_evaluated_count: number;
    sim_tp_win_count: number;
    sim_be_count: number;
    sim_sl_loss_count: number;
    sim_tp_win_rate_pct: number | null;
    sim_non_loss_rate_pct: number | null;
    avg_realized_r: number | null;
    avg_sl_pct: number | null;
    avg_confidence_pct: number | null;
  } | null;
  elapsed_sec: number;
  provider?: {
    provider?: string;
    quick_model?: string;
    deep_model?: string;
  };
}

export interface BacktestResponse {
  ok: boolean;
  generated_at: string;
  symbol: string;
  symbol_base?: string;
  symbols?: string[];
  symbol_bases?: string[];
  timeframe: string;
  timeframes?: string[];
  days: number;
  start?: string;
  end?: string;
  skip_llm: boolean;
  llm_mode?: string;
  max_llm_signals?: number;
  soft_ai_top_n?: number;
  llm_errors?: string[];
  summary: BacktestSummary;
  items: BacktestSignalItem[];
  from_cache?: boolean;
  error?: string;
}

interface Props {
  onOpenChartAt?: (symbol: string, tf: string, barOpenSec?: number) => void;
}

const ALL_TFS = ["15m", "1h", "4h", "1d"] as const;
const QUICK_SYMBOLS = ["BTC", "ETH", "QQQ", "SNDK", "DOGE", "UNI", "NEAR"] as const;
const BT_UI_CACHE_KEY = "oi_mornitor.btc_backtest.ui_controls.v1";

function formatNetworkErr(e: unknown): string {
  const raw = e instanceof Error ? e.message : String(e);
  if (/Failed to fetch|NetworkError|Load failed|network error/i.test(raw)) {
    return "连不上本机回测接口（8765）。多半是 OI 服务刚重启或瞬时断连，不是币安封禁；请硬刷新后重试。若仍失败再查 oi_mornitor 是否在跑。";
  }
  return raw;
}

type BtUiCache = {
  selectedSymbols?: string[];
  symbolFilter?: string[];
  selectedTfs?: string[];
  startLocal?: string;
  endLocal?: string;
  preferSkipLlm?: boolean;
  maxLlmSignals?: number;
  softAiTopN?: number;
  llmMode?: string;
};

function loadBtUiCache(): BtUiCache {
  try {
    const raw = localStorage.getItem(BT_UI_CACHE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as BtUiCache;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

function saveBtUiCache(patch: BtUiCache) {
  try {
    const prev = loadBtUiCache();
    localStorage.setItem(BT_UI_CACHE_KEY, JSON.stringify({ ...prev, ...patch }));
  } catch {
    /* ignore quota / private mode */
  }
}

function normSymList(arr: unknown, fallback: string[]): string[] {
  if (!Array.isArray(arr)) return fallback;
  const out: string[] = [];
  for (const x of arr) {
    const s = String(x || "")
      .trim()
      .toUpperCase()
      .replace(/USDT$/i, "");
    if (s && !out.includes(s)) out.push(s);
  }
  return out.length ? out : fallback;
}

function symbolBaseOf(item: { symbol?: string; symbol_base?: string } | null | undefined): string {
  if (!item) return "";
  if (item.symbol_base) return String(item.symbol_base).toUpperCase();
  return String(item.symbol || "").replace(/USDT$/i, "").toUpperCase();
}

function defaultStartLocal(): string {
  const d = new Date();
  d.setDate(d.getDate() - 7);
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function defaultEndLocal(): string {
  const d = new Date();
  d.setMinutes(0, 0, 0);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function tfBadgeColor(tf: string): { bg: string; color: string } {
  switch (tf) {
    case "15m":
      return { bg: "rgba(159, 122, 234, 0.22)", color: "#d6bcfa" };
    case "1h":
      return { bg: "rgba(66, 153, 225, 0.22)", color: "#90cdf4" };
    case "4h":
      return { bg: "rgba(237, 137, 54, 0.22)", color: "#fbd38d" };
    case "1d":
      return { bg: "rgba(72, 187, 120, 0.22)", color: "#9ae6b4" };
    default:
      return { bg: "rgba(160,174,192,0.2)", color: "#cbd5e0" };
  }
}

function fmtPct(v: number | null | undefined, showPlus = true): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  const sign = showPlus && n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function pctColor(v: number | null | undefined): string {
  if (v === null || v === undefined || Number.isNaN(Number(v))) return "#a0aec0";
  if (v > 0.05) return "#48bb78";
  if (v < -0.05) return "#f56565";
  return "#cbd5e0";
}


/** 单笔已实现盈亏%：必须按该笔入场/止损/TP1/TP2/移损结算；有价位时绝不拿 dir_ret 冒充。
 *  默认返回净盈亏（扣 ~万4/边手续费）；传 preferNet=false 取毛利。 */
function tradeRealizedPnlPct(
  item: BacktestSignalItem,
  preferNet: boolean = true,
): { pct: number; source: "sl_tp_sim" | "dir_ret_4h"; gross?: number; net?: number; fee?: number } | null {
  const o = item.outcome || ({} as BacktestOutcome);
  const sim = o.tight_sl_sim;
  const simStatus = String((sim as any)?.status || (sim as any)?.sim_outcome || "");
  if (sim && simStatus !== "pending") {
    const grossRaw = (sim as any).realized_pct_gross ?? sim.realized_pct ?? (o as any).realized_pct_gross ?? o.realized_pct;
    if (grossRaw != null && !Number.isNaN(Number(grossRaw))) {
      const gross = Number(grossRaw);
      const fee =
        (sim as any).fee_total_pct != null && !Number.isNaN(Number((sim as any).fee_total_pct))
          ? Number((sim as any).fee_total_pct)
          : 0.08;
      const netRaw = (sim as any).realized_pct_net ?? (o as any).realized_pct_net;
      const net = netRaw != null && !Number.isNaN(Number(netRaw)) ? Number(netRaw) : gross - fee;
      return { pct: preferNet ? net : gross, source: "sl_tp_sim", gross, net, fee };
    }
  }
  if (o.realized_pct != null && !Number.isNaN(Number(o.realized_pct))) {
    const gross = Number((o as any).realized_pct_gross ?? o.realized_pct);
    const fee = Number((o as any).fee_total_pct ?? 0.08);
    const net = Number((o as any).realized_pct_net ?? gross - fee);
    return { pct: preferNet ? net : gross, source: "sl_tp_sim", gross, net, fee };
  }
  const t = item.tight_sl_strategy;
  const hasLevels = Boolean(
    (t?.matched && t?.entry && t?.sl && (t?.tp1 || t?.tp)) ||
      (item.entry != null && item.sl != null && item.tp != null),
  );
  // 有入场止盈止损价位但尚未跑出结算 → 不计入总和，绝不拿 4h 顺向收益凑数
  if (hasLevels) return null;
  const d4 = o.dir_ret_4h_pct;
  if (d4 != null && !Number.isNaN(Number(d4))) {
    return { pct: Number(d4), source: "dir_ret_4h" };
  }
  return null;
}


function planOf(item: BacktestItem): Record<string, any> | null {
  const tp = (item as any).trade_plan;
  if (tp && typeof tp === "object" && (tp.entry != null || tp.sl != null)) return tp;
  const cp = (item as any).composite_trade_plan;
  if (cp && typeof cp === "object" && (cp.entry != null || cp.sl != null)) return cp;
  const ts = item.tight_sl_strategy;
  if (ts && typeof ts === "object" && ((ts as any).entry != null || (ts as any).matched)) return ts as any;
  return null;
}

function tightSlSimLabel(item: BacktestSignalItem): string {
  const sim = item.outcome?.tight_sl_sim as any;
  if (!sim) return "";
  return String(sim.sim_label || sim.label || sim.summary || "");
}

function verdictStyle(verdict: string): { bg: string; border: string; color: string } {
  switch (verdict) {
    case "ai_win":
      return { bg: "rgba(72, 187, 120, 0.18)", border: "rgba(72, 187, 120, 0.55)", color: "#68d391" };
    case "ai_loss":
      return { bg: "rgba(245, 101, 101, 0.18)", border: "rgba(245, 101, 101, 0.55)", color: "#fc8181" };
    case "gate_saved":
    case "ai_saved":
      return { bg: "rgba(56, 178, 172, 0.18)", border: "rgba(56, 178, 172, 0.5)", color: "#4fd1c5" };
    case "gate_missed":
    case "ai_missed":
      return { bg: "rgba(237, 137, 54, 0.18)", border: "rgba(237, 137, 54, 0.5)", color: "#f6ad55" };
    default:
      return { bg: "rgba(160, 174, 192, 0.14)", border: "rgba(160, 174, 192, 0.35)", color: "#cbd5e0" };
  }
}

function actionBadgeStyle(
  action: string,
  gatePass: boolean,
  aiStatus?: string | null,
): { bg: string; color: string; label: string } {
  const st = String(aiStatus || "").toLowerCase();
  if (!gatePass && st !== "judged") {
    return { bg: "rgba(113, 128, 150, 0.22)", color: "#a0aec0", label: "门禁拦截" };
  }
  if (st === "skipped") {
    return { bg: "rgba(159, 122, 234, 0.22)", color: "#d6bcfa", label: "⏸ 未跑AI（仅门禁）" };
  }
  if (st === "error") {
    return { bg: "rgba(245, 101, 101, 0.28)", color: "#feb2b2", label: "⚠ AI失败" };
  }
  if (!gatePass && st === "judged") {
    return { bg: "rgba(236, 201, 75, 0.18)", color: "#f6e05e", label: "软分析·门禁已拒" };
  }
  switch (action) {
    case "LONG":
      return { bg: "rgba(72, 187, 120, 0.22)", color: "#68d391", label: "🟢 LONG 做多" };
    case "SHORT":
      return { bg: "rgba(245, 101, 101, 0.22)", color: "#fc8181", label: "🔴 SHORT 做空" };
    case "WATCH":
      return { bg: "rgba(236, 201, 75, 0.22)", color: "#f6e05e", label: "🟡 WATCH 观察" };
    default:
      return { bg: "rgba(160, 174, 192, 0.22)", color: "#cbd5e0", label: "⚪ NO_TRADE 不做" };
  }
}

export const BtcBacktestView = memo(function BtcBacktestView({ onOpenChartAt }: Props) {
  const [data, setData] = useState<BacktestResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [runningMode, setRunningMode] = useState<"full" | "fast" | null>(null);
  const [progressText, setProgressText] = useState("");
  const [err, setErr] = useState("");
  const [filterMode, setFilterMode] = useState<string>("all");
  const [sideFilter, setSideFilter] = useState<string>("all");
  const [verdictFilter, setVerdictFilter] = useState<string>("all");
  const [patternFilter, setPatternFilter] = useState<string>("all");
  const [tfFilter, setTfFilter] = useState<string>("all");
  const [searchQ, setSearchQ] = useState<string>("");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [copiedText, setCopiedText] = useState(false);

  const cachedUi = useMemo(() => loadBtUiCache(), []);
  const [selectedSymbols, setSelectedSymbols] = useState<string[]>(() =>
    normSymList(cachedUi.selectedSymbols, ["BTC"]),
  );
  const [customSymbolDraft, setCustomSymbolDraft] = useState<string>("");
  const [filterCustomDraft, setFilterCustomDraft] = useState<string>("");
  const [symbolFilter, setSymbolFilter] = useState<string[]>(() => normSymList(cachedUi.symbolFilter, []));
  const [selectedTfs, setSelectedTfs] = useState<string[]>(() => {
    const tfs = Array.isArray(cachedUi.selectedTfs) ? cachedUi.selectedTfs.map(String) : [];
    return tfs.length ? tfs : ["1h"];
  });
  const [startLocal, setStartLocal] = useState<string>(
    cachedUi.startLocal && cachedUi.startLocal.length >= 10 ? cachedUi.startLocal : defaultStartLocal(),
  );
  const [endLocal, setEndLocal] = useState<string>(
    cachedUi.endLocal && cachedUi.endLocal.length >= 10 ? cachedUi.endLocal : defaultEndLocal(),
  );
  const [maxLlmSignals, setMaxLlmSignals] = useState<number>(
    typeof cachedUi.maxLlmSignals === "number" ? cachedUi.maxLlmSignals : 12,
  );
  const [softAiTopN, setSoftAiTopN] = useState<number>(
    typeof cachedUi.softAiTopN === "number" ? cachedUi.softAiTopN : 0,
  );
  const [llmMode, setLlmMode] = useState<string>(cachedUi.llmMode || "trader_only");

  const loadBacktest = useCallback(async () => {
    setLoading(true);
    setErr("");
    try {
      const r = await fetch("/api/ai-judge/backtest-btc");
      if (!r.ok) throw new Error(`HTTP ${r.status}`);
      const d = (await r.json()) as BacktestResponse;
      setData(d);
      // Keep localStorage-restored run controls; do not clobber with last cache response.
      if (d?.items?.length && !selectedId) {
        const firstPass = d.items.find((x) => x.gate_result === "pass") || d.items[0];
        setSelectedId(firstPass.id);
      }
    } catch (e) {
      setErr(formatNetworkErr(e));
    } finally {
      setLoading(false);
    }
  }, [selectedId]);

  useEffect(() => {
    void loadBacktest();
  }, [loadBacktest]);

  const toggleTf = useCallback((tf: string) => {
    setSelectedTfs((prev) => {
      if (prev.includes(tf)) {
        const next = prev.filter((x) => x !== tf);
        return next.length ? next : prev;
      }
      return [...prev, tf];
    });
  }, []);

  const toggleSymbol = useCallback((sym: string) => {
    const s = sym.trim().toUpperCase();
    if (!s) return;
    setSelectedSymbols((prev) => {
      if (prev.includes(s)) {
        const next = prev.filter((x) => x !== s);
        return next.length ? next : prev;
      }
      return [...prev, s];
    });
  }, []);

  const addCustomSymbol = useCallback(() => {
    const s = customSymbolDraft.trim().toUpperCase().replace(/USDT$/i, "");
    if (!s) return;
    setSelectedSymbols((prev) => (prev.includes(s) ? prev : [...prev, s]));
    setCustomSymbolDraft("");
  }, [customSymbolDraft]);

  const toggleSymbolFilter = useCallback((sym: string) => {
    const s = sym.trim().toUpperCase();
    setSymbolFilter((prev) => (prev.includes(s) ? prev.filter((x) => x !== s) : [...prev, s]));
  }, []);

  const addCustomFilterSymbol = useCallback(() => {
    const s = filterCustomDraft.trim().toUpperCase().replace(/USDT$/i, "");
    if (!s) return;
    setSymbolFilter((prev) => (prev.includes(s) ? prev : [...prev, s]));
    setFilterCustomDraft("");
  }, [filterCustomDraft]);

  // Persist run + filter controls (same pattern as tokens)
  useEffect(() => {
    saveBtUiCache({
      selectedSymbols,
      symbolFilter,
      selectedTfs,
      startLocal,
      endLocal,
      maxLlmSignals,
      softAiTopN,
      llmMode,
    });
  }, [selectedSymbols, symbolFilter, selectedTfs, startLocal, endLocal, maxLlmSignals, softAiTopN, llmMode]);

  const applyBacktestPayload = useCallback((d: any) => {
    const itemCount = Array.isArray(d?.items) ? d.items.length : 0;
    const symErrs: string[] = [];
    const rawErrs = d?.errors || d?.summary?.symbol_errors || [];
    if (Array.isArray(rawErrs)) {
      for (const e of rawErrs) {
        if (typeof e === "string") symErrs.push(e);
        else if (e && (e.symbol || e.error)) symErrs.push(`${e.symbol || "?"}: ${e.error || JSON.stringify(e)}`);
      }
    }
    setData(d as BacktestResponse);
    const progMsg = d?.progress?.message ? String(d.progress.message) : "";
    if (progMsg) setProgressText(progMsg);
    if (symErrs.length) {
      setErr(`部分币种失败（其余结果已展示）：${symErrs.join("；")}`);
    } else if (d?.ok === false && d?.error && itemCount === 0) {
      setErr(String(d.error));
    } else if (d?.status === "error" && d?.error && itemCount === 0) {
      setErr(String(d.error));
    } else if (!symErrs.length) {
      setErr("");
    }
    if (d?.items?.length) {
      setSelectedId((prev) => {
        if (prev && d.items.some((x: BacktestSignalItem) => x.id === prev)) return prev;
        const firstPass = d.items.find((x: BacktestSignalItem) => x.gate_result === "pass") || d.items[0];
        return firstPass?.id ?? prev;
      });
    }
    return { itemCount, symErrs };
  }, []);

  const runBacktest = useCallback(async (skipLlm: boolean, forceRefresh = false) => {
    setRunningMode(skipLlm ? "fast" : "full");
    setErr("");
    setProgressText(skipLlm ? "启动门禁回测…" : "启动 AI 回测…");
    try {
      const syms = selectedSymbols.length ? selectedSymbols : ["BTC"];
      saveBtUiCache({
        selectedSymbols: syms,
        symbolFilter,
        selectedTfs,
        startLocal,
        endLocal,
        preferSkipLlm: skipLlm,
        maxLlmSignals,
        softAiTopN,
        llmMode,
      });
      const body = {
        symbols: syms,
        symbol: syms[0],
        timeframes: selectedTfs,
        start: startLocal,
        end: endLocal,
        skip_llm: skipLlm,
        force_refresh: forceRefresh,
        llm_mode: llmMode || "trader_only",
        max_llm_signals: maxLlmSignals,
        soft_ai_top_n: softAiTopN,
        include_tight_sl_signals: false,
      };
      const r = await fetch("/api/ai-judge/backtest-btc/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let d: any = null;
      try {
        d = await r.json();
      } catch {
        throw new Error(`回测响应非 JSON (HTTP ${r.status}) — 服务可能已重启或超时，请重试`);
      }
      if (!r.ok && !d?.job_id) {
        throw new Error(d?.error || `HTTP ${r.status}`);
      }

      // Async progressive job path
      if (d?.job_id && d?.done !== true) {
        applyBacktestPayload(d);
        const jobId = String(d.job_id);
        const started = Date.now();
        const maxWaitMs = skipLlm ? 15 * 60 * 1000 : 45 * 60 * 1000;
        while (Date.now() - started < maxWaitMs) {
          await new Promise((res) => setTimeout(res, 1200));
          const pr = await fetch(`/api/ai-judge/backtest-btc/job/${encodeURIComponent(jobId)}`);
          let pd: any = null;
          try {
            pd = await pr.json();
          } catch {
            setProgressText(`轮询响应异常 HTTP ${pr.status}，重试中…`);
            continue;
          }
          if (pr.status === 404) {
            throw new Error(pd?.error || "回测任务丢失（服务可能已重启），请重新运行");
          }
          applyBacktestPayload(pd);
          if (pd?.done || pd?.status === "done" || pd?.status === "error") {
            if (pd?.status === "error" && !(pd?.items?.length)) {
              throw new Error(pd?.error || "回测失败");
            }
            break;
          }
        }
        return;
      }

      // Sync / already-done payload
      const { itemCount, symErrs } = applyBacktestPayload(d);
      if (itemCount === 0 && (!r.ok || d?.ok === false)) {
        throw new Error(d?.error || symErrs.join("；") || `HTTP ${r.status}`);
      }
    } catch (e) {
      setErr(formatNetworkErr(e));
    } finally {
      setRunningMode(null);
      setProgressText("");
    }
  }, [selectedSymbols, selectedTfs, startLocal, endLocal, symbolFilter, maxLlmSignals, softAiTopN, llmMode, applyBacktestPayload]);

  /** 一键：BTC+ETH · 仅 15m · 门禁+小止损量化回测，并切到 15m小止损筛选 */
  const runTightSl15m = useCallback(async () => {
    const syms = ["BTC", "ETH"];
    const tfs = ["15m"];
    setSelectedSymbols(syms);
    setSelectedTfs(tfs);
    setFilterMode("tight_sl_15m");
    setSymbolFilter([]);
    setRunningMode("fast");
    setErr("");
    setProgressText("启动 15min 小止损回测…");
    try {
      saveBtUiCache({
        selectedSymbols: syms,
        symbolFilter: [],
        selectedTfs: tfs,
        startLocal,
        endLocal,
        preferSkipLlm: true,
        maxLlmSignals,
        softAiTopN,
        llmMode,
      });
      const body = {
        symbols: syms,
        symbol: "BTC",
        timeframes: tfs,
        start: startLocal,
        end: endLocal,
        skip_llm: true,
        force_refresh: true,
        llm_mode: llmMode || "trader_only",
        max_llm_signals: maxLlmSignals,
        soft_ai_top_n: softAiTopN,
        include_tight_sl_signals: true,
      };
      const r = await fetch("/api/ai-judge/backtest-btc/run", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      let d: any = null;
      try {
        d = await r.json();
      } catch {
        throw new Error(`回测响应非 JSON (HTTP ${r.status}) — 服务可能已重启或超时，请重试`);
      }
      if (!r.ok && !d?.job_id) {
        throw new Error(d?.error || `HTTP ${r.status}`);
      }
      if (d?.job_id && d?.done !== true) {
        applyBacktestPayload(d);
        const jobId = String(d.job_id);
        const started = Date.now();
        const maxWaitMs = 15 * 60 * 1000;
        while (Date.now() - started < maxWaitMs) {
          await new Promise((res) => setTimeout(res, 1200));
          const pr = await fetch(`/api/ai-judge/backtest-btc/job/${encodeURIComponent(jobId)}`);
          let pd: any = null;
          try {
            pd = await pr.json();
          } catch {
            setProgressText(`轮询响应异常 HTTP ${pr.status}，重试中…`);
            continue;
          }
          if (pr.status === 404) {
            throw new Error(pd?.error || "回测任务丢失（服务可能已重启），请重新运行");
          }
          applyBacktestPayload(pd);
          if (pd?.done || pd?.status === "done" || pd?.status === "error") {
            if (pd?.status === "error" && !(pd?.items?.length)) {
              throw new Error(pd?.error || "回测失败");
            }
            break;
          }
        }
        return;
      }
      const { itemCount, symErrs } = applyBacktestPayload(d);
      if (itemCount === 0 && (!r.ok || d?.ok === false)) {
        throw new Error(d?.error || symErrs.join("；") || `HTTP ${r.status}`);
      }
    } catch (e) {
      setErr(formatNetworkErr(e));
    } finally {
      setRunningMode(null);
      setProgressText("");
    }
  }, [startLocal, endLocal, maxLlmSignals, softAiTopN, llmMode, applyBacktestPayload]);

  const items = data?.items ?? [];
  const summary = data?.summary;

  const filteredItems = useMemo(() => {
    return items.filter((item) => {
      if (filterMode === "tight_sl_15m") {
        const ts = item.tight_sl_strategy as any;
        const isTight =
          Boolean(ts?.matched) &&
          (ts?.plan_kind === "tight_sl_15m" || ts?.strategy_id === "tight_sl_15m" || Boolean(ts?.should_enter));
        if (!isTight) return false;
      }
      if (filterMode === "gate_pass" && item.gate_result !== "pass") return false;
      if (filterMode === "gate_reject" && item.gate_result !== "reject") return false;
      if (filterMode === "active_ai") {
        if (item.action !== "LONG" && item.action !== "SHORT") return false;
        if (item.ai_status && item.ai_status !== "judged") return false;
      }
      if (filterMode === "LONG" && item.action !== "LONG") return false;
      if (filterMode === "SHORT" && item.action !== "SHORT") return false;
      if (filterMode === "ai_wait") {
        if (item.gate_result !== "pass") return false;
        if (item.ai_status === "skipped" || item.ai_status === "error") return false;
        if (item.action !== "NO_TRADE" && item.action !== "WATCH") return false;
      }
      if (filterMode === "ai_error" && item.ai_status !== "error") return false;
      if (filterMode === "ai_skipped" && item.ai_status !== "skipped") return false;

      if (sideFilter !== "all" && item.signal_side !== sideFilter) return false;
      if (tfFilter !== "all" && item.timeframe !== tfFilter) return false;
      if (symbolFilter.length > 0) {
        const base = symbolBaseOf(item);
        if (!symbolFilter.includes(base)) return false;
      }

      if (verdictFilter === "win" && item.outcome.verdict !== "ai_win") return false;
      if (verdictFilter === "saved" && item.outcome.verdict !== "gate_saved" && item.outcome.verdict !== "ai_saved") return false;
      if (verdictFilter === "missed" && item.outcome.verdict !== "gate_missed" && item.outcome.verdict !== "ai_missed") return false;
      if (verdictFilter === "loss" && item.outcome.verdict !== "ai_loss") return false;

      if (patternFilter !== "all" && !item.signal_name.includes(patternFilter)) return false;

      if (searchQ.trim()) {
        const q = searchQ.trim().toLowerCase();
        const hay = `${item.signal_name} ${item.timeframe} ${item.symbol} ${item.bar_open_iso} ${item.rationale || ""} ${(item.gate_reasons || []).join(" ")}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    });
  }, [items, filterMode, sideFilter, verdictFilter, patternFilter, tfFilter, symbolFilter, searchQ]);

  /** Totals for the currently filtered table rows (币种筛选等全部生效). */
  const filteredTotals = useMemo(() => {
    const rows = filteredItems;
    const n = rows.length;
    let gatePass = 0;
    let gateReject = 0;
    let aiJudged = 0;
    let aiDo = 0;
    let aiDont = 0;
    let aiSkipped = 0;
    let aiError = 0;
    let aiGateBlocked = 0;

    const winBuckets: Record<string, { n: number; wins: number; sum: number }> = {
      "1h": { n: 0, wins: 0, sum: 0 },
      "4h": { n: 0, wins: 0, sum: 0 },
      "8h": { n: 0, wins: 0, sum: 0 },
    };

    // Totals sample follows active filter chips. Selecting 「门禁通过」 MUST use that
    // gate-pass set (composite SL/TP sums) — never silently shrink to tiny AI做.
    // On 「全部」: prefer AI做 only when n is large enough; else fall back to 门禁过.
    const isTightFilter = filterMode === "tight_sl_15m";
    const isGatePassFilter = filterMode === "gate_pass";
    const isAiDoFilter =
      filterMode === "active_ai" || filterMode === "LONG" || filterMode === "SHORT";
    const doRows = rows.filter(
      (x) =>
        (x.ai_status === "judged" && (x.action === "LONG" || x.action === "SHORT")) ||
        (isTightFilter &&
          Boolean(x.tight_sl_strategy?.should_enter) &&
          (x.action === "LONG" || x.action === "SHORT")),
    );
    const enterGateRows = isTightFilter
      ? rows.filter((x) => x.gate_result === "pass" && Boolean(x.tight_sl_strategy?.should_enter))
      : [];
    const gatePassRows = rows.filter((x) => x.gate_result === "pass");

    let wrSource = rows;
    let wrLabel = "筛选集";
    if (isGatePassFilter) {
      // Explicit chip: 门禁通过 → all filtered gate-pass rows (already == rows)
      wrSource = rows;
      wrLabel = "门禁过";
    } else if (isAiDoFilter) {
      wrSource = rows;
      wrLabel = "AI做";
    } else if (isTightFilter) {
      if (doRows.length > 0) {
        wrSource = doRows;
        wrLabel = "AI做";
      } else if (enterGateRows.length > 0) {
        wrSource = enterGateRows;
        wrLabel = "门禁过·可入场";
      } else if (gatePassRows.length > 0) {
        wrSource = gatePassRows;
        wrLabel = "门禁过";
      } else {
        wrSource = rows;
        wrLabel = "筛选集";
      }
    } else if (
      filterMode === "ai_wait" ||
      filterMode === "ai_skipped" ||
      filterMode === "ai_error" ||
      filterMode === "gate_reject"
    ) {
      wrSource = rows;
      wrLabel = "筛选集";
    } else {
      // all / other: AI做 only if sample is large enough; else 门禁过 for 参考价值
      const gateN = gatePassRows.length;
      const minAiDo = Math.max(20, Math.ceil(gateN * 0.3));
      if (doRows.length >= minAiDo) {
        wrSource = doRows;
        wrLabel = "AI做";
      } else if (gatePassRows.length > 0) {
        wrSource = gatePassRows;
        wrLabel = "门禁过";
      } else {
        wrSource = rows;
        wrLabel = "筛选集";
      }
    }

    for (const x of rows) {
      if (x.gate_result === "pass") gatePass += 1;
      else if (x.gate_result === "reject") gateReject += 1;
      const st = String(x.ai_status || "").toLowerCase();
      if (st === "judged") {
        aiJudged += 1;
        if (x.action === "LONG" || x.action === "SHORT") aiDo += 1;
        else aiDont += 1;
      } else if (st === "skipped") aiSkipped += 1;
      else if (st === "error") aiError += 1;
      else if (st === "gate_blocked") aiGateBlocked += 1;
    }

    let pnlSum = 0;
    let pnlSumGross = 0;
    let pnlSumNet = 0;
    let pnlFeeSum = 0;
    let pnlN = 0;
    let pnlWins = 0;
    let pnlLosses = 0;
    let pnlFlat = 0;
    let pnlFromSim = 0;
    let pnlFromDir = 0;
    for (const x of wrSource) {
      const o = x.outcome || ({} as BacktestOutcome);
      for (const [key, field] of [
        ["1h", o.dir_ret_1h_pct],
        ["4h", o.dir_ret_4h_pct],
        ["8h", o.dir_ret_8h_pct],
      ] as const) {
        if (field == null || Number.isNaN(Number(field))) continue;
        const v = Number(field);
        winBuckets[key].n += 1;
        winBuckets[key].sum += v;
        if (v > 0) winBuckets[key].wins += 1;
      }
      // 总盈亏率：默认净盈亏（扣手续费）；同时累计毛利
      const one = tradeRealizedPnlPct(x, true);
      if (!one) continue;
      pnlSum += one.pct;
      pnlSumGross += one.gross != null ? one.gross : one.pct;
      pnlSumNet += one.net != null ? one.net : one.pct;
      pnlFeeSum += one.fee != null ? one.fee : 0;
      pnlN += 1;
      if (one.source === "sl_tp_sim") pnlFromSim += 1;
      else pnlFromDir += 1;
      if (one.pct > 0) pnlWins += 1;
      else if (one.pct < 0) pnlLosses += 1;
      else pnlFlat += 1;
    }

    const wr = (k: string) => {
      const b = winBuckets[k];
      if (!b.n) return null as number | null;
      return Math.round((1000 * b.wins) / b.n) / 10;
    };
    const totalPnlPct = pnlN ? Math.round(pnlSum * 100) / 100 : (null as number | null);
    const totalPnlGrossPct = pnlN ? Math.round(pnlSumGross * 100) / 100 : (null as number | null);
    const totalPnlNetPct = pnlN ? Math.round(pnlSumNet * 100) / 100 : (null as number | null);
    const totalFeePct = pnlN ? Math.round(pnlFeeSum * 100) / 100 : (null as number | null);
    const pnlSourceLabel =
      pnlN === 0
        ? ""
        : pnlFromSim > 0 && pnlFromDir === 0
          ? "入场止盈止损·已扣费"
          : pnlFromSim > 0
            ? "混合(入场止盈止损+4h兜底)"
            : "4h顺向收益兜底";

    return {
      total: n,
      allTotal: items.length,
      gatePass,
      gateReject,
      gatePassRate: n ? Math.round((1000 * gatePass) / n) / 10 : 0,
      aiJudged,
      aiDo,
      aiDont,
      aiSkipped,
      aiError,
      aiGateBlocked,
      wrLabel,
      wr1h: wr("1h"),
      wr4h: wr("4h"),
      wr8h: wr("8h"),
      totalPnlPct,
      totalPnlGrossPct,
      totalPnlNetPct,
      totalFeePct,
      pnlN,
      pnlWins,
      pnlLosses,
      pnlFlat,
      pnlSourceLabel,
      wrN: {
        "1h": winBuckets["1h"].n,
        "4h": winBuckets["4h"].n,
        "8h": winBuckets["8h"].n,
      },
    };
    }, [filteredItems, items.length, filterMode]);  const selectedItem = useMemo(() => {
    if (!items.length) return null;
    return items.find((x) => x.id === selectedId) || filteredItems[0] || items[0];
  }, [items, filteredItems, selectedId]);

  const resultSymbolBases = useMemo(() => {
    const set = new Set<string>();
    for (const it of items) {
      const b = symbolBaseOf(it);
      if (b) set.add(b);
    }
    return Array.from(set).sort();
  }, [items]);

  // Filter chips: union of presets + run selection + free-text filter + result bases
  const filterSymbolOptions = useMemo(() => {
    const set = new Set<string>();
    for (const s of QUICK_SYMBOLS) set.add(s);
    for (const s of selectedSymbols) if (s) set.add(s);
    for (const s of symbolFilter) if (s) set.add(s);
    for (const s of resultSymbolBases) if (s) set.add(s);
    return Array.from(set).sort((a, b) => a.localeCompare(b));
  }, [selectedSymbols, symbolFilter, resultSymbolBases]);

  const headerSymbolsLabel =
    (data?.symbol_bases && data.symbol_bases.length
      ? data.symbol_bases.join(" / ")
      : data?.symbol_base) ||
    selectedSymbols.join(" / ") ||
    "BTC";

  return (
    <div style={{ padding: "14px 18px", color: "#e2e8f0", maxWidth: 1680, margin: "0 auto" }}>
      {/* Top Banner */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          alignItems: "center",
          justifyContent: "space-between",
          gap: 12,
          padding: "14px 18px",
          borderRadius: 12,
          background: "linear-gradient(135deg, rgba(26,32,44,0.96) 0%, rgba(17,24,39,0.98) 100%)",
          border: "1px solid rgba(246, 173, 85, 0.4)",
          marginBottom: 14,
        }}
      >
        <div style={{ flex: 1, minWidth: 280 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
            <span style={{ fontSize: 18, fontWeight: 800, color: "#fbd38d" }}>
              📊 {headerSymbolsLabel} 多周期形态/命中信号 · 无未来数据 AI 历史回测
            </span>
            <span
              style={{
                padding: "3px 9px",
                borderRadius: 999,
                fontSize: 11.5,
                fontWeight: 700,
                background: "rgba(72, 187, 120, 0.18)",
                border: "1px solid rgba(72, 187, 120, 0.45)",
                color: "#68d391",
              }}
            >
              🔒 Strict Point-in-Time（无未来函数 · 未来K线暴露=0）
            </span>
            {summary?.provider?.deep_model && (
              <span
                style={{
                  padding: "2px 8px",
                  borderRadius: 6,
                  fontSize: 11.5,
                  background: "rgba(99, 179, 237, 0.15)",
                  color: "#90cdf4",
                }}
              >
                模型: {summary.provider.provider} / {summary.provider.deep_model}
              </span>
            )}
          </div>
          <div style={{ fontSize: 12, color: "#a0aec0", marginTop: 6 }}>
            回测区间（UTC+8）：<strong style={{ color: "#e2e8f0" }}>{summary?.window_start || startLocal.replace("T", " ")}</strong> 至{" "}
            <strong style={{ color: "#e2e8f0" }}>{summary?.window_end || endLocal.replace("T", " ")}</strong>
            {" · "}币种 <strong style={{ color: "#fbd38d" }}>{headerSymbolsLabel}</strong>
            {" · "}周期 <strong style={{ color: "#90cdf4" }}>{(data?.timeframes || selectedTfs).join(" / ")}</strong>
            {" · "}生成 {data?.generated_at || "—"}
          </div>
          {data && (
            <div style={{ marginTop: 8, display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
              {data.skip_llm ? (
                <span
                  style={{
                    padding: "3px 9px",
                    borderRadius: 999,
                    fontSize: 11.5,
                    fontWeight: 700,
                    background: "rgba(159,122,234,0.2)",
                    border: "1px solid rgba(159,122,234,0.55)",
                    color: "#d6bcfa",
                  }}
                >
                  ⏸ 本结果未跑 AI（skip_llm）· WATCH/NO_TRADE ≠ AI 决策 · 点「跑 AI」才有做/不做
                </span>
              ) : (
                <span
                  style={{
                    padding: "3px 9px",
                    borderRadius: 999,
                    fontSize: 11.5,
                    fontWeight: 700,
                    background: "rgba(72,187,120,0.16)",
                    border: "1px solid rgba(72,187,120,0.45)",
                    color: "#68d391",
                  }}
                >
                  🤖 AI 已研判 · mode={data.llm_mode || llmMode}
                  {typeof summary?.ai_judged_count === "number" ? ` · judged ${summary.ai_judged_count}` : ""}
                  {typeof summary?.ai_do_count === "number" ? ` · 做 ${summary.ai_do_count}` : ""}
                  {typeof summary?.ai_dont_count === "number" ? ` · 不做 ${summary.ai_dont_count}` : ""}
                  {typeof summary?.ai_error_count === "number" && summary.ai_error_count > 0
                    ? ` · 失败 ${summary.ai_error_count}`
                    : ""}
                </span>
              )}
              {Array.isArray(data.llm_errors) && data.llm_errors.length > 0 && (
                <span style={{ fontSize: 11, color: "#fc8181" }}>LLM错误: {data.llm_errors.slice(0, 2).join(" | ")}</span>
              )}
            </div>
          )}
        </div>

        <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
          <button
            type="button"
            disabled={runningMode !== null}
            onClick={() => void runBacktest(false, true)}
            style={{
              padding: "7px 13px",
              borderRadius: 8,
              border: "1px solid rgba(246, 173, 85, 0.65)",
              background: runningMode === "full" ? "rgba(246, 173, 85, 0.35)" : "rgba(237, 137, 54, 0.22)",
              color: "#fbd38d",
              fontWeight: 700,
              fontSize: 12.5,
              cursor: runningMode ? "wait" : "pointer",
            }}
          >
            {runningMode === "full"
              ? `⏳ ${progressText || `正在跑 AI（${llmMode === "full" ? "5席" : "trader_only"}）…`}`
              : `🤖 跑 AI 回测 (${llmMode === "full" ? "完整5席" : "trader_only"})`}
          </button>
          <button
            type="button"
            disabled={runningMode !== null}
            onClick={() => void runBacktest(true, true)}
            style={{
              padding: "7px 12px",
              borderRadius: 8,
              border: "1px solid rgba(99, 179, 237, 0.45)",
              background: runningMode === "fast" ? "rgba(99, 179, 237, 0.3)" : "rgba(49, 130, 206, 0.18)",
              color: "#90cdf4",
              fontWeight: 600,
              fontSize: 12,
              cursor: runningMode ? "wait" : "pointer",
            }}
          >
            {runningMode === "fast" ? `⏳ ${progressText || "正在跑门禁…"}` : "⚡ 仅跑门禁回测"}
          </button>
          <button
            type="button"
            onClick={() => void loadBacktest()}
            style={{
              padding: "7px 11px",
              borderRadius: 8,
              border: "1px solid rgba(160, 174, 192, 0.3)",
              background: "rgba(45, 55, 72, 0.65)",
              color: "#e2e8f0",
              fontSize: 12,
              cursor: "pointer",
            }}
          >
            🔄 刷新
          </button>
          <button
            type="button"
            disabled={runningMode !== null}
            onClick={() => void runTightSl15m()}
            title="BTC+ETH · 仅15m · 形态+支撑压力+均线小止损量化回测"
            style={{
              padding: "7px 12px",
              borderRadius: 8,
              border: "1px solid rgba(246, 173, 85, 0.7)",
              background: runningMode === "fast" ? "rgba(237, 137, 54, 0.35)" : "rgba(237, 137, 54, 0.22)",
              color: "#fbd38d",
              fontWeight: 700,
              fontSize: 12.5,
              cursor: runningMode ? "wait" : "pointer",
            }}
          >
            {runningMode === "fast" && progressText.includes("小止损")
              ? `⏳ ${progressText}`
              : "🎯 15min小止损"}
          </button>
        </div>
      </div>

      {/* Controls: symbol / TF / datetime */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "minmax(220px, 1.1fr) minmax(200px, 0.9fr) minmax(260px, 1.1fr)",
          gap: 12,
          padding: "12px 14px",
          borderRadius: 12,
          background: "rgba(26, 32, 44, 0.88)",
          border: "1px solid rgba(99, 179, 237, 0.28)",
          marginBottom: 14,
        }}
      >
        <div>
          <div style={{ fontSize: 11.5, color: "#a0aec0", marginBottom: 6, fontWeight: 700 }}>
            币种 Symbol（可多选 · 已选 {selectedSymbols.length}）
          </div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginBottom: 8 }}>
            {QUICK_SYMBOLS.map((s) => {
              const active = selectedSymbols.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleSymbol(s)}
                  style={{
                    padding: "3px 9px",
                    borderRadius: 999,
                    border: active ? "1px solid rgba(246,173,85,0.8)" : "1px solid rgba(160,174,192,0.28)",
                    background: active ? "rgba(237,137,54,0.28)" : "rgba(45,55,72,0.55)",
                    color: active ? "#fbd38d" : "#e2e8f0",
                    fontSize: 11.5,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  {active ? `✓ ${s}` : s}
                </button>
              );
            })}
            {selectedSymbols
              .filter((s) => !(QUICK_SYMBOLS as readonly string[]).includes(s))
              .map((s) => (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleSymbol(s)}
                  style={{
                    padding: "3px 9px",
                    borderRadius: 999,
                    border: "1px solid rgba(246,173,85,0.8)",
                    background: "rgba(237,137,54,0.28)",
                    color: "#fbd38d",
                    fontSize: 11.5,
                    fontWeight: 700,
                    cursor: "pointer",
                  }}
                >
                  ✓ {s} ✕
                </button>
              ))}
          </div>
          <div style={{ display: "flex", gap: 6 }}>
            <input
              value={customSymbolDraft}
              onChange={(e) => setCustomSymbolDraft(e.target.value.toUpperCase())}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  addCustomSymbol();
                }
              }}
              placeholder="手动添加如 SOL / AVAX / PEPE 后回车"
              style={{
                flex: 1,
                boxSizing: "border-box",
                padding: "7px 10px",
                borderRadius: 8,
                border: "1px solid rgba(160,174,192,0.35)",
                background: "rgba(17,24,39,0.9)",
                color: "#e2e8f0",
                fontSize: 13,
                fontWeight: 700,
                letterSpacing: 0.4,
              }}
            />
            <button
              type="button"
              onClick={() => addCustomSymbol()}
              style={{
                padding: "7px 12px",
                borderRadius: 8,
                border: "1px solid rgba(99,179,237,0.45)",
                background: "rgba(49,130,206,0.2)",
                color: "#90cdf4",
                fontWeight: 700,
                fontSize: 12,
                cursor: "pointer",
                whiteSpace: "nowrap",
              }}
            >
              添加
            </button>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11.5, color: "#a0aec0", marginBottom: 6, fontWeight: 700 }}>周期 Timeframes（可多选）</div>
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
            {ALL_TFS.map((tf) => {
              const on = selectedTfs.includes(tf);
              const c = tfBadgeColor(tf);
              return (
                <button
                  key={tf}
                  type="button"
                  onClick={() => toggleTf(tf)}
                  style={{
                    padding: "6px 12px",
                    borderRadius: 8,
                    border: on ? `1px solid ${c.color}` : "1px solid rgba(160,174,192,0.28)",
                    background: on ? c.bg : "rgba(45,55,72,0.45)",
                    color: on ? c.color : "#a0aec0",
                    fontSize: 12.5,
                    fontWeight: 800,
                    cursor: "pointer",
                  }}
                >
                  {on ? "✓ " : ""}{tf}
                </button>
              );
            })}
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11.5, color: "#a0aec0", marginBottom: 6, fontWeight: 700 }}>时间范围（Asia/Shanghai UTC+8）</div>
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 8 }}>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "#718096" }}>
              开始
              <input
                type="datetime-local"
                value={startLocal}
                onChange={(e) => setStartLocal(e.target.value)}
                style={{
                  padding: "6px 8px",
                  borderRadius: 8,
                  border: "1px solid rgba(160,174,192,0.35)",
                  background: "rgba(17,24,39,0.9)",
                  color: "#e2e8f0",
                  fontSize: 12,
                }}
              />
            </label>
            <label style={{ display: "flex", flexDirection: "column", gap: 4, fontSize: 11, color: "#718096" }}>
              结束
              <input
                type="datetime-local"
                value={endLocal}
                onChange={(e) => setEndLocal(e.target.value)}
                style={{
                  padding: "6px 8px",
                  borderRadius: 8,
                  border: "1px solid rgba(160,174,192,0.35)",
                  background: "rgba(17,24,39,0.9)",
                  color: "#e2e8f0",
                  fontSize: 12,
                }}
              />
            </label>
          </div>
          <div style={{ display: "flex", gap: 6, marginTop: 8, flexWrap: "wrap" }}>
            {[3, 7, 14].map((d) => (
              <button
                key={d}
                type="button"
                onClick={() => {
                  const end = new Date();
                  end.setMinutes(0, 0, 0);
                  const start = new Date(end);
                  start.setDate(start.getDate() - d);
                  const pad = (n: number) => String(n).padStart(2, "0");
                  const fmt = (x: Date) => `${x.getFullYear()}-${pad(x.getMonth() + 1)}-${pad(x.getDate())}T${pad(x.getHours())}:${pad(x.getMinutes())}`;
                  setStartLocal(fmt(start));
                  setEndLocal(fmt(end));
                }}
                style={{
                  padding: "3px 8px",
                  borderRadius: 6,
                  border: "1px solid rgba(160,174,192,0.3)",
                  background: "rgba(45,55,72,0.55)",
                  color: "#cbd5e0",
                  fontSize: 11,
                  cursor: "pointer",
                }}
              >
                近{d}天
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 10, flexWrap: "wrap", alignItems: "center" }}>
            <label style={{ fontSize: 11, color: "#a0aec0", display: "flex", alignItems: "center", gap: 4 }}>
              LLM模式
              <select
                value={llmMode}
                onChange={(e) => setLlmMode(e.target.value)}
                style={{
                  padding: "3px 6px",
                  borderRadius: 6,
                  background: "rgba(17,24,39,0.9)",
                  color: "#e2e8f0",
                  border: "1px solid rgba(160,174,192,0.35)",
                  fontSize: 11,
                }}
              >
                <option value="trader_only">trader_only（快）</option>
                <option value="full">full 5席</option>
              </select>
            </label>
            <label style={{ fontSize: 11, color: "#a0aec0", display: "flex", alignItems: "center", gap: 4 }}>
              max_llm
              <input
                type="number"
                min={0}
                max={50}
                value={maxLlmSignals}
                onChange={(e) => setMaxLlmSignals(Math.max(0, Math.min(50, Number(e.target.value) || 0)))}
                style={{
                  width: 52,
                  padding: "3px 6px",
                  borderRadius: 6,
                  background: "rgba(17,24,39,0.9)",
                  color: "#e2e8f0",
                  border: "1px solid rgba(160,174,192,0.35)",
                  fontSize: 11,
                }}
              />
            </label>
            <label style={{ fontSize: 11, color: "#a0aec0", display: "flex", alignItems: "center", gap: 4 }}>
              soft_ai_top_n
              <input
                type="number"
                min={0}
                max={20}
                value={softAiTopN}
                onChange={(e) => setSoftAiTopN(Math.max(0, Math.min(20, Number(e.target.value) || 0)))}
                style={{
                  width: 48,
                  padding: "3px 6px",
                  borderRadius: 6,
                  background: "rgba(17,24,39,0.9)",
                  color: "#e2e8f0",
                  border: "1px solid rgba(160,174,192,0.35)",
                  fontSize: 11,
                }}
              />
            </label>
            <span style={{ fontSize: 10.5, color: "#718096" }}>控件值已缓存到 localStorage，刷新保留</span>
          </div>
        </div>
      </div>

      {err && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            background: err.startsWith("部分币种") ? "rgba(246, 173, 85, 0.16)" : "rgba(245, 101, 101, 0.16)",
            border: err.startsWith("部分币种") ? "1px solid rgba(246, 173, 85, 0.5)" : "1px solid rgba(245, 101, 101, 0.45)",
            color: err.startsWith("部分币种") ? "#f6ad55" : "#fc8181",
            marginBottom: 12,
            fontSize: 12.5,
          }}
        >
          {err.startsWith("部分币种") ? err : `回测加载/运行异常：${err}`}
        </div>
      )}
      {runningMode && progressText && (
        <div
          style={{
            padding: "10px 14px",
            borderRadius: 8,
            background: "rgba(99, 179, 237, 0.14)",
            border: "1px solid rgba(99, 179, 237, 0.45)",
            color: "#90cdf4",
            marginBottom: 12,
            fontSize: 12.5,
          }}
        >
          渐进回测：{progressText}
          {data?.progress?.pct != null ? ` · ${data.progress.pct}%` : ""}
          {data?.items?.length ? ` · 已出 ${data.items.length} 条` : ""}
        </div>
      )}

      {loading && !data ? (
        <div style={{ padding: 40, textAlign: "center", color: "#a0aec0" }}>正在加载回测数据…</div>
      ) : null}

      {/* Summary KPI Grid */}
      {summary && (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fit, minmax(240px, 1fr))",
            gap: 10,
            marginBottom: 14,
          }}
        >
          {/* Card 1: Total Signals & Gate */}
          <div
            style={{
              padding: "12px 14px",
              borderRadius: 10,
              background: "rgba(26, 32, 44, 0.85)",
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <div style={{ fontSize: 11.5, color: "#a0aec0" }}>7天 1h 形态/信号总数</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
              <span style={{ fontSize: 24, fontWeight: 800, color: "#f7fafc" }}>{summary.total_signals}</span>
              <span style={{ fontSize: 12, color: "#68d391" }}>
                门禁通过 {summary.gate_pass_count} ({summary.gate_pass_rate_pct}%)
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: "#a0aec0", marginTop: 4 }}>
              门禁拦截 <strong style={{ color: "#cbd5e0" }}>{summary.gate_reject_count}</strong> 条（过滤无量能/逆势噪音）
            </div>
          </div>

          {/* Card 2: AI Action Breakdown */}
          <div
            style={{
              padding: "12px 14px",
              borderRadius: 10,
              background: "rgba(26, 32, 44, 0.85)",
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <div style={{ fontSize: 11.5, color: "#a0aec0" }}>
              {data?.skip_llm ? "门禁占位分布（未跑AI · 非决策）" : "Agent 决策分布（未知后续K线）"}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginTop: 6 }}>
              <span style={{ padding: "2px 8px", borderRadius: 6, background: "rgba(72,187,120,0.2)", color: "#68d391", fontSize: 12, fontWeight: 700 }}>
                LONG: {summary.action_counts?.LONG ?? 0}
              </span>
              <span style={{ padding: "2px 8px", borderRadius: 6, background: "rgba(245,101,101,0.2)", color: "#fc8181", fontSize: 12, fontWeight: 700 }}>
                SHORT: {summary.action_counts?.SHORT ?? 0}
              </span>
              <span style={{ padding: "2px 8px", borderRadius: 6, background: "rgba(236,201,75,0.2)", color: "#f6e05e", fontSize: 12, fontWeight: 700 }}>
                WATCH: {summary.action_counts?.WATCH ?? 0}
              </span>
              <span style={{ padding: "2px 8px", borderRadius: 6, background: "rgba(160,174,192,0.2)", color: "#cbd5e0", fontSize: 12 }}>
                NO_TRADE: {summary.action_counts?.NO_TRADE ?? 0}
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: "#a0aec0", marginTop: 6, display: "flex", flexWrap: "wrap", gap: 6 }}>
              <span>开仓指令 <strong style={{ color: "#fbd38d" }}>{summary.active_trade_count}</strong></span>
              {typeof summary.ai_judged_count === "number" && (
                <span>AI研判 <strong style={{ color: "#90cdf4" }}>{summary.ai_judged_count}</strong></span>
              )}
              {typeof summary.ai_do_count === "number" && (
                <span>做 <strong style={{ color: "#68d391" }}>{summary.ai_do_count}</strong></span>
              )}
              {typeof summary.ai_dont_count === "number" && (
                <span>不做 <strong style={{ color: "#f6e05e" }}>{summary.ai_dont_count}</strong></span>
              )}
              {typeof summary.ai_skipped_count === "number" && summary.ai_skipped_count > 0 && (
                <span>未跑AI <strong style={{ color: "#d6bcfa" }}>{summary.ai_skipped_count}</strong></span>
              )}
              {typeof summary.ai_error_count === "number" && summary.ai_error_count > 0 && (
                <span>AI失败 <strong style={{ color: "#fc8181" }}>{summary.ai_error_count}</strong></span>
              )}
            </div>
          </div>

          {/* Card 3: AI Active Calls Win Rate & Return */}
          <div
            style={{
              padding: "12px 14px",
              borderRadius: 10,
              background: "rgba(26, 32, 44, 0.85)",
              border: "1px solid rgba(72, 187, 120, 0.28)",
            }}
          >
            <div style={{ fontSize: 11.5, color: "#a0aec0" }}>AI 开仓表现 (LONG/SHORT) / 门禁通过组</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4 }}>
              <div>
                <span style={{ fontSize: 11, color: "#a0aec0" }}>4h胜率: </span>
                <strong style={{ fontSize: 18, color: "#68d391" }}>
                  {summary.ai_win_rate_4h_pct !== null ? `${summary.ai_win_rate_4h_pct}%` : `${summary.gate_pass_win_rate_4h_pct}%`}
                </strong>
              </div>
              <div>
                <span style={{ fontSize: 11, color: "#a0aec0" }}>8h胜率: </span>
                <strong style={{ fontSize: 18, color: "#68d391" }}>
                  {summary.ai_win_rate_8h_pct !== null ? `${summary.ai_win_rate_8h_pct}%` : `${summary.gate_pass_win_rate_8h_pct}%`}
                </strong>
              </div>
            </div>
            <div style={{ fontSize: 11.5, color: "#cbd5e0", marginTop: 4 }}>
              门禁通过组 4h MFE <strong style={{ color: "#68d391" }}>+{summary.gate_pass_avg_mfe_4h_pct}%</strong> / MAE{" "}
              <strong style={{ color: "#fc8181" }}>-{summary.gate_pass_avg_mae_4h_pct}%</strong>
              {" · "}
              8h MFE <strong style={{ color: "#68d391" }}>+{summary.gate_pass_avg_mfe_8h_pct}%</strong> / MAE{" "}
              <strong style={{ color: "#fc8181" }}>-{summary.gate_pass_avg_mae_8h_pct}%</strong>
            </div>
          </div>

          {/* Card 4: Saved vs Missed */}
          <div
            style={{
              padding: "12px 14px",
              borderRadius: 10,
              background: "rgba(26, 32, 44, 0.85)",
              border: "1px solid rgba(56, 178, 172, 0.3)",
            }}
          >
            <div style={{ fontSize: 11.5, color: "#a0aec0" }}>门禁 + AI 风控避坑价值</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginTop: 4 }}>
              <span style={{ fontSize: 22, fontWeight: 800, color: "#4fd1c5" }}>
                成功避坑 {summary.total_saved_count} 次
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: "#a0aec0", marginTop: 4 }}>
              门禁避坑 <strong style={{ color: "#4fd1c5" }}>{summary.saved_by_gate_count}</strong> 次 · AI观望避坑{" "}
              <strong style={{ color: "#4fd1c5" }}>{summary.saved_by_ai_count}</strong> 次 · 过滤踏空{" "}
              <strong style={{ color: "#f6ad55" }}>{summary.missed_by_gate_count + summary.missed_by_ai_count}</strong> 次
            </div>
          </div>

          {/* Card 4b: 15m Tight SL Strategy Stats (when available) */}
          {summary.tight_sl_15m_stats && summary.tight_sl_15m_stats.total_signals > 0 && (
            <div
              style={{
                padding: "12px 14px",
                borderRadius: 10,
                background: "rgba(38, 28, 62, 0.88)",
                border: "1px solid rgba(159, 122, 234, 0.55)",
              }}
            >
              <div style={{ fontSize: 11.5, color: "#e9d8fd", fontWeight: 700 }}>
                🎯 BTC/ETH 15m 小止损策略（形态+支撑压力+均线）
              </div>
              <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4, flexWrap: "wrap" }}>
                <span style={{ fontSize: 20, fontWeight: 800, color: "#fbd38d" }}>
                  {summary.tight_sl_15m_stats.total_signals} 笔
                </span>
                <span style={{ fontSize: 12, color: "#68d391", fontWeight: 700 }}>
                  触发TP胜率 {summary.tight_sl_15m_stats.sim_tp_win_rate_pct ?? "—"}%
                </span>
                <span style={{ fontSize: 11.5, color: "#90cdf4" }}>
                  保本+止盈率 {summary.tight_sl_15m_stats.sim_non_loss_rate_pct ?? "—"}%
                </span>
              </div>
              <div style={{ fontSize: 11.5, color: "#cbd5e0", marginTop: 4 }}>
                平均小止损 <strong style={{ color: "#fc8181" }}>-{summary.tight_sl_15m_stats.avg_sl_pct ?? "—"}%</strong> · 均值期望{" "}
                <strong style={{ color: (summary.tight_sl_15m_stats.avg_realized_r ?? 0) >= 0 ? "#68d391" : "#fc8181" }}>
                  {summary.tight_sl_15m_stats.avg_realized_r != null && summary.tight_sl_15m_stats.avg_realized_r > 0 ? "+" : ""}
                  {summary.tight_sl_15m_stats.avg_realized_r ?? "—"}R
                </strong>{" "}
                · 平均信心 <strong style={{ color: "#fbd38d" }}>{summary.tight_sl_15m_stats.avg_confidence_pct ?? "—"}%</strong> (高信心 {summary.tight_sl_15m_stats.high_conf_count} 笔)
              </div>
            </div>
          )}

          {/* Card 5: Raw All-Signal Baseline Comparison */}
          <div
            style={{
              padding: "12px 14px",
              borderRadius: 10,
              background: "rgba(26, 32, 44, 0.85)",
              border: "1px solid rgba(255,255,255,0.08)",
            }}
          >
            <div style={{ fontSize: 11.5, color: "#a0aec0" }}>对照基准：若无脑全做全部 46 个 1h 信号</div>
            <div style={{ display: "flex", alignItems: "baseline", gap: 10, marginTop: 4 }}>
              <span style={{ fontSize: 15, fontWeight: 700, color: "#cbd5e0" }}>
                4h顺向胜率 {summary.raw_all_win_rate_4h_pct}% ({fmtPct(summary.raw_all_avg_ret_4h_pct)})
              </span>
            </div>
            <div style={{ fontSize: 11.5, color: "#a0aec0", marginTop: 4 }}>
              8h顺向胜率 {summary.raw_all_win_rate_8h_pct}% ({fmtPct(summary.raw_all_avg_ret_8h_pct)}) · 门禁提升 4h 均值{" "}
              <strong style={{ color: "#68d391" }}>
                {fmtPct((summary.gate_pass_avg_ret_4h_pct || 0) - (summary.raw_all_avg_ret_4h_pct || 0))}
              </strong>
            </div>
          </div>
        </div>
      )}

      {/* Pattern Breakdown Chips */}
      {summary?.pattern_stats && summary.pattern_stats.length > 0 && (
        <div
          style={{
            display: "flex",
            flexWrap: "wrap",
            gap: 8,
            padding: "10px 12px",
            borderRadius: 10,
            background: "rgba(23, 25, 35, 0.85)",
            border: "1px solid rgba(255,255,255,0.06)",
            marginBottom: 12,
            alignItems: "center",
          }}
        >
          <span style={{ fontSize: 12, color: "#a0aec0", fontWeight: 600 }}>按 1h 形态分类筛选：</span>
          <button
            type="button"
            onClick={() => setPatternFilter("all")}
            style={{
              padding: "4px 10px",
              borderRadius: 999,
              fontSize: 11.5,
              border: patternFilter === "all" ? "1px solid #fbd38d" : "1px solid rgba(255,255,255,0.12)",
              background: patternFilter === "all" ? "rgba(246, 173, 85, 0.22)" : "rgba(45, 55, 72, 0.5)",
              color: patternFilter === "all" ? "#fbd38d" : "#cbd5e0",
              cursor: "pointer",
            }}
          >
            全部形态 ({summary.total_signals})
          </button>
          {summary.pattern_stats.map((ps) => {
            const active = patternFilter === ps.pattern;
            return (
              <button
                key={ps.pattern}
                type="button"
                onClick={() => setPatternFilter(active ? "all" : ps.pattern)}
                style={{
                  padding: "4px 10px",
                  borderRadius: 999,
                  fontSize: 11.5,
                  border: active ? "1px solid #fbd38d" : "1px solid rgba(255,255,255,0.12)",
                  background: active ? "rgba(246, 173, 85, 0.22)" : "rgba(45, 55, 72, 0.5)",
                  color: active ? "#fbd38d" : "#e2e8f0",
                  cursor: "pointer",
                }}
              >
                {ps.pattern} <strong>{ps.total}</strong>{" "}
                <span style={{ color: "#68d391", fontSize: 11 }}>(过门禁{ps.gate_pass}·避坑{ps.saved_count})</span>
              </button>
            );
          })}
        </div>
      )}

      {/* Filter Toolbar */}
      <div
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: 8,
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: 12,
        }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {[
            { id: "all", label: `全部 (${items.length})` },
            { id: "tight_sl_15m", label: `🎯 15m小止损 (${summary?.tight_sl_15m_stats?.total_signals ?? items.filter((x) => { const t = x.tight_sl_strategy as any; return t?.matched && (t?.plan_kind === "tight_sl_15m" || t?.strategy_id === "tight_sl_15m" || t?.should_enter); }).length})` },
            { id: "gate_pass", label: `✅ 门禁通过 (${summary?.gate_pass_count ?? 0})` },
            { id: "active_ai", label: `🎯 AI开仓 LONG/SHORT (${summary?.ai_do_count ?? summary?.active_trade_count ?? 0})` },
            { id: "ai_wait", label: `🟡 AI不做 NO_TRADE/WATCH (${summary?.ai_dont_count ?? "—"})` },
            { id: "ai_skipped", label: `⏸ 未跑AI (${summary?.ai_skipped_count ?? 0})` },
            { id: "ai_error", label: `⚠ AI失败 (${summary?.ai_error_count ?? 0})` },
            { id: "gate_reject", label: `🛡️ 门禁拦截 (${summary?.gate_reject_count ?? 0})` },
          ].map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setFilterMode(tab.id)}
              style={{
                padding: "5px 11px",
                borderRadius: 8,
                fontSize: 12,
                fontWeight: filterMode === tab.id ? 700 : 500,
                border: filterMode === tab.id ? "1px solid #63b3ed" : "1px solid rgba(255,255,255,0.1)",
                background: filterMode === tab.id ? "rgba(49, 130, 206, 0.28)" : "rgba(26, 32, 44, 0.8)",
                color: filterMode === tab.id ? "#90cdf4" : "#cbd5e0",
                cursor: "pointer",
              }}
            >
              {tab.label}
            </button>
          ))}

          <div style={{ display: "flex", flexWrap: "wrap", gap: 4, alignItems: "center", maxWidth: 520 }}>
            <span style={{ fontSize: 11.5, color: "#a0aec0", fontWeight: 700 }}>
              币种筛选（可多选 · 已选 {symbolFilter.length || "全部"}）
            </span>
            <button
              type="button"
              onClick={() => setSymbolFilter([])}
              style={{
                padding: "3px 8px",
                borderRadius: 999,
                fontSize: 11,
                fontWeight: symbolFilter.length === 0 ? 700 : 500,
                border: symbolFilter.length === 0 ? "1px solid #63b3ed" : "1px solid rgba(255,255,255,0.12)",
                background: symbolFilter.length === 0 ? "rgba(49,130,206,0.28)" : "rgba(26,32,44,0.8)",
                color: symbolFilter.length === 0 ? "#90cdf4" : "#cbd5e0",
                cursor: "pointer",
              }}
            >
              全部
            </button>
            {filterSymbolOptions.map((s) => {
              const on = symbolFilter.includes(s);
              const isExtra = !(QUICK_SYMBOLS as readonly string[]).includes(s) && !resultSymbolBases.includes(s);
              return (
                <button
                  key={s}
                  type="button"
                  onClick={() => toggleSymbolFilter(s)}
                  style={{
                    padding: "3px 8px",
                    borderRadius: 999,
                    fontSize: 11,
                    fontWeight: on ? 700 : 500,
                    border: on ? "1px solid rgba(246,173,85,0.85)" : "1px solid rgba(255,255,255,0.12)",
                    background: on ? "rgba(237,137,54,0.28)" : "rgba(26,32,44,0.8)",
                    color: on ? "#fbd38d" : "#cbd5e0",
                    cursor: "pointer",
                  }}
                  title={isExtra ? "自由输入币种" : undefined}
                >
                  {on ? `✓ ${s}` : s}
                  {on && isExtra ? " ✕" : ""}
                </button>
              );
            })}
            <div style={{ display: "flex", gap: 4, alignItems: "center" }}>
              <input
                value={filterCustomDraft}
                onChange={(e) => setFilterCustomDraft(e.target.value.toUpperCase())}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.preventDefault();
                    addCustomFilterSymbol();
                  }
                }}
                placeholder="加筛选币"
                style={{
                  width: 84,
                  padding: "3px 7px",
                  borderRadius: 6,
                  border: "1px solid rgba(160,174,192,0.35)",
                  background: "rgba(17,24,39,0.9)",
                  color: "#e2e8f0",
                  fontSize: 11,
                }}
              />
              <button
                type="button"
                onClick={() => addCustomFilterSymbol()}
                style={{
                  padding: "3px 8px",
                  borderRadius: 6,
                  border: "1px solid rgba(99,179,237,0.45)",
                  background: "rgba(49,130,206,0.2)",
                  color: "#90cdf4",
                  fontSize: 11,
                  fontWeight: 700,
                  cursor: "pointer",
                }}
              >
                添加
              </button>
            </div>
          </div>

          <select
            value={sideFilter}
            onChange={(e) => setSideFilter(e.target.value)}
            style={{
              padding: "5px 9px",
              borderRadius: 7,
              background: "rgba(26,32,44,0.9)",
              color: "#e2e8f0",
              border: "1px solid rgba(255,255,255,0.14)",
              fontSize: 12,
            }}
          >
            <option value="all">原信号方向: 全部</option>
            <option value="long">原信号: 做多 (Long)</option>
            <option value="short">原信号: 做空 (Short)</option>
          </select>

          <select
            value={tfFilter}
            onChange={(e) => setTfFilter(e.target.value)}
            style={{
              padding: "5px 9px",
              borderRadius: 7,
              background: "rgba(26,32,44,0.9)",
              color: "#e2e8f0",
              border: "1px solid rgba(255,255,255,0.14)",
              fontSize: 12,
            }}
          >
            <option value="all">周期: 全部</option>
            <option value="15m">15m</option>
            <option value="1h">1h</option>
            <option value="4h">4h</option>
            <option value="1d">1d</option>
          </select>

          <select
            value={verdictFilter}
            onChange={(e) => setVerdictFilter(e.target.value)}
            style={{
              padding: "5px 9px",
              borderRadius: 7,
              background: "rgba(26,32,44,0.9)",
              color: "#e2e8f0",
              border: "1px solid rgba(255,255,255,0.14)",
              fontSize: 12,
            }}
          >
            <option value="all">复盘结论: 全部</option>
            <option value="win">AI命中盈利</option>
            <option value="saved">门禁/AI成功避坑</option>
            <option value="missed">过滤踏空</option>
            <option value="loss">AI方向受损</option>
          </select>
        </div>

        <input
          type="text"
          placeholder="搜索形态名称 / 时间 / 门禁原因 / AI理由…"
          value={searchQ}
          onChange={(e) => setSearchQ(e.target.value)}
          style={{
            padding: "6px 12px",
            borderRadius: 8,
            background: "rgba(26,32,44,0.9)",
            border: "1px solid rgba(255,255,255,0.15)",
            color: "#e2e8f0",
            fontSize: 12,
            minWidth: 240,
          }}
        />
      </div>

      {/* Main Master-Detail Split Layout */}
      <div
        style={{
          display: "grid",
          gridTemplateColumns: selectedItem ? "minmax(640px, 1.25fr) minmax(420px, 0.95fr)" : "1fr",
          gap: 14,
          alignItems: "start",
        }}
      >
        {/* Left: Historical Signal Table */}
        <div
          style={{
            borderRadius: 12,
            background: "rgba(23, 25, 35, 0.92)",
            border: "1px solid rgba(255,255,255,0.08)",
            overflow: "hidden",
          }}
        >
          <div
            style={{
              padding: "10px 14px",
              borderBottom: "1px solid rgba(255,255,255,0.08)",
              display: "flex",
              justifyContent: "space-between",
              alignItems: "center",
              fontSize: 12.5,
            }}
          >
            <strong>
              历史信号逐笔回测列表（共筛选出 {filteredItems.length} / {items.length} 条，点击任意行查看当时无未来数据快照 & 5席推理）
            </strong>
          </div>

          {/* 筛选集总计：随币种/门禁/AI/搜索等筛选即时重算 */}
          <div
            style={{
              padding: "8px 12px",
              borderBottom: "1px solid rgba(255,255,255,0.08)",
              background: "rgba(26, 32, 44, 0.92)",
              display: "flex",
              flexWrap: "wrap",
              gap: "6px 14px",
              alignItems: "center",
              fontSize: 12,
              color: "#cbd5e0",
              lineHeight: 1.45,
            }}
          >
            <span style={{ fontWeight: 800, color: "#f7fafc" }}>
              筛选总计{" "}
              <strong style={{ color: "#63b3ed", fontSize: 15 }}>{filteredTotals.total}</strong>
              <span style={{ color: "#718096", fontWeight: 500 }}> / {filteredTotals.allTotal}</span>
            </span>
            <span style={{ color: "#4a5568" }}>|</span>
            <span>
              门禁过{" "}
              <strong style={{ color: "#68d391" }}>{filteredTotals.gatePass}</strong>
              <span style={{ color: "#a0aec0" }}>（{filteredTotals.gatePassRate}%）</span>
              {" · "}
              拦截 <strong style={{ color: "#fc8181" }}>{filteredTotals.gateReject}</strong>
            </span>
            <span style={{ color: "#4a5568" }}>|</span>
            <span>
              AI研判 <strong style={{ color: "#90cdf4" }}>{filteredTotals.aiJudged}</strong>
              {" · "}
              做 <strong style={{ color: "#68d391" }}>{filteredTotals.aiDo}</strong>
              {" · "}
              不做 <strong style={{ color: "#f6e05e" }}>{filteredTotals.aiDont}</strong>
              {filteredTotals.aiSkipped > 0 && (
                <>
                  {" · "}
                  未跑 <strong style={{ color: "#d6bcfa" }}>{filteredTotals.aiSkipped}</strong>
                </>
              )}
              {filteredTotals.aiError > 0 && (
                <>
                  {" · "}
                  失败 <strong style={{ color: "#fc8181" }}>{filteredTotals.aiError}</strong>
                </>
              )}
            </span>
            <span style={{ color: "#4a5568" }}>|</span>
            <span title={`胜率样本：${filteredTotals.wrLabel}（有后续收益的行）`}>
              胜率({filteredTotals.wrLabel}){" "}
              +1h{" "}
              <strong style={{ color: "#9ae6b4" }}>
                {filteredTotals.wr1h == null ? "—" : `${filteredTotals.wr1h}%`}
              </strong>
              {" · "}
              +4h{" "}
              <strong style={{ color: "#9ae6b4" }}>
                {filteredTotals.wr4h == null ? "—" : `${filteredTotals.wr4h}%`}
              </strong>
              {" · "}
              +8h{" "}
              <strong style={{ color: "#9ae6b4" }}>
                {filteredTotals.wr8h == null ? "—" : `${filteredTotals.wr8h}%`}
              </strong>
            </span>
            <span style={{ color: "#4a5568" }}>|</span>
            <span
              title={`总盈亏率(净)=Σ realized_pct_net；毛利未扣费。手续费≈万4/边，全平约0.08%/笔。样本=${filteredTotals.wrLabel} · 来源=${filteredTotals.pnlSourceLabel || "—"} · 盈${filteredTotals.pnlWins}/亏${filteredTotals.pnlLosses}/平${filteredTotals.pnlFlat}`}
            >
              总盈亏率净({filteredTotals.wrLabel}){" "}
              <strong style={{ color: pctColor(filteredTotals.totalPnlNetPct ?? filteredTotals.totalPnlPct), fontSize: 14 }}>
                {fmtPct(filteredTotals.totalPnlNetPct ?? filteredTotals.totalPnlPct)}
              </strong>
              {filteredTotals.pnlN > 0 && (
                <span style={{ color: "#a0aec0" }}>
                  （毛{fmtPct(filteredTotals.totalPnlGrossPct)} · 费≈{fmtPct(filteredTotals.totalFeePct)} · {filteredTotals.pnlN}笔 · 盈{filteredTotals.pnlWins}/亏{filteredTotals.pnlLosses}
                  {filteredTotals.pnlFlat > 0 ? `/平${filteredTotals.pnlFlat}` : ""}
                  {filteredTotals.pnlSourceLabel ? ` · ${filteredTotals.pnlSourceLabel}` : ""}）
                </span>
              )}
            </span>
          </div>

          <div style={{ maxHeight: 740, overflowY: "auto", overflowX: "auto" }}>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 12 }}>
              <thead>
                <tr
                  style={{
                    background: "rgba(45, 55, 72, 0.55)",
                    color: "#a0aec0",
                    textAlign: "left",
                    position: "sticky",
                    top: 0,
                    zIndex: 1,
                  }}
                >
                  <th style={{ padding: "8px 10px" }}>信号收盘 (UTC+8)</th>
                  <th style={{ padding: "8px 10px" }}>币种</th>
                  <th style={{ padding: "8px 10px" }}>周期</th>
                  <th style={{ padding: "8px 10px" }}>形态/命中信号</th>
                  <th style={{ padding: "8px 10px" }}>客观复盘结论</th>
                  <th style={{ padding: "8px 10px" }}>当时价格</th>
                  <th style={{ padding: "8px 10px" }}>4h/8h 顺向MFE / 逆向MAE</th>
                  <th style={{ padding: "8px 10px" }}>当时AI判断 (无未来)</th>
                  <th style={{ padding: "8px 10px" }}>后续 +1h / +4h / +8h</th>
                </tr>
              </thead>
              <tbody>
                {filteredItems.map((row) => {
                  const isSel = selectedItem?.id === row.id;
                  const gatePass = row.gate_result === "pass";
                  const actBadge = actionBadgeStyle(row.action, gatePass, row.ai_status);
                  const vStyle = verdictStyle(row.outcome.verdict);
                  return (
                    <tr
                      key={row.id}
                      onClick={() => setSelectedId(row.id)}
                      style={{
                        borderBottom: "1px solid rgba(255,255,255,0.05)",
                        background: isSel
                          ? "rgba(66, 153, 225, 0.16)"
                          : gatePass
                            ? "rgba(72, 187, 120, 0.04)"
                            : "transparent",
                        cursor: "pointer",
                      }}
                    >
                      <td style={{ padding: "9px 10px", whiteSpace: "nowrap" }}>
                        <div style={{ fontWeight: 700, color: "#e2e8f0" }}>{row.bar_close_iso}</div>
                        <div style={{ fontSize: 10.5, color: "#718096" }}>开盘 {row.bar_open_iso.slice(5)}</div>
                      </td>
                      <td style={{ padding: "9px 10px" }}>
                        <span
                          style={{
                            padding: "2px 7px",
                            borderRadius: 6,
                            fontSize: 11,
                            fontWeight: 800,
                            background: "rgba(246,173,85,0.18)",
                            color: "#fbd38d",
                            border: "1px solid rgba(246,173,85,0.35)",
                          }}
                        >
                          {symbolBaseOf(row) || "—"}
                        </span>
                      </td>
                      <td style={{ padding: "9px 10px" }}>
                        <span
                          style={{
                            padding: "2px 7px",
                            borderRadius: 6,
                            fontSize: 11,
                            fontWeight: 800,
                            background: tfBadgeColor(row.timeframe).bg,
                            color: tfBadgeColor(row.timeframe).color,
                          }}
                        >
                          {row.timeframe}
                        </span>
                      </td>
                      <td style={{ padding: "9px 10px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span
                            style={{
                              padding: "1px 6px",
                              borderRadius: 4,
                              fontSize: 10.5,
                              fontWeight: 700,
                              background: row.signal_side === "long" ? "rgba(72,187,120,0.2)" : "rgba(245,101,101,0.2)",
                              color: row.signal_side === "long" ? "#68d391" : "#fc8181",
                            }}
                          >
                            {row.signal_side === "long" ? "多头信号" : "空头信号"}
                          </span>
                          <strong style={{ color: "#f7fafc" }}>{row.signal_name}</strong>
                          {(() => {
                            const p = planOf(row);
                            if (!p?.sl_pct) return null;
                            const isTight = p.plan_kind === "tight_sl_15m" || p.strategy_id === "tight_sl_15m";
                            return (
                              <span
                                style={{
                                  padding: "1px 6px",
                                  borderRadius: 4,
                                  fontSize: 10.5,
                                  fontWeight: 700,
                                  background: isTight ? "rgba(159, 122, 234, 0.24)" : "rgba(66, 153, 225, 0.22)",
                                  color: isTight ? "#e9d8fd" : "#90cdf4",
                                  border: isTight ? "1px solid rgba(159, 122, 234, 0.45)" : "1px solid rgba(66, 153, 225, 0.45)",
                                }}
                              >
                                {isTight ? "🎯 小止损" : "📐 综合止盈止损"} -{p.sl_pct}% · {p.rr_tp1 ?? p.rr1}R/{p.rr_tp2 ?? p.rr2}R
                              </span>
                            );
                          })()}
                        </div>
                        {row.tight_sl_strategy?.matched && tightSlSimLabel(row) && (
                          <div style={{ fontSize: 10.5, color: "#cbd5e0", marginTop: 3 }}>
                            小止损复盘:{" "}
                            <strong
                              style={{
                                color:
                                  (row.outcome?.tight_sl_sim?.realized_pct ?? row.outcome?.realized_pct ?? 0) > 0
                                    ? "#68d391"
                                    : (row.outcome?.tight_sl_sim?.realized_pct ?? row.outcome?.realized_pct ?? 0) < 0
                                      ? "#fc8181"
                                      : "#f6e05e",
                              }}
                            >
                              {tightSlSimLabel(row)}
                              {row.outcome?.tight_sl_sim?.realized_pct != null || row.outcome?.realized_pct != null
                                ? ` · 本笔 ${(row.outcome?.tight_sl_sim?.realized_pct ?? row.outcome?.realized_pct)! > 0 ? "+" : ""}${row.outcome?.tight_sl_sim?.realized_pct ?? row.outcome?.realized_pct}%`
                                : ""}
                            </strong>
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "9px 10px", whiteSpace: "nowrap" }}>
                        <span
                          style={{
                            padding: "3px 8px",
                            borderRadius: 6,
                            fontSize: 11,
                            fontWeight: 700,
                            background: vStyle.bg,
                            border: `1px solid ${vStyle.border}`,
                            color: vStyle.color,
                          }}
                        >
                          {row.outcome.verdict_label}
                        </span>
                      </td>
                      <td style={{ padding: "9px 10px", fontFamily: "monospace", fontWeight: 700 }}>
                        ${row.price.toLocaleString()}
                      </td>
                      <td style={{ padding: "9px 10px", fontFamily: "monospace", whiteSpace: "nowrap" }}>
                        <div>
                          <span style={{ color: "#a0aec0", fontSize: 10 }}>4h </span>
                          <span style={{ color: "#68d391" }}>+{(row.outcome.mfe_4h_pct ?? 0).toFixed(2)}%</span>
                          {" / "}
                          <span style={{ color: "#fc8181" }}>-{(row.outcome.mae_4h_pct ?? 0).toFixed(2)}%</span>
                        </div>
                        <div>
                          <span style={{ color: "#a0aec0", fontSize: 10 }}>8h </span>
                          <span style={{ color: "#68d391" }}>+{(row.outcome.mfe_8h_pct ?? 0).toFixed(2)}%</span>
                          {" / "}
                          <span style={{ color: "#fc8181" }}>-{(row.outcome.mae_8h_pct ?? 0).toFixed(2)}%</span>
                        </div>
                      </td>
                      <td style={{ padding: "9px 10px" }}>
                        <div style={{ display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" }}>
                          <span
                            style={{
                              padding: "2px 7px",
                              borderRadius: 6,
                              fontSize: 11,
                              fontWeight: 700,
                              background: actBadge.bg,
                              color: actBadge.color,
                            }}
                          >
                            {actBadge.label}
                          </span>
                          {(row.confidence_pct != null || row.confidence != null) && (
                            <span
                              style={{
                                padding: "1px 6px",
                                borderRadius: 4,
                                fontSize: 10.5,
                                fontWeight: 700,
                                background: (row.confidence_pct ?? Math.round(Number(row.confidence || 0) * 100)) >= 68
                                  ? "rgba(72, 187, 120, 0.2)"
                                  : "rgba(236, 201, 75, 0.18)",
                                color: (row.confidence_pct ?? Math.round(Number(row.confidence || 0) * 100)) >= 68
                                  ? "#68d391"
                                  : "#f6e05e",
                              }}
                            >
                              信心 {row.confidence_band ? `${row.confidence_band}·` : ""}{row.confidence_pct ?? Math.round(Number(row.confidence || 0) * 100)}%
                            </span>
                          )}
                        </div>
                        {!gatePass && row.gate_reasons?.length > 0 && (
                          <div style={{ fontSize: 10.5, color: "#718096", marginTop: 2, maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {row.gate_reasons[0]}
                          </div>
                        )}
                        {row.ai_status === "error" && row.llm_error && (
                          <div style={{ fontSize: 10.5, color: "#fc8181", marginTop: 2, maxWidth: 210, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
                            {row.llm_error}
                          </div>
                        )}
                      </td>
                      <td style={{ padding: "9px 10px", fontFamily: "monospace", whiteSpace: "nowrap" }}>
                        <span style={{ color: pctColor(row.outcome.dir_ret_1h_pct) }}>
                          {fmtPct(row.outcome.dir_ret_1h_pct)}
                        </span>{" "}
                        /{" "}
                        <strong style={{ color: pctColor(row.outcome.dir_ret_4h_pct) }}>
                          {fmtPct(row.outcome.dir_ret_4h_pct)}
                        </strong>{" "}
                        /{" "}
                        <span style={{ color: pctColor(row.outcome.dir_ret_8h_pct) }}>
                          {fmtPct(row.outcome.dir_ret_8h_pct)}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>

        {/* Right: Point-in-Time Inspector & Post-Truth Drawer */}
        {selectedItem && (
          <div
            style={{
              borderRadius: 12,
              background: "rgba(23, 25, 35, 0.96)",
              border: "1px solid rgba(99, 179, 237, 0.35)",
              padding: "14px 16px",
              position: "sticky",
              top: 12,
              maxHeight: "calc(100vh - 32px)",
              overflowY: "auto",
            }}
          >
            {/* Header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 8 }}>
              <div>
                <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
                  <span style={{ fontSize: 15, fontWeight: 800, color: "#fbd38d" }}>
                    #{selectedItem.seq} · {symbolBaseOf(selectedItem) || "—"} · {selectedItem.signal_name}
                  </span>
                  <span
                    style={{
                      padding: "2px 8px",
                      borderRadius: 999,
                      fontSize: 11,
                      fontWeight: 700,
                      background: "rgba(72, 187, 120, 0.16)",
                      color: "#68d391",
                    }}
                  >
                    🔒 当时视角 (截止 {selectedItem.bar_close_iso})
                  </span>
                </div>
                <div style={{ fontSize: 12, color: "#a0aec0", marginTop: 4 }}>
                  币种：<strong style={{ color: "#fbd38d" }}>{symbolBaseOf(selectedItem) || "—"}</strong>
                  {" · "}信号K线：{selectedItem.bar_open_iso} ~ {selectedItem.bar_close_iso} (UTC+8) · 当时收盘价：
                  <strong style={{ color: "#fff" }}>${selectedItem.price.toLocaleString()}</strong>
                </div>
              </div>
              {onOpenChartAt && (
                <button
                  type="button"
                  onClick={() =>
                    onOpenChartAt(
                      selectedItem.symbol || `${symbolBaseOf(selectedItem)}USDT`,
                      selectedItem.timeframe || "1h",
                      selectedItem.bar_open_sec
                    )
                  }
                  style={{
                    padding: "5px 10px",
                    borderRadius: 7,
                    border: "1px solid rgba(99,179,237,0.45)",
                    background: "rgba(49,130,206,0.2)",
                    color: "#90cdf4",
                    fontSize: 11.5,
                    cursor: "pointer",
                    whiteSpace: "nowrap",
                  }}
                >
                  📈 在图表定位
                </button>
              )}
            </div>

            {/* Section 1: Strict No-Lookahead Multi-TF Snapshot at t_i */}
            <div
              style={{
                marginTop: 12,
                padding: "10px 12px",
                borderRadius: 9,
                background: "rgba(26, 32, 44, 0.9)",
                border: "1px solid rgba(255,255,255,0.07)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <strong style={{ fontSize: 12, color: "#90cdf4" }}>
                  ① 当时 Agent 看到的四周期快照（未来K线暴露数 = {selectedItem.no_lookahead_proof?.future_bars_exposed_to_agent ?? 0}）
                </strong>
                <span style={{ fontSize: 11, color: "#718096" }}>
                  喂入K线: 15m({selectedItem.no_lookahead_proof?.bars_fed?.["15m"]}) · 1h({selectedItem.no_lookahead_proof?.bars_fed?.["1h"]}) · 4h({selectedItem.no_lookahead_proof?.bars_fed?.["4h"]}) · 1d({selectedItem.no_lookahead_proof?.bars_fed?.["1d"]})
                </span>
              </div>
              <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11.5 }}>
                <thead>
                  <tr style={{ color: "#a0aec0", borderBottom: "1px solid rgba(255,255,255,0.07)" }}>
                    <th style={{ padding: "4px 6px", textAlign: "left" }}>周期</th>
                    <th style={{ padding: "4px 6px", textAlign: "left" }}>色带/结构</th>
                    <th style={{ padding: "4px 6px", textAlign: "left" }}>EMA 13 / 144</th>
                    <th style={{ padding: "4px 6px", textAlign: "left" }}>Vegas 144 / 576</th>
                    <th style={{ padding: "4px 6px", textAlign: "left" }}>量能倍比</th>
                  </tr>
                </thead>
                <tbody>
                  {(["15m", "1h", "4h", "1d"] as const).map((tf) => {
                    const node = selectedItem.snapshot?.tf?.[tf] || {};
                    return (
                      <tr key={tf} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                        <td style={{ padding: "4px 6px", fontWeight: 700, color: tf === "1h" ? "#fbd38d" : "#e2e8f0" }}>
                          {tf}
                        </td>
                        <td style={{ padding: "4px 6px" }}>
                          <span style={{ color: node.color_band === "bull" ? "#68d391" : node.color_band === "bear" ? "#fc8181" : "#cbd5e0" }}>
                            {node.color_band}
                          </span>{" "}
                          / {node.structure}
                        </td>
                        <td style={{ padding: "4px 6px", fontFamily: "monospace" }}>
                          {node.ema?.["13"] ?? "—"} / {node.ema?.["144"] ?? "—"}
                        </td>
                        <td style={{ padding: "4px 6px", fontFamily: "monospace" }}>
                          {node.vegas?.["144"] ?? "—"} / {node.vegas?.["576"] ?? "—"}
                        </td>
                        <td style={{ padding: "4px 6px", fontFamily: "monospace", color: Number(node.volume_spike_x) >= 1.5 ? "#fbd38d" : "#a0aec0" }}>
                          {node.volume_spike_x ?? "—"}x
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
              {selectedItem.snapshot?.oi && (
                <div style={{ fontSize: 11, color: "#a0aec0", marginTop: 6 }}>
                  当时 OI 状态：1h变化 <strong>{selectedItem.snapshot.oi.oi_1h_chg_pct}%</strong> · 4h变化{" "}
                  <strong>{selectedItem.snapshot.oi.oi_4h_chg_pct}%</strong> · 关系：
                  <strong style={{ color: "#fbd38d" }}>{selectedItem.snapshot.oi.price_relation}</strong>
                </div>
              )}
            </div>

            {/* Section 2: Agent Decision & 5-Seat Reasoning at t_i */}
            <div
              style={{
                marginTop: 10,
                padding: "10px 12px",
                borderRadius: 9,
                background: "rgba(26, 32, 44, 0.9)",
                border: "1px solid rgba(246, 173, 85, 0.25)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                <strong style={{ fontSize: 12, color: "#fbd38d" }}>
                  ② 当时 Agent 门禁与 5席推理结论
                </strong>
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: 6,
                    fontSize: 11.5,
                    fontWeight: 700,
                    background: actionBadgeStyle(selectedItem.action, selectedItem.gate_result === "pass", selectedItem.ai_status).bg,
                    color: actionBadgeStyle(selectedItem.action, selectedItem.gate_result === "pass", selectedItem.ai_status).color,
                  }}
                >
                  {actionBadgeStyle(selectedItem.action, selectedItem.gate_result === "pass", selectedItem.ai_status).label}
                  {selectedItem.confidence != null ? ` · 置信度 ${Math.round(Number(selectedItem.confidence) * 100)}%` : ""}
                </span>
              </div>

              {selectedItem.gate_reasons?.length > 0 && (
                <div style={{ fontSize: 11.5, color: "#fc8181", marginTop: 6 }}>
                  门禁拦截原因：{selectedItem.gate_reasons.join("；")}
                </div>
              )}

              {selectedItem.conflicts?.length > 0 && (
                <div style={{ fontSize: 11.5, color: "#f6ad55", marginTop: 4 }}>
                  多周期冲突提醒：{selectedItem.conflicts.join("；")}
                </div>
              )}

              {planOf(selectedItem) && (
                <div
                  style={{
                    marginTop: 8,
                    padding: "8px 10px",
                    borderRadius: 8,
                    background: "rgba(44, 31, 74, 0.65)",
                    border: "1px solid rgba(159, 122, 234, 0.5)",
                    fontSize: 11.5,
                  }}
                >
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", flexWrap: "wrap", gap: 6 }}>
                    <strong style={{ color: "#e9d8fd" }}>
                      {(planOf(selectedItem)?.plan_kind === "tight_sl_15m" || planOf(selectedItem)?.strategy_id === "tight_sl_15m") ? `🎯 15m 小止损策略共振（${planOf(selectedItem)?.pillar_count || 0}/3 维共振）` : `📐 综合止盈止损（形态极值+支撑压力+均线+ATR）`}
                    </strong>
                    <span
                      style={{
                        padding: "2px 8px",
                        borderRadius: 999,
                        fontWeight: 800,
                        fontSize: 11,
                        background: (planOf(selectedItem).confidence_pct ?? 0) >= 68 ? "rgba(72,187,120,0.25)" : "rgba(236,201,75,0.22)",
                        color: (planOf(selectedItem).confidence_pct ?? 0) >= 68 ? "#68d391" : "#f6e05e",
                      }}
                    >
                      信心指数：{planOf(selectedItem).confidence_band} · {planOf(selectedItem).confidence_pct}%
                    </span>
                  </div>
                  <div style={{ color: "#cbd5e0", marginTop: 4, lineHeight: 1.5 }}>
                    <div>• <strong>共振明细</strong>：{planOf(selectedItem).resonance_summary}</div>
                    <div>
                      • <strong>小止损入场方案</strong>：入场 <code style={{ color: "#68d391" }}>${planOf(selectedItem).entry}</code>
                      {" · "}止损 <code style={{ color: "#fc8181" }}>${planOf(selectedItem).sl} (-{planOf(selectedItem).sl_pct}%)</code>
                      {" · "}TP1 <code style={{ color: "#9ae6b4" }}>${planOf(selectedItem).tp1} (+{planOf(selectedItem).tp1_pct}%, {planOf(selectedItem).rr_tp1}R)</code>
                      {" · "}TP2 <code style={{ color: "#68d391" }}>${planOf(selectedItem).tp2} (+{planOf(selectedItem).tp2_pct}%, {planOf(selectedItem).rr_tp2}R)</code>
                    </div>
                    {planOf(selectedItem).score_breakdown && (
                      <div style={{ fontSize: 11, color: "#a0aec0", marginTop: 2 }}>
                        • <strong>信心指数拆解</strong>：
                        形态+{planOf(selectedItem).score_breakdown.pattern_score} / 支撑压力+{planOf(selectedItem).score_breakdown.sr_score} / 均线+{planOf(selectedItem).score_breakdown.ma_score} / 量能+{planOf(selectedItem).score_breakdown.volume_score} / 大周期+{planOf(selectedItem).score_breakdown.htf_score}
                      </div>
                    )}
                    {tightSlSimLabel(selectedItem) && (
                      <div style={{ marginTop: 6, color: "#e2e8f0" }}>
                        • <strong>按入场/止损/TP逐棒结算</strong>：{tightSlSimLabel(selectedItem)}
                        （持仓 {selectedItem.outcome?.tight_sl_sim?.bars_held ?? selectedItem.outcome?.tight_sl_sim?.bars_to_resolve ?? "—"} 根15m，
                        实得 {(selectedItem.outcome?.tight_sl_sim?.realized_r ?? 0) > 0 ? "+" : ""}
                        {selectedItem.outcome?.tight_sl_sim?.realized_r ?? "—"}R /{" "}
                        {(selectedItem.outcome?.tight_sl_sim?.realized_pct ?? selectedItem.outcome?.realized_pct ?? 0) > 0 ? "+" : ""}
                        {selectedItem.outcome?.tight_sl_sim?.realized_pct ?? selectedItem.outcome?.realized_pct ?? "—"}%）
                        {Array.isArray(selectedItem.outcome?.tight_sl_sim?.legs) && selectedItem.outcome!.tight_sl_sim!.legs!.length > 0 && (
                          <div style={{ marginTop: 4, fontSize: 11, color: "#a0aec0" }}>
                            分笔：{selectedItem.outcome!.tight_sl_sim!.legs!.map((lg, i) => (
                              <span key={i}>
                                {i > 0 ? " + " : ""}
                                {(lg.size * 100).toFixed(0)}%@{lg.price}({lg.why} {lg.pnl_pct > 0 ? "+" : ""}{lg.pnl_pct.toFixed(3)}%)
                              </span>
                            ))}
                          </div>
                        )}
                      </div>
                    )}
                  </div>
                </div>
              )}

              {(selectedItem.entry_watch || selectedItem.sl_watch) && (
                <div style={{ fontSize: 11.5, color: "#cbd5e0", marginTop: 6 }}>
                  观察入场位：<code style={{ color: "#68d391" }}>{selectedItem.entry_watch || "—"}</code> · 观察止损位：
                  <code style={{ color: "#fc8181" }}>{selectedItem.sl_watch || "—"}</code>
                </div>
              )}

              {selectedItem.rationale && (
                <div style={{ fontSize: 12, color: "#e2e8f0", marginTop: 6, lineHeight: 1.5 }}>
                  <strong>主审结论：</strong>
                  {selectedItem.rationale}
                </div>
              )}

              {selectedItem.llm && (
                <div style={{ marginTop: 8, display: "grid", gap: 6 }}>
                  {(
                    [
                      ["technical", "📐 技术面席 (Technical)"],
                      ["flow_oi", "💧 资金/OI席 (Flow & OI)"],
                      ["bull", "🐂 多头辩手 (Bull)"],
                      ["bear", "🐻 空头辩手 (Bear)"],
                      ["trader", "⚖️ 交易主审 (Trader)"],
                    ] as const
                  ).map(([key, title]) => {
                    const seat = (selectedItem.llm as Record<string, any>)?.[key];
                    if (!seat) return null;
                    return (
                      <div
                        key={key}
                        style={{
                          padding: "6px 9px",
                          borderRadius: 7,
                          background: "rgba(17, 24, 39, 0.75)",
                          border: "1px solid rgba(255,255,255,0.06)",
                          fontSize: 11.5,
                        }}
                      >
                        <div style={{ fontWeight: 700, color: "#90cdf4", marginBottom: 2 }}>{title}</div>
                        <div style={{ color: "#cbd5e0", lineHeight: 1.45, wordBreak: "break-word" }}>
                          {typeof seat === "string" ? seat : JSON.stringify(seat, null, 0)}
                        </div>
                      </div>
                    );
                  })}
                </div>
              )}

              {selectedItem.formatted_text && (
                <div style={{ marginTop: 8 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
                    <span style={{ fontSize: 11, color: "#a0aec0" }}>当时生成的标准推送文案：</span>
                    <button
                      type="button"
                      onClick={() => {
                        void navigator.clipboard.writeText(selectedItem.formatted_text || "");
                        setCopiedText(true);
                        setTimeout(() => setCopiedText(false), 1500);
                      }}
                      style={{
                        padding: "2px 8px",
                        borderRadius: 5,
                        border: "1px solid rgba(255,255,255,0.15)",
                        background: "rgba(45,55,72,0.7)",
                        color: "#e2e8f0",
                        fontSize: 11,
                        cursor: "pointer",
                      }}
                    >
                      {copiedText ? "✓ 已复制" : "复制文案"}
                    </button>
                  </div>
                  <pre
                    style={{
                      margin: 0,
                      padding: "8px 10px",
                      borderRadius: 7,
                      background: "rgba(0,0,0,0.35)",
                      color: "#e2e8f0",
                      fontSize: 11,
                      whiteSpace: "pre-wrap",
                      lineHeight: 1.45,
                    }}
                  >
                    {selectedItem.formatted_text}
                  </pre>
                </div>
              )}
            </div>

            {/* Section 3: Post-t_i Ground Truth Verification */}
            <div
              style={{
                marginTop: 10,
                padding: "10px 12px",
                borderRadius: 9,
                background: "rgba(26, 32, 44, 0.9)",
                border: "1px solid rgba(72, 187, 120, 0.3)",
              }}
            >
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 6 }}>
                <strong style={{ fontSize: 12, color: "#68d391" }}>
                  ③ 信号后真实行情复盘（Agent当时不可见的后续 24h 走势）
                </strong>
                <span
                  style={{
                    padding: "2px 8px",
                    borderRadius: 6,
                    fontSize: 11,
                    fontWeight: 700,
                    background: verdictStyle(selectedItem.outcome.verdict).bg,
                    color: verdictStyle(selectedItem.outcome.verdict).color,
                  }}
                >
                  {selectedItem.outcome.verdict_label}
                </span>
              </div>

              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "repeat(4, 1fr)",
                  gap: 6,
                  marginBottom: 8,
                  textAlign: "center",
                }}
              >
                {(
                  [
                    ["+1h", selectedItem.outcome.price_1h, selectedItem.outcome.dir_ret_1h_pct],
                    ["+4h", selectedItem.outcome.price_4h, selectedItem.outcome.dir_ret_4h_pct],
                    ["+8h", selectedItem.outcome.price_8h, selectedItem.outcome.dir_ret_8h_pct],
                    ["+24h", selectedItem.outcome.price_24h, selectedItem.outcome.dir_ret_24h_pct],
                  ] as const
                ).map(([lbl, px, ret]) => (
                  <div
                    key={lbl}
                    style={{
                      padding: "6px 4px",
                      borderRadius: 7,
                      background: "rgba(17,24,39,0.75)",
                      border: "1px solid rgba(255,255,255,0.06)",
                    }}
                  >
                    <div style={{ fontSize: 10.5, color: "#a0aec0" }}>{lbl} 顺向收益</div>
                    <div style={{ fontSize: 13.5, fontWeight: 800, color: pctColor(ret), fontFamily: "monospace" }}>
                      {fmtPct(ret)}
                    </div>
                    <div style={{ fontSize: 10.5, color: "#718096", fontFamily: "monospace" }}>
                      {px ? `$${px.toLocaleString()}` : "未走完"}
                    </div>
                  </div>
                ))}
              </div>

              <div style={{ fontSize: 11.5, color: "#cbd5e0", marginBottom: 8 }}>
                4h 顺向MFE：
                <strong style={{ color: "#68d391" }}>
                  +{selectedItem.outcome.mfe_4h_pct}% (${(selectedItem.outcome.fav_4h_price ?? selectedItem.price).toLocaleString()})
                </strong>
                {" · "}逆向MAE：
                <strong style={{ color: "#fc8181" }}>
                  -{selectedItem.outcome.mae_4h_pct}% (${(selectedItem.outcome.adv_4h_price ?? selectedItem.price).toLocaleString()})
                </strong>
                <br />
                8h 顺向MFE：
                <strong style={{ color: "#68d391" }}>
                  +{selectedItem.outcome.mfe_8h_pct}% (${(selectedItem.outcome.fav_8h_price ?? selectedItem.price).toLocaleString()})
                </strong>
                {" · "}逆向MAE：
                <strong style={{ color: "#fc8181" }}>
                  -{selectedItem.outcome.mae_8h_pct}% (${(selectedItem.outcome.adv_8h_price ?? selectedItem.price).toLocaleString()})
                </strong>
              </div>

              {/* Trajectory Table */}
              {selectedItem.outcome.future_path?.length > 0 && (
                <div style={{ overflowX: "auto" }}>
                  <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 11, fontFamily: "monospace" }}>
                    <thead>
                      <tr style={{ color: "#a0aec0", borderBottom: "1px solid rgba(255,255,255,0.08)" }}>
                        <th style={{ padding: "3px 5px", textAlign: "left" }}>后续时刻</th>
                        <th style={{ padding: "3px 5px", textAlign: "right" }}>收盘价</th>
                        <th style={{ padding: "3px 5px", textAlign: "right" }}>最高/最低</th>
                        <th style={{ padding: "3px 5px", textAlign: "right" }}>原始涨跌</th>
                        <th style={{ padding: "3px 5px", textAlign: "right" }}>顺向盈亏</th>
                      </tr>
                    </thead>
                    <tbody>
                      {selectedItem.outcome.future_path.map((pt) => (
                        <tr key={pt.offset_h} style={{ borderBottom: "1px solid rgba(255,255,255,0.04)" }}>
                          <td style={{ padding: "3px 5px", color: "#cbd5e0" }}>
                            +{pt.offset_h}h ({pt.time_iso})
                          </td>
                          <td style={{ padding: "3px 5px", textAlign: "right", color: "#f7fafc" }}>
                            ${pt.close.toLocaleString()}
                          </td>
                          <td style={{ padding: "3px 5px", textAlign: "right", color: "#718096" }}>
                            {pt.high.toLocaleString()} / {pt.low.toLocaleString()}
                          </td>
                          <td style={{ padding: "3px 5px", textAlign: "right", color: pctColor(pt.raw_ret_pct) }}>
                            {fmtPct(pt.raw_ret_pct)}
                          </td>
                          <td style={{ padding: "3px 5px", textAlign: "right", fontWeight: 700, color: pctColor(pt.dir_ret_pct) }}>
                            {fmtPct(pt.dir_ret_pct)}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
});
