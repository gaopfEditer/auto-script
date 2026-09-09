/**
 * 形态 ticker 信号胜率：对齐 Discord 卡片清算口径。
 * - 信号后满 3h 核实
 * - 仅有方向时默认 ±5% 止盈/止损（与 LIQUIDATION_DEFAULT_TP_SL_PCT 一致）
 * - 杠杆：BTC/ETH/SOL 100x，其余山寨 20x
 * - K 线时序先触 SL / TP；窗口内未触达则按收盘价相对入场结算
 */
import type { PatternAlert } from "../types";
import { fetchBinanceFuturesKlines } from "./binanceKlines";
import { displaySymbol, humanBaseAsset, isStablecoinSymbol, toUsdtSymbol, priceScaleAlignFactor } from "./symbol";

export type AlertOutcome = "pending" | "take_profit" | "stop_loss" | "flat" | "error";

export type AlertStatsRecord = {
  key: string;
  /** UI 展示名，如 PEPE */
  symbol: string;
  /** 拉 K 线用的合约名，如 1000PEPEUSDT / BTCUSDT */
  tradeSymbol?: string;
  dir: "多" | "空" | "—";
  side: "long" | "short" | "flat";
  signalAt: number;
  entry: number;
  tier: "major" | "altcoin";
  /** 默认止盈止损幅度 %（卡片方向单默认 5） */
  stepPct: number;
  verifyAt: number;
  outcome: AlertOutcome;
  hitAt?: number;
  exitPrice?: number;
  /** 结算时价格变动 %（有利为正） */
  movePct?: number;
  verifiedAt?: number;
  error?: string;
  typeLabel?: string;
  interval?: string;
  /** 核实窗内最大浮盈（杠杆保证金 %） */
  maxProfitPct?: number;
  /** 最大浮盈时的价格 */
  maxProfitPrice?: number;
  /** 最大浮盈时间 ms */
  maxProfitAt?: number;
};

export type AlertWinRateSummary = {
  total: number;
  pending: number;
  wins: number;
  losses: number;
  flats: number;
  errors: number;
  winRate: number | null;
  /** 已核信号杠杆保证金盈亏合计 %（胜正负负，对齐单笔 alertStatsPnlPct） */
  totalPnlPct: number | null;
};

const STATS_CACHE_KEY = "oi_pattern_alert_stats_v1";
/** 本地缓存软上限（核实/Ticker 用）；完整历史走服务端分页长期保存 */
const LOCAL_STATS_SOFT_MAX = 2000;
/** 弹窗列表每页条数 */
export const ALERT_STATS_PAGE_SIZE = 100;
/** 与卡片核实窗口一致：信号后满 3h */
export const ALERT_VERIFY_DELAY_MS = 3 * 60 * 60_000;
/** 与 card-liquidation-engine LIQUIDATION_DEFAULT_TP_SL_PCT 一致 */
export const ALERT_DEFAULT_TP_SL_PCT = 5;
/** BTC/ETH/SOL 100x；其余 20x（对齐 resolveLiquidationLeverage） */
const LEV_100_BASES = new Set(["BTC", "ETH", "SOL"]);

/** 弹窗头部展示用：核算规则摘要 */
export const ALERT_SETTLE_RULES_SUMMARY =
  `核算规则：BTC/ETH/SOL 100x · 山寨 20x · 默认 ±${ALERT_DEFAULT_TP_SL_PCT}% 止盈/止损 · 信号后 3h 核实 · 先触止损/止盈，未触则按窗口末价结算`;

let memoryStats: AlertStatsRecord[] = [];
/** 串行核实队列：避免 busy 时重拉被静默丢弃 */
let verifyChain: Promise<unknown> = Promise.resolve();

function withVerifyLock<T>(fn: () => Promise<T>): Promise<T> {
  const run = verifyChain.then(fn, fn);
  verifyChain = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

/** 从 alert / message / key 解析类型文案（兼容旧缓存缺 typeLabel） */
export function resolveAlertTypeLabel(
  alert?: Partial<PatternAlert> | null,
  key = "",
  fallback = "",
): string {
  const direct = String(
    alert?.type_label || alert?.pattern_label || alert?.signal_text || "",
  ).trim();
  if (direct) return direct;

  const msg = String(alert?.message || "").trim();
  if (msg) {
    const head = msg.split(/[·•|｜]/)[0]?.trim();
    if (head) return head;
  }

  // key = type:symbol:closeTime:messageOrLabel
  if (key) {
    const parts = key.split(":");
    if (parts.length >= 4) {
      const tail = parts.slice(3).join(":").trim();
      const head = tail.split(/[·•|｜]/)[0]?.trim();
      if (head) return head;
    }
  }

  const status = String(alert?.status_label || "").replace(/^.*·\s*/, "").trim();
  if (status) return status;
  return String(fallback || "").trim();
}

function detectTier(symbol: string): "major" | "altcoin" {
  const bare = humanBaseAsset(symbol);
  return LEV_100_BASES.has(bare) ? "major" : "altcoin";
}

/** 卡片清算杠杆：主流 100 / 山寨 20 */
export function resolveAlertLeverage(symbol: string): number {
  return LEV_100_BASES.has(humanBaseAsset(symbol)) ? 100 : 20;
}

function priceMovePct(entry: number, price: number, isShort: boolean): number {
  if (!entry || !Number.isFinite(price)) return 0;
  return isShort ? ((entry - price) / entry) * 100 : ((price - entry) / entry) * 100;
}

function alertEntryPrice(a: PatternAlert): number | null {
  for (const v of [a.price, a.close, a.last_price, a.entry_price]) {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return null;
}

function alertSide(dir: "多" | "空" | "—", a: PatternAlert): "long" | "short" | "flat" {
  if (dir === "多") return "long";
  if (dir === "空") return "short";
  const side = String(a.side || "").toLowerCase();
  if (side === "bull" || side === "long") return "long";
  if (side === "bear" || side === "short") return "short";
  return "flat";
}

function toMs(raw: number): number {
  let n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  if (n < 1e12) n *= 1000;
  return n;
}

function pruneStats(list: AlertStatsRecord[]): AlertStatsRecord[] {
  return list
    .filter((r) => r && typeof r.key === "string" && Number(r.signalAt) > 0)
    .filter((r) => !isStablecoinSymbol(r.tradeSymbol || r.symbol))
    .sort((a, b) => b.signalAt - a.signalAt)
    .slice(0, LOCAL_STATS_SOFT_MAX);
}

function persistStats(list: AlertStatsRecord[]) {
  const next = pruneStats(list);
  memoryStats = next;
  try {
    localStorage.setItem(STATS_CACHE_KEY, JSON.stringify({ items: next, savedAt: Date.now() }));
  } catch {
    /* quota */
  }
  return next;
}

function preferStatsRecord(a: AlertStatsRecord, b: AlertStatsRecord): AlertStatsRecord {
  const rank = (o: AlertOutcome) =>
    o === "pending" ? 0 : o === "error" ? 1 : o === "flat" ? 2 : 3;
  const ra = rank(a.outcome);
  const rb = rank(b.outcome);
  if (rb !== ra) return rb > ra ? { ...a, ...b } : { ...b, ...a };
  const va = a.verifiedAt || 0;
  const vb = b.verifiedAt || 0;
  if (vb !== va) return vb > va ? { ...a, ...b } : { ...b, ...a };
  // 补全字段
  return {
    ...a,
    ...b,
    typeLabel: b.typeLabel || a.typeLabel,
    interval: b.interval || a.interval,
    tradeSymbol: b.tradeSymbol || a.tradeSymbol,
  };
}

function mergeAlertStatsLists(
  primary: AlertStatsRecord[],
  secondary: AlertStatsRecord[],
): AlertStatsRecord[] {
  const byKey = new Map<string, AlertStatsRecord>();
  for (const r of secondary) {
    if (r?.key) byKey.set(r.key, r);
  }
  for (const r of primary) {
    if (!r?.key) continue;
    const cur = byKey.get(r.key);
    byKey.set(r.key, cur ? preferStatsRecord(cur, r) : r);
  }
  return pruneStats([...byKey.values()]);
}

export type AlertStatsTypeOption = {
  label: string;
  count: number;
  wins?: number;
  losses?: number;
  winRate: number | null;
  totalPnlPct: number | null;
};

export type AlertStatsIntervalOption = AlertStatsTypeOption;

export type AlertStatsPageResult = {
  items: AlertStatsRecord[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  summary: AlertWinRateSummary;
  typeOptions: AlertStatsTypeOption[];
  intervalOptions: AlertStatsIntervalOption[];
  /** @deprecated 用 typeOptions */
  typeLabels: string[];
};

function coerceSummary(raw: Partial<AlertWinRateSummary> | undefined, items: AlertStatsRecord[]): AlertWinRateSummary {
  if (raw && typeof raw.total === "number") {
    return {
      total: raw.total,
      pending: Number(raw.pending) || 0,
      wins: Number(raw.wins) || 0,
      losses: Number(raw.losses) || 0,
      flats: Number(raw.flats) || 0,
      errors: Number(raw.errors) || 0,
      winRate: raw.winRate == null ? null : Number(raw.winRate),
      totalPnlPct:
        raw.totalPnlPct == null || !Number.isFinite(Number(raw.totalPnlPct))
          ? null
          : Number(raw.totalPnlPct),
    };
  }
  return summarizeAlertWinRate(items);
}

/** 服务端分页拉取（长期库）；弹窗列表用此接口。 */
export async function fetchAlertStatsPage(opts: {
  page?: number;
  pageSize?: number;
  timeFilter?: AlertStatsTimeFilter;
  typeFilter?: string;
  intervalFilter?: string;
}): Promise<AlertStatsPageResult> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? ALERT_STATS_PAGE_SIZE));
  const timeFilter = opts.timeFilter ?? "all";
  const typeFilter = opts.typeFilter && opts.typeFilter !== "all" ? opts.typeFilter : "all";
  const intervalFilter = opts.intervalFilter && opts.intervalFilter !== "all" ? opts.intervalFilter : "all";
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    time: timeFilter === "all" ? "all" : timeFilter,
    type: typeFilter,
    interval: intervalFilter,
  });
  const empty: AlertStatsPageResult = {
    items: [],
    total: 0,
    page: 1,
    pageSize,
    pages: 1,
    summary: summarizeAlertWinRate([]),
    typeOptions: [],
    intervalOptions: [],
    typeLabels: [],
  };
  try {
    const res = await fetch(`/api/pattern-alert-stats?${params.toString()}`, {
      cache: "no-store",
    });
    if (!res.ok) return empty;
    const body = (await res.json()) as {
      ok?: boolean;
      items?: AlertStatsRecord[];
      total?: number;
      page?: number;
      pageSize?: number;
      pages?: number;
      summary?: Partial<AlertWinRateSummary>;
      typeOptions?: AlertStatsTypeOption[];
      intervalOptions?: AlertStatsIntervalOption[];
      typeLabels?: string[];
    };
    if (!body?.ok || !Array.isArray(body.items)) return empty;
    const items = hydrateStatsMeta(
      body.items.filter(
        (r) => r && typeof r.key === "string" && typeof r.signalAt === "number",
      ),
    );
    const typeOptions = normalizeTypeOptions(body.typeOptions, body.typeLabels, items);
    const intervalOptions = mergeIntervalOptions(
      normalizeIntervalOptions(body.intervalOptions, items),
      items,
    );
    return {
      items,
      total: Number(body.total) || items.length,
      page: Number(body.page) || page,
      pageSize: Number(body.pageSize) || pageSize,
      pages: Math.max(1, Number(body.pages) || 1),
      summary: coerceSummary(body.summary, items),
      typeOptions,
      intervalOptions,
      typeLabels: typeOptions.map((t) => t.label),
    };
  } catch {
    return empty;
  }
}

function normalizeTypeOptions(
  rawOpts: AlertStatsTypeOption[] | undefined,
  rawLabels: string[] | undefined,
  pageItems: AlertStatsRecord[],
): AlertStatsTypeOption[] {
  if (Array.isArray(rawOpts) && rawOpts.length) {
    return rawOpts
      .filter((o) => o && typeof o.label === "string")
      .map((o) => ({
        label: String(o.label),
        count: Number(o.count) || 0,
        wins: Number(o.wins) || 0,
        losses: Number(o.losses) || 0,
        winRate:
          o.winRate == null || !Number.isFinite(Number(o.winRate))
            ? null
            : Number(o.winRate),
        totalPnlPct:
          o.totalPnlPct == null || !Number.isFinite(Number(o.totalPnlPct))
            ? null
            : Number(o.totalPnlPct),
      }));
  }
  // 回退：仅有 label 列表或本页数据
  if (Array.isArray(rawLabels) && rawLabels.length) {
    return rawLabels.map((label) => ({
      label: String(label),
      count: 0,
      winRate: null,
      totalPnlPct: null,
    }));
  }
  return listAlertStatsTypeOptions(pageItems);
}

/** 类型下拉展示文案：名称 · 胜率 · 合计盈亏 */
export function formatAlertTypeOptionLabel(opt: AlertStatsTypeOption): string {
  const wr =
    opt.winRate == null ? "胜率 —" : `胜率 ${(opt.winRate * 100).toFixed(0)}%`;
  const pnl =
    opt.totalPnlPct == null || !Number.isFinite(opt.totalPnlPct)
      ? "合计 —"
      : `合计 ${opt.totalPnlPct > 0 ? "+" : ""}${opt.totalPnlPct.toFixed(1)}%`;
  const n = opt.count > 0 ? ` (${opt.count})` : "";
  return `${opt.label}${n} · ${wr} · ${pnl}`;
}

export function formatIntervalOptionLabel(opt: AlertStatsIntervalOption): string {
  const label = opt.label || "";
  const wr =
    opt.winRate == null ? "胜率 —" : `胜率 ${(opt.winRate * 100).toFixed(0)}%`;
  const pnl =
    opt.totalPnlPct == null || !Number.isFinite(opt.totalPnlPct)
      ? "合计 —"
      : `合计 ${opt.totalPnlPct > 0 ? "+" : ""}${opt.totalPnlPct.toFixed(1)}%`;
  const n = opt.count > 0 ? ` (${opt.count})` : "";
  return `${label}${n} · ${wr} · ${pnl}`;
}

/** 周期下拉回退（前端本地统计） */
function listAlertStatsIntervalOptions(records: AlertStatsRecord[]): AlertStatsIntervalOption[] {
  const groups = new Map<string, AlertStatsRecord[]>();
  for (const r of records) {
    const iv = String(r.interval || "").trim() || "—";
    const arr = groups.get(iv) || [];
    arr.push(r);
    groups.set(iv, arr);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "zh-CN"))
    .map(([label, rows]) => {
      const s = summarizeAlertWinRate(rows);
      return {
        label,
        count: rows.length,
        wins: s.wins,
        losses: s.losses,
        winRate: s.winRate,
        totalPnlPct: s.totalPnlPct,
      };
    });
}

/** 周期下拉：只做归一化（保留原逻辑，主体已由 mergeIntervalOptions 接管） */
function normalizeIntervalOptions(
  rawOpts: AlertStatsIntervalOption[] | undefined,
  _pageItems: AlertStatsRecord[],
): AlertStatsIntervalOption[] {
  if (Array.isArray(rawOpts) && rawOpts.length) {
    return rawOpts
      .filter((o) => o && typeof o.label === "string")
      .map((o) => ({
        label: String(o.label),
        count: Number(o.count) || 0,
        wins: Number(o.wins) || 0,
        losses: Number(o.losses) || 0,
        winRate:
          o.winRate == null || !Number.isFinite(Number(o.winRate))
            ? null
            : Number(o.winRate),
        totalPnlPct:
          o.totalPnlPct == null || !Number.isFinite(Number(o.totalPnlPct))
            ? null
            : Number(o.totalPnlPct),
      }));
  }
  return listAlertStatsIntervalOptions(pageItems);
}

/** 从后台拉取近期共享库（供 Ticker/核实本地缓存），与本地合并 */
export async function syncAlertStatsFromServer(): Promise<AlertStatsRecord[]> {
  try {
    // 只拉近 7 天、每页 100、多页拼到软上限，避免全量灌入 localStorage
    const mergedPages: AlertStatsRecord[] = [];
    let page = 1;
    let pages = 1;
    while (page <= pages && mergedPages.length < LOCAL_STATS_SOFT_MAX) {
      const chunk = await fetchAlertStatsPage({
        page,
        pageSize: ALERT_STATS_PAGE_SIZE,
        timeFilter: "7d",
        typeFilter: "all",
        intervalFilter: "all",
      });
      pages = chunk.pages;
      mergedPages.push(...chunk.items);
      if (chunk.items.length === 0) break;
      page += 1;
      if (page > 20) break; // 最多 2000
    }
    const merged = mergeAlertStatsLists(mergedPages, loadAlertStats());
    persistStats(merged);
    return merged;
  } catch {
    return loadAlertStats();
  }
}

/** 结算结果回写后台 */
export async function pushAlertStatsToServer(
  updates: AlertStatsRecord[],
): Promise<void> {
  if (!updates.length) return;
  try {
    const res = await fetch("/api/pattern-alert-stats", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ updates }),
    });
    if (!res.ok) return;
    // 本地仍合并本次 updates；服务端不再回传全量
    persistStats(mergeAlertStatsLists(updates, loadAlertStats()));
  } catch {
    /* offline */
  }
}

function hydrateStatsMeta(list: AlertStatsRecord[]): AlertStatsRecord[] {
  let changed = false;
  const next = list.map((r) => {
    const typeLabel =
      String(r.typeLabel || "").trim() || resolveAlertTypeLabel(null, r.key, "");
    const tradeSymbol = r.tradeSymbol || toUsdtSymbol(r.symbol) || r.symbol;
    if (typeLabel === (r.typeLabel || "") && tradeSymbol === r.tradeSymbol) return r;
    changed = true;
    return { ...r, typeLabel: typeLabel || r.typeLabel, tradeSymbol };
  });
  return changed ? next : list;
}

export function loadAlertStats(): AlertStatsRecord[] {
  if (memoryStats.length) {
    const hydrated = hydrateStatsMeta(pruneStats(memoryStats));
    if (hydrated !== memoryStats) memoryStats = hydrated;
    return memoryStats;
  }
  try {
    const raw = localStorage.getItem(STATS_CACHE_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as { items?: AlertStatsRecord[] };
    const items = Array.isArray(parsed?.items) ? parsed.items : [];
    const pruned = pruneStats(
      items.filter(
        (r) =>
          r &&
          typeof r.key === "string" &&
          typeof r.signalAt === "number" &&
          typeof r.entry === "number",
      ),
    );
    memoryStats = hydrateStatsMeta(pruned);
    if (memoryStats !== pruned) {
      try {
        localStorage.setItem(
          STATS_CACHE_KEY,
          JSON.stringify({ items: memoryStats, savedAt: Date.now() }),
        );
      } catch {
        /* quota */
      }
    }
    return memoryStats;
  } catch {
    return [];
  }
}

export function summarizeAlertWinRate(records: AlertStatsRecord[]): AlertWinRateSummary {
  let pending = 0;
  let wins = 0;
  let losses = 0;
  let flats = 0;
  let errors = 0;
  let totalPnl = 0;
  let pnlN = 0;
  for (const r of records) {
    if (r.outcome === "pending") pending++;
    else if (r.outcome === "take_profit") wins++;
    else if (r.outcome === "stop_loss") losses++;
    else if (r.outcome === "flat") flats++;
    else errors++;

    // 与 alertStatsPnlPct 同口径；缺 movePct 时用 stepPct（默认 ±5%）兜底，避免合计空白
    if (r.outcome !== "pending" && r.outcome !== "error") {
      let priceMove: number | null =
        r.movePct != null && Number.isFinite(r.movePct) ? Number(r.movePct) : null;
      if (priceMove == null && (r.outcome === "take_profit" || r.outcome === "stop_loss")) {
        const step = r.stepPct > 0 ? r.stepPct : ALERT_DEFAULT_TP_SL_PCT;
        priceMove = step;
      }
      if (priceMove != null && Number.isFinite(priceMove)) {
        const signed =
          r.outcome === "stop_loss"
            ? -Math.abs(priceMove)
            : r.outcome === "take_profit"
              ? Math.abs(priceMove)
              : priceMove;
        const lev = resolveAlertLeverage(r.symbol);
        totalPnl += Math.round(signed * lev * 100) / 100;
        pnlN++;
      }
    }
  }
  const settled = wins + losses;
  return {
    total: records.length,
    pending,
    wins,
    losses,
    flats,
    errors,
    winRate: settled > 0 ? wins / settled : null,
    totalPnlPct: pnlN > 0 ? Math.round(totalPnl * 100) / 100 : null,
  };
}

/** 登记 / 更新待核实信号（有方向且有入场价才计入） */
export function upsertAlertForStats(input: {
  key: string;
  alert: PatternAlert;
  signalAt: number;
  dir: "多" | "空" | "—";
}): AlertStatsRecord | null {
  if (isStablecoinSymbol(String(input.alert.symbol || ""))) return null;
  const side = alertSide(input.dir, input.alert);
  if (side === "flat") return null;
  const entry = alertEntryPrice(input.alert);
  if (entry == null) return null;

  const signalAt = toMs(input.signalAt);
  const tier = detectTier(input.alert.symbol);
  const stepPct = ALERT_DEFAULT_TP_SL_PCT;
  const typeLabel = resolveAlertTypeLabel(input.alert, input.key);
  const interval = String(input.alert.interval || "").trim();
  const tradeSymbol =
    toUsdtSymbol(input.alert.symbol) || String(input.alert.symbol || "");
  const list = loadAlertStats();
  const existing = list.find((r) => r.key === input.key);
  if (existing) {
    const needLabel = !String(existing.typeLabel || "").trim() && !!typeLabel;
    const needInterval = !String(existing.interval || "").trim() && !!interval;
    const needTrade = !existing.tradeSymbol && !!tradeSymbol;
    const needRules =
      existing.outcome === "pending" &&
      (existing.stepPct !== stepPct || existing.tier !== tier);
    const retryError = existing.outcome === "error" && needTrade;

    if (needLabel || needInterval || needTrade || needRules || retryError) {
      const patched: AlertStatsRecord = {
        ...existing,
        typeLabel: needLabel ? typeLabel : existing.typeLabel,
        interval: needInterval ? interval : existing.interval,
        tradeSymbol: needTrade || retryError ? tradeSymbol : existing.tradeSymbol,
        ...(needRules || retryError
          ? {
              tier,
              stepPct,
              ...(retryError
                ? {
                    outcome: "pending" as const,
                    error: undefined,
                    verifiedAt: undefined,
                  }
                : {}),
            }
          : {}),
      };
      persistStats(list.map((r) => (r.key === input.key ? patched : r)));
      return patched;
    }
    return existing;
  }

  const rec: AlertStatsRecord = {
    key: input.key,
    symbol: displaySymbol(input.alert.symbol),
    tradeSymbol,
    dir: input.dir,
    side,
    signalAt,
    entry,
    tier,
    stepPct,
    verifyAt: signalAt + ALERT_VERIFY_DELAY_MS,
    outcome: "pending",
    typeLabel,
    interval,
  };
  persistStats([rec, ...list]);
  return rec;
}

type Bar = { ts: number; high: number; low: number; close: number };

/** 将 K 线 OHLC 对齐到入场价量级（1000SHIB 合约价 ↔ SHIB 人类价） */
function alignBarsToEntry(bars: Bar[], entry: number): Bar[] {
  if (!(entry > 0) || !bars.length) return bars;
  const samples = bars
    .slice(0, Math.min(8, bars.length))
    .map((b) => b.close)
    .filter((c) => c > 0)
    .sort((a, b) => a - b);
  if (!samples.length) return bars;
  const mid = samples[Math.floor(samples.length / 2)]!;
  const factor = priceScaleAlignFactor(mid, entry);
  if (factor === 1) return bars;
  return bars.map((b) => ({
    ts: b.ts,
    high: b.high * factor,
    low: b.low * factor,
    close: b.close * factor,
  }));
}

type MaxProfitTrack = {
  maxProfitPct?: number;
  maxProfitPrice?: number;
  maxProfitAt?: number;
};

function trackMaxProfit(
  rec: AlertStatsRecord,
  isShort: boolean,
  bars: Bar[],
  untilTsInclusive: number,
): MaxProfitTrack {
  const lev = resolveAlertLeverage(rec.symbol);
  let maxPriceMove = -Infinity;
  let maxProfitPrice: number | undefined;
  let maxProfitAt: number | undefined;
  for (const k of bars) {
    if (k.ts > untilTsInclusive) break;
    const best = isShort ? k.low : k.high;
    const move = priceMovePct(rec.entry, best, isShort);
    if (move > maxPriceMove) {
      maxPriceMove = move;
      maxProfitPrice = best;
      maxProfitAt = k.ts;
    }
  }
  if (!Number.isFinite(maxPriceMove) || maxPriceMove <= 0 || maxProfitPrice == null) {
    return {};
  }
  return {
    maxProfitPct: Math.round(maxPriceMove * lev * 100) / 100,
    maxProfitPrice,
    maxProfitAt,
  };
}

/**
 * 对齐卡片清算：时序先触 SL/TP（默认 ±5%）。
 * 同时记录窗内最大浮盈（杠杆 % + 价格），供悬停展示。
 */
export function settleAlertByKlines(
  rec: AlertStatsRecord,
  bars: Bar[],
  now = Date.now(),
): AlertStatsRecord {
  const isShort = rec.side === "short";
  const stepPct = rec.stepPct > 0 ? rec.stepPct : ALERT_DEFAULT_TP_SL_PCT;
  const step = stepPct / 100;
  const entry = rec.entry;
  const tp = isShort ? entry * (1 - step) : entry * (1 + step);
  const sl = isShort ? entry * (1 + step) : entry * (1 - step);
  const windowEnd = Math.min(now, rec.verifyAt);
  // 先对齐量级，再比价：避免入场 0.000005、K 线 0.005 算出十万倍盈亏
  const aligned = alignBarsToEntry(bars, entry);
  const sorted = [...aligned]
    .filter((b) => b.ts >= rec.signalAt - 1 && b.ts <= windowEnd + 60_000)
    .sort((a, b) => a.ts - b.ts);

  const finish = (
    partial: Partial<AlertStatsRecord> & { hitAt?: number },
  ): AlertStatsRecord => {
    const until = partial.hitAt ?? sorted[sorted.length - 1]?.ts ?? windowEnd;
    const max = trackMaxProfit(rec, isShort, sorted, until);
    return {
      ...rec,
      tier: detectTier(rec.symbol),
      stepPct,
      ...partial,
      ...max,
      verifiedAt: now,
    };
  };

  for (const k of sorted) {
    if (isShort) {
      if (k.high >= sl) {
        return finish({
          outcome: "stop_loss",
          hitAt: k.ts,
          exitPrice: sl,
          movePct: priceMovePct(entry, sl, isShort),
        });
      }
      if (k.low <= tp) {
        return finish({
          outcome: "take_profit",
          hitAt: k.ts,
          exitPrice: tp,
          movePct: priceMovePct(entry, tp, isShort),
        });
      }
    } else {
      if (k.low <= sl) {
        return finish({
          outcome: "stop_loss",
          hitAt: k.ts,
          exitPrice: sl,
          movePct: priceMovePct(entry, sl, isShort),
        });
      }
      if (k.high >= tp) {
        return finish({
          outcome: "take_profit",
          hitAt: k.ts,
          exitPrice: tp,
          movePct: priceMovePct(entry, tp, isShort),
        });
      }
    }
  }

  // 满 3h 仍未触达：按窗口末收盘相对入场结算（对齐卡片 classifyOutcomeByExit）
  if (now < rec.verifyAt) return rec;
  const last = sorted[sorted.length - 1];
  if (!last) {
    return { ...rec, outcome: "error", error: "no_klines", verifiedAt: now };
  }
  const move = priceMovePct(entry, last.close, isShort);
  if (Math.abs(move) < 1e-4) {
    return finish({
      outcome: "flat",
      exitPrice: last.close,
      movePct: move,
      hitAt: last.ts,
    });
  }
  return finish({
    outcome: move > 0 ? "take_profit" : "stop_loss",
    exitPrice: last.close,
    movePct: move,
    hitAt: last.ts,
  });
}

async function fetchBarsForRecord(
  rec: AlertStatsRecord,
): Promise<{ bars: Bar[]; resolvedSymbol: string }> {
  const endMs = Math.min(Date.now(), rec.verifyAt + 5 * 60_000);
  const sym = rec.tradeSymbol || toUsdtSymbol(rec.symbol) || rec.symbol;
  if (isStablecoinSymbol(sym)) {
    throw new Error("稳定币已排除回溯");
  }
  const { candles, resolvedSymbol } = await fetchBinanceFuturesKlines(sym, "5m", {
    startTimeMs: Math.max(0, rec.signalAt - 60_000),
    endTimeMs: endMs,
    limit: 500,
  });
  if (!candles.length) {
    throw new Error(`K线为空 (${resolvedSymbol || sym})`);
  }
  return {
    resolvedSymbol: resolvedSymbol || sym,
    bars: candles.map((c) => ({
      ts: c.time * 1000,
      high: c.high,
      low: c.low,
      close: c.close,
    })),
  };
}

/** 把失败项重置为 pending 并立刻再核 */
export async function retryFailedAlertStats(
  onUpdate?: (summary: AlertWinRateSummary) => void,
): Promise<AlertWinRateSummary> {
  const list = loadAlertStats();
  const failedKeys = list.filter((r) => r.outcome === "error").map((r) => r.key);
  return reverifyAlertStatsByKeys(failedKeys, onUpdate);
}

/**
 * 对指定 key 强制重拉 K 线并重新核算（已胜/负/失败/待核均可）。
 * 窗口终点取当前时间，便于未满 3h 也能预览、满 3h 后可重算。
 * 与定时核实串行排队，不会因 busy 静默丢弃。
 */
export async function reverifyAlertStatsByKeys(
  keys: string[],
  onUpdate?: (summary: AlertWinRateSummary) => void,
): Promise<AlertWinRateSummary> {
  const summary = () => summarizeAlertWinRate(loadAlertStats());
  const keySet = new Set(keys.filter(Boolean));
  if (!keySet.size) return summary();

  const now = Date.now();
  // 立刻标成 pending，UI 能立刻看到变化（即使还在排队）
  let working = loadAlertStats().map((r) => {
    if (!keySet.has(r.key)) return r;
    return {
      ...r,
      tradeSymbol: r.tradeSymbol || toUsdtSymbol(r.symbol) || r.symbol,
      tier: detectTier(r.symbol),
      stepPct: ALERT_DEFAULT_TP_SL_PCT,
      typeLabel:
        String(r.typeLabel || "").trim() ||
        resolveAlertTypeLabel(null, r.key, r.typeLabel || ""),
      outcome: "pending" as const,
      error: undefined,
      verifiedAt: undefined,
      hitAt: undefined,
      exitPrice: undefined,
      movePct: undefined,
      maxProfitPct: undefined,
      maxProfitPrice: undefined,
      maxProfitAt: undefined,
      verifyAt: now,
    };
  });
  persistStats(working);
  onUpdate?.(summarizeAlertWinRate(working));

  return withVerifyLock(async () => {
    working = loadAlertStats();
    const settleNow = Date.now();
    const touched: AlertStatsRecord[] = [];
    for (const key of keySet) {
      const rec = working.find((r) => r.key === key);
      if (!rec) continue;
      try {
        const { bars, resolvedSymbol } = await fetchBarsForRecord(rec);
        const withSym =
          resolvedSymbol && resolvedSymbol !== rec.tradeSymbol
            ? { ...rec, tradeSymbol: resolvedSymbol }
            : rec;
        const settled = settleAlertByKlines(withSym, bars, settleNow);
        working = working.map((r) => (r.key === key ? settled : r));
        persistStats(working);
        touched.push(settled);
        onUpdate?.(summarizeAlertWinRate(working));
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        const failed = {
          ...rec,
          outcome: "error" as const,
          error: err,
          verifiedAt: settleNow,
        };
        working = working.map((r) => (r.key === key ? failed : r));
        persistStats(working);
        touched.push(failed);
        onUpdate?.(summarizeAlertWinRate(working));
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    void pushAlertStatsToServer(touched);
    return summary();
  });
}

/** 核实所有已到期的 pending 信号；串行避免打爆币安 */
export async function verifyDueAlertStats(
  onUpdate?: (summary: AlertWinRateSummary) => void,
): Promise<AlertWinRateSummary> {
  const summary = () => summarizeAlertWinRate(loadAlertStats());
  const list = loadAlertStats();
  const now = Date.now();
  const due = list.filter((r) => r.outcome === "pending" && now >= r.verifyAt);
  if (!due.length) return summary();

  return withVerifyLock(async () => {
    // 排队后重新取，避免与重拉打架
    let working = loadAlertStats();
    const dueNow = Date.now();
    const stillDue = working.filter(
      (r) => r.outcome === "pending" && dueNow >= r.verifyAt,
    );
    const touched: AlertStatsRecord[] = [];
    for (const rec of stillDue) {
      try {
        const { bars, resolvedSymbol } = await fetchBarsForRecord(rec);
        const withSym =
          resolvedSymbol && resolvedSymbol !== rec.tradeSymbol
            ? { ...rec, tradeSymbol: resolvedSymbol }
            : rec;
        const settled = settleAlertByKlines(withSym, bars, dueNow);
        working = working.map((r) => (r.key === rec.key ? settled : r));
        persistStats(working);
        touched.push(settled);
        onUpdate?.(summarizeAlertWinRate(working));
      } catch (e) {
        const err = e instanceof Error ? e.message : String(e);
        const failed = {
          ...rec,
          outcome: "error" as const,
          error: err,
          verifiedAt: dueNow,
        };
        working = working.map((r) => (r.key === rec.key ? failed : r));
        persistStats(working);
        touched.push(failed);
        onUpdate?.(summarizeAlertWinRate(working));
      }
      await new Promise((r) => setTimeout(r, 200));
    }
    void pushAlertStatsToServer(touched);
    return summary();
  });
}

export function outcomeLabel(o: AlertOutcome): string {
  switch (o) {
    case "take_profit":
      return "胜";
    case "stop_loss":
      return "负";
    case "flat":
      return "平";
    case "pending":
      return "待核";
    default:
      return "—";
  }
}

/** BTC/ETH/SOL 100x，其余山寨 20x（对齐卡片清算） */
/** 胜率摘要里的合计盈亏文案：合计 +123.4% */
export function formatAlertTotalPnlPct(totalPnlPct: number | null | undefined): string {
  if (totalPnlPct == null || !Number.isFinite(totalPnlPct)) return "";
  const sign = totalPnlPct > 0 ? "+" : "";
  return `合计 ${sign}${totalPnlPct.toFixed(1)}%`;
}

export function alertStatsLeverage(rec: AlertStatsRecord): number {
  return resolveAlertLeverage(rec.symbol);
}

/**
 * 回溯盈亏（杠杆保证金 %）：有 movePct 时 = 价格变动% × 杠杆。
 * pending / flat / error 无有效盈亏时返回 null。
 */
export function alertStatsPnlPct(rec: AlertStatsRecord): number | null {
  if (rec.outcome === "pending" || rec.outcome === "error") return null;
  if (rec.movePct == null || !Number.isFinite(rec.movePct)) return null;
  const priceMove = Number(rec.movePct);
  const signed =
    rec.outcome === "stop_loss"
      ? -Math.abs(priceMove)
      : rec.outcome === "take_profit"
        ? Math.abs(priceMove)
        : priceMove;
  return Math.round(signed * alertStatsLeverage(rec) * 100) / 100;
}

/** 悬停：该盈亏对应的实际结算价（及盈利时的最大浮盈价） */
export function alertStatsPnlHover(rec: AlertStatsRecord): string {
  if (rec.outcome === "error") return rec.error || "核实失败";
  if (rec.outcome === "pending") return "";
  const lines: string[] = [];
  if (rec.exitPrice != null && Number.isFinite(rec.exitPrice)) {
    lines.push(`结算价 ${rec.exitPrice}`);
  }
  if (
    rec.outcome === "take_profit" &&
    rec.maxProfitPrice != null &&
    Number.isFinite(rec.maxProfitPrice) &&
    rec.maxProfitPct != null &&
    rec.maxProfitPct > 0
  ) {
    const sameAsExit =
      rec.exitPrice != null &&
      Math.abs(rec.maxProfitPrice - rec.exitPrice) / Math.max(rec.exitPrice, 1e-12) < 1e-6;
    if (!sameAsExit) {
      lines.push(`最大盈利价 ${rec.maxProfitPrice}`);
      lines.push(`最大盈利 +${rec.maxProfitPct.toFixed(1)}%`);
    }
  }
  return lines.join("\n");
}

export type AlertStatsTimeFilter = "2h" | "4h" | "8h" | "24h" | "3d" | "7d" | "14d" | "30d" | "1m" | "2m" | "3m" | "all";

/** 固定周期下拉集合（与后端 FIXED_INTERVALS 保持一致） */
export const FIXED_INTERVALS: string[] = ["15m", "1h", "4h"];

/**
 * 周期下拉：固定集合 + 覆盖 backend 实际统计（有数据时用 backend，无数据时只显示 label）。
 * intervalOptions 来自 backend，格式同 typeOptions。
 */
export function mergeIntervalOptions(
  raw: AlertStatsIntervalOption[],
  pageItems: AlertStatsRecord[],
): AlertStatsIntervalOption[] {
  const byLabel = new Map<string, AlertStatsIntervalOption>();
  for (const o of raw) {
    if (o && typeof o.label === "string") {
      byLabel.set(o.label, o);
    }
  }
  const result: AlertStatsIntervalOption[] = [];
  for (const label of FIXED_INTERVALS) {
    const fromBackend = byLabel.get(label);
    if (fromBackend) {
      result.push(fromBackend);
    } else {
      // 无数据时仍显示选项，但 count=0
      result.push({ label, count: 0, winRate: null, totalPnlPct: null });
    }
  }
  return result;
}

const TIME_FILTER_MS: Record<AlertStatsTimeFilter, number> = {
  "all": Infinity,
  "2h": 2 * 60 * 60_000,
  "4h": 4 * 60 * 60_000,
  "8h": 8 * 60 * 60_000,
  "24h": 24 * 60 * 60_000,
  "3d": 3 * 24 * 60 * 60_000,
  "7d": 7 * 24 * 60 * 60_000,
  "14d": 14 * 24 * 60 * 60_000,
  "30d": 30 * 24 * 60 * 60_000,
  "1m": 1 * 30 * 24 * 60 * 60_000,
  "2m": 2 * 30 * 24 * 60 * 60_000,
  "3m": 3 * 30 * 24 * 60 * 60_000,
};

export function filterAlertStatsByTime(
  records: AlertStatsRecord[],
  filter: AlertStatsTimeFilter | "all",
  now = Date.now(),
): AlertStatsRecord[] {
  if (filter === "all") return records.slice().sort((a, b) => b.signalAt - a.signalAt);
  const cutoff = now - (TIME_FILTER_MS[filter] ?? TIME_FILTER_MS["24h"]);
  return records
    .filter((r) => r.signalAt >= cutoff)
    .sort((a, b) => b.signalAt - a.signalAt);
}

/** 类型下拉选项：按出现次数排序；附胜率与合计盈亏 */
export function listAlertStatsTypeOptions(records: AlertStatsRecord[]): AlertStatsTypeOption[] {
  const groups = new Map<string, AlertStatsRecord[]>();
  for (const r of records) {
    const label =
      String(r.typeLabel || "").trim() ||
      resolveAlertTypeLabel(null, r.key, "") ||
      "未标注";
    const arr = groups.get(label) || [];
    arr.push(r);
    groups.set(label, arr);
  }
  return [...groups.entries()]
    .sort((a, b) => b[1].length - a[1].length || a[0].localeCompare(b[0], "zh-CN"))
    .map(([label, rows]) => {
      const s = summarizeAlertWinRate(rows);
      return {
        label,
        count: rows.length,
        wins: s.wins,
        losses: s.losses,
        winRate: s.winRate,
        totalPnlPct: s.totalPnlPct,
      };
    });
}

/** @deprecated 用 listAlertStatsTypeOptions */
export function listAlertStatsTypeLabels(records: AlertStatsRecord[]): string[] {
  return listAlertStatsTypeOptions(records).map((o) => o.label);
}

export function filterAlertStatsByType(
  records: AlertStatsRecord[],
  typeLabel: string | "all",
): AlertStatsRecord[] {
  if (!typeLabel || typeLabel === "all") return records;
  return records.filter((r) => {
    const label =
      String(r.typeLabel || "").trim() ||
      resolveAlertTypeLabel(null, r.key, "") ||
      "未标注";
    return label === typeLabel;
  });
}

export function formatAlertStatsTime(ms: number): string {
  return new Date(ms).toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}
