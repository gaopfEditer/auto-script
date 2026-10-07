/**
 * 形态 ticker 信号胜率：V2 三档分批 + Runner（对齐 pattern_settle_profile.py）。
 * - SL：invalid 与 ATR×k、cap% 取更紧 · TP：R 倍数分 Preset
 * - 核实窗按周期×市值梯队 · 15m 步进
 * - 杠杆：BTC/ETH/SOL 100x，其余山寨 20x
 */
import type { ChartAlertEntryFocus, PatternAlert, PatternChartMarker } from "../types";
import { fetchBinanceFuturesKlines } from "./binanceKlines";
import { displaySymbol, humanBaseAsset, isStablecoinSymbol, toUsdtSymbol, priceScaleAlignFactor, alignPriceToReference } from "./symbol";
import type { McapTierOption } from "./mcapTier";
import { buildSettlePlanV2, SETTLE_RULES_SUMMARY_V2 } from "./settleProfileV2";

export type { ChartAlertEntryFocus };

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
  tier: "major" | "altcoin" | "equity" | string;
  /** 市值梯队 t1/t2/t3（结算 tier 独立） */
  mcapTier?: string;
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
  /** 15m 步进核实的上次检查时间（仍为 pending 时写入） */
  lastSettleCheckAt?: number;
  /** telegram_push | telegram_card | equity_pattern */
  source?: string;
  /** crypto | equity（币股独立杠杆/核实窗） */
  assetClass?: "crypto" | "equity" | string;
  /** TG 交易卡片 id（source=telegram_card） */
  cardId?: string;
  channelId?: string;
  /** 15m/1h/4h 多周期共振（服务端 list 页计算） */
  mtfResonance?: AlertMtfResonance;
  /** 综合共振分（服务端 signal_confluence） */
  confluence?: AlertConfluence;
  invalid_level?: number;
  observation_only?: boolean;
  settleProfileId?: string;
  settleRulesVersion?: number;
  slPrice?: number;
  tp1Price?: number;
  tp2Price?: number;
};

export type AlertConfluence = {
  score: number;
  tier: "A" | "B" | "C" | "D";
  family?: string | null;
  combos?: string[];
  actionHint?: string;
  reasons?: string[];
};

export function formatConfluenceBadge(c?: AlertConfluence | null): string {
  if (!c || !Number.isFinite(c.score)) return "—";
  return `${c.tier}·${c.score}`;
}

export function confluenceTitle(c?: AlertConfluence | null): string {
  if (!c) return "";
  const lines = [
    `综合分 ${c.score}（${c.tier} 档）`,
    c.actionHint || "",
    c.combos?.length ? `组合：${c.combos.join(" · ")}` : "",
    c.reasons?.length ? c.reasons.join("\n") : "",
  ].filter(Boolean);
  return lines.join("\n");
}

export type AlertMtfResonance = {
  /** 共振周期数 2 或 3 */
  tiers: number;
  intervals: string[];
  family: string;
  familyLabel: string;
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
  observationExcluded?: number;
};

const STATS_CACHE_KEY = "oi_pattern_alert_stats_v1";
/** 本地缓存软上限（核实/Ticker 用）；完整历史走服务端分页长期保存 */
const LOCAL_STATS_SOFT_MAX = 2000;
/** 弹窗列表每页条数 */
export const ALERT_STATS_PAGE_SIZE = 100;
/** 核实窗口最长 3h */
export const ALERT_VERIFY_DELAY_MS = 3 * 60 * 60_000;
/** 15m 步进核实 */
export const ALERT_VERIFY_INTERVAL_MS = 15 * 60_000;
/** TP1 档位 %（展示 / 兜底） */
export const ALERT_DEFAULT_TP_SL_PCT = 3;
export const ALERT_TP1_PCT = 3;
export const ALERT_TP2_PCT = 7;
export const ALERT_TP_LEVELS = [3, 7, 12, 17] as const;
export const ALERT_BATCH_WEIGHTS = [0.3, 0.3, 0.4] as const;
export const ALERT_SL_PCT = 5;
export const ALERT_RUNNER_TRAIL_PCT = 5;
/** BTC/ETH/SOL 100x；其余 20x（对齐 resolveLiquidationLeverage） */
const LEV_100_BASES = new Set(["BTC", "ETH", "SOL"]);
/** 币股胜率展示杠杆（对齐 OI_EQUITY_STATS_LEVERAGE） */
export const EQUITY_STATS_LEVERAGE = 5;

/** 弹窗头部展示用：核算规则摘要 */
export const ALERT_SETTLE_RULES_SUMMARY =
  `核算规则：BTC/ETH/SOL 100x · 山寨 20x · ${SETTLE_RULES_SUMMARY_V2} · 15m 步进核实 · 未平则按窗口末价结算`;

export function isObservationStatsRecord(rec: AlertStatsRecord): boolean {
  const lab = String(rec.typeLabel || "");
  if (lab.includes("观察")) return true;
  return Boolean(rec.observation_only);
}

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

const BLOCKED_TYPE_LABEL_SUBSTR = [
  "(oi异动)",
  "oi异动",
  "连续上插针",
  "连续下插针",
  "非上轨连续上插针",
  "非下轨连续下插针",
] as const;

const BLOCKED_TYPE_LABEL_EXACT = new Set([
  "射击之星（2）",
  "量价推进·空",
  "量价推进-空",
]);

const LEGACY_BREAKOUT_LABELS = ["带量突破", "形态多头爆发", "多头爆发"];

const RETIRED_ALERT_KEY_PREFIXES = new Set([
  "candle_pattern_oi",
  "oi_anomaly",
  "pattern_bull_continuation",
  "trigger",
  "breakout_trigger",
  "spring_2b",
  "continuous_upper_wick",
  "continuous_lower_wick",
  "continuous_non_upper_wick",
  "continuous_non_lower_wick",
  "curvature_decay",
  "vp_cont_thrust",
]);

const V_PREFIX_TYPE_RE = /^V[\+\-]?/;

function normalizePatternTypeLabel(raw: string): string {
  let s = String(raw || "").trim();
  for (const sep of [" · ", "·", "|", "｜"]) {
    if (s.includes(sep)) {
      s = s.split(sep, 1)[0]?.trim() || s;
      break;
    }
  }
  return s;
}

/** 与后端 signal_policy.is_blocked_card_type_label 对齐 */
export function isRetiredPatternTypeLabel(label?: string | null): boolean {
  const raw = String(label || "").trim();
  if (!raw) return false;
  if (raw === "破底翻确认") return true;
  if (BLOCKED_TYPE_LABEL_EXACT.has(raw)) return true;
  const lab = normalizePatternTypeLabel(raw);
  if (!lab) return false;
  if (lab === "破底翻确认") return true;
  if (BLOCKED_TYPE_LABEL_EXACT.has(lab)) return true;
  if (BLOCKED_TYPE_LABEL_SUBSTR.some((x) => lab.includes(x))) return true;
  if (lab.includes("（2）")) return true;
  if (V_PREFIX_TYPE_RE.test(lab)) return true;
  if (lab.includes("连续") && lab.includes("插针")) return true;
  if (LEGACY_BREAKOUT_LABELS.some((x) => lab.includes(x))) return true;
  return false;
}

function sideFromAlertLike(
  side?: string,
  dir?: string,
): "long" | "short" | undefined {
  const s = String(side || "").toLowerCase();
  if (s === "short" || s === "bear") return "short";
  if (s === "long" || s === "bull") return "long";
  if (dir === "空") return "short";
  if (dir === "多") return "long";
  return undefined;
}

/** 胜率库 / 列表中应剔除的记录（停推类型 + 停用周期 + legacy） */
export function isRetiredPatternRecord(rec: Pick<
  AlertStatsRecord,
  "key" | "typeLabel" | "interval" | "side" | "dir" | "symbol" | "signalAt" | "entry"
>): boolean {
  if (isRetiredPatternInterval(rec.interval)) return true;
  const label =
    String(rec.typeLabel || "").trim() ||
    resolveAlertTypeLabel(null, rec.key || "", "") ||
    "";
  if (isRetiredPatternTypeLabel(label)) return true;
  const key = rec.key || "";
  if (key.startsWith("pattern_bull_continuation:") || key.startsWith("trigger:")) {
    return true;
  }
  const prefix = key.split(":")[0]?.toLowerCase() || "";
  if (RETIRED_ALERT_KEY_PREFIXES.has(prefix)) {
    if (prefix === "vp_cont_thrust") {
      return sideFromAlertLike(rec.side, rec.dir) === "short";
    }
    return true;
  }
  return false;
}

export function isRetiredPatternAlert(alert: Partial<PatternAlert>, key = ""): boolean {
  const k =
    key ||
    `${alert.type || ""}:${alert.symbol || ""}:${alert.kline_close_time || ""}:${alert.message || alert.type_label || ""}`;
  return isRetiredPatternRecord({
    key: k,
    typeLabel: resolveAlertTypeLabel(alert, k, ""),
    interval: alert.interval,
    side: sideFromAlertLike(String(alert.side || "")),
    dir: "—",
    symbol: alert.symbol || "",
    signalAt: 0,
    entry: 0,
  });
}

function detectTier(symbol: string): "major" | "altcoin" {
  const bare = humanBaseAsset(symbol);
  return LEV_100_BASES.has(bare) ? "major" : "altcoin";
}

/** 卡片清算杠杆：主流 100 / 山寨 20；币股默认 5x */
export function resolveAlertLeverage(
  symbol: string,
  assetClass?: string,
): number {
  if (String(assetClass || "").toLowerCase() === "equity") {
    return EQUITY_STATS_LEVERAGE > 0 ? EQUITY_STATS_LEVERAGE : 1;
  }
  return LEV_100_BASES.has(humanBaseAsset(symbol)) ? 100 : 20;
}

export function resolveRecordAssetClass(rec: Pick<AlertStatsRecord, "assetClass" | "source" | "tier">): "crypto" | "equity" {
  const ac = String(rec.assetClass || "").toLowerCase();
  if (ac === "equity") return "equity";
  if (rec.tier === "equity" || rec.source === "equity_pattern") return "equity";
  return "crypto";
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
    .filter((r) => !isRetiredPatternRecord(r))
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

/** 北京时间 4h 时段（与结算摘要档对齐） */
export type AlertStatsSessionFilter =
  | "all"
  | "0-4"
  | "4-8"
  | "8-12"
  | "12-16"
  | "16-20"
  | "20-24";

export type AlertStatsSessionOption = AlertStatsTypeOption & {
  id: AlertStatsSessionFilter;
};

/** 北京时间工作日 / 周末 */
export type AlertStatsDaytypeFilter = "all" | "weekday" | "weekend";

export type AlertStatsDaytypeOption = AlertStatsTypeOption & {
  id: AlertStatsDaytypeFilter;
};

export type AlertStatsPageResult = {
  items: AlertStatsRecord[];
  total: number;
  page: number;
  pageSize: number;
  pages: number;
  summary: AlertWinRateSummary;
  typeOptions: AlertStatsTypeOption[];
  intervalOptions: AlertStatsIntervalOption[];
  sessionOptions: AlertStatsSessionOption[];
  daytypeOptions: AlertStatsDaytypeOption[];
  mcapTierOptions?: McapTierOption[];
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
export type AlertStatsAssetFilter = "all" | "crypto" | "equity";

export const ALERT_STATS_DAYTYPE_FILTERS: {
  id: AlertStatsDaytypeFilter;
  label: string;
}[] = [
  { id: "all", label: "全部日期" },
  { id: "weekday", label: "工作日" },
  { id: "weekend", label: "周末" },
];

export function beijingWeekday(signalAtMs: number): number {
  const d = new Date(signalAtMs + 8 * 3_600_000);
  return d.getUTCDay() === 0 ? 6 : d.getUTCDay() - 1;
}

export function signalMatchesDaytype(
  signalAtMs: number,
  daytype: AlertStatsDaytypeFilter,
): boolean {
  if (daytype === "all") return true;
  const wd = beijingWeekday(signalAtMs);
  if (daytype === "weekend") return wd >= 5;
  if (daytype === "weekday") return wd < 5;
  return true;
}

export const ALERT_STATS_SESSION_FILTERS: {
  id: AlertStatsSessionFilter;
  label: string;
}[] = [
  { id: "all", label: "全部时段" },
  { id: "8-12", label: "8:00-12:00" },
  { id: "12-16", label: "12:00-16:00" },
  { id: "16-20", label: "16:00-20:00" },
  { id: "20-24", label: "20:00-24:00" },
  { id: "0-4", label: "00:00-4:00" },
  { id: "4-8", label: "4:00-8:00" },
];

export function beijingHour(signalAtMs: number): number {
  const d = new Date(signalAtMs + 8 * 3_600_000);
  return d.getUTCHours();
}

export function signalInBeijingSession(
  signalAtMs: number,
  session: AlertStatsSessionFilter,
): boolean {
  if (session === "all") return true;
  const hour = beijingHour(signalAtMs);
  const [startRaw, endRaw] = session.split("-");
  const start = Number(startRaw);
  const end = Number(endRaw);
  if (!Number.isFinite(start) || !Number.isFinite(end)) return true;
  if (end >= 24) return hour >= start;
  return hour >= start && hour < end;
}

export async function fetchAlertStatsPage(opts: {
  page?: number;
  pageSize?: number;
  timeFilter?: AlertStatsTimeFilter;
  sessionFilter?: AlertStatsSessionFilter;
  daytypeFilter?: AlertStatsDaytypeFilter;
  typeFilter?: string;
  intervalFilter?: string;
  symbol?: string;
  assetClassFilter?: AlertStatsAssetFilter;
  mtfResonanceOnly?: boolean;
  /** 与结构回测同源：A / B（及以上）/ C / D（仅 D）/ all */
  confluenceMinTier?: string;
  mcapTierFilter?: string;
}): Promise<AlertStatsPageResult> {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(100, Math.max(1, opts.pageSize ?? ALERT_STATS_PAGE_SIZE));
  const timeFilter = opts.timeFilter ?? "all";
  const sessionFilter = opts.sessionFilter ?? "all";
  const daytypeFilter = opts.daytypeFilter ?? "all";
  const typeFilter = opts.typeFilter && opts.typeFilter !== "all" ? opts.typeFilter : "all";
  const intervalFilter = opts.intervalFilter && opts.intervalFilter !== "all" ? opts.intervalFilter : "all";
  const symbol = String(opts.symbol || "").trim();
  const assetClassFilter = opts.assetClassFilter ?? "all";
  const params = new URLSearchParams({
    page: String(page),
    pageSize: String(pageSize),
    time: timeFilter === "all" ? "all" : timeFilter,
    session: sessionFilter === "all" ? "all" : sessionFilter,
    daytype: daytypeFilter === "all" ? "all" : daytypeFilter,
    type: typeFilter,
    interval: intervalFilter,
    assetClass: assetClassFilter,
  });
  if (symbol) params.set("symbol", symbol);
  if (opts.mtfResonanceOnly) params.set("mtfResonance", "1");
  const confTier = String(opts.confluenceMinTier || "all").trim() || "all";
  if (confTier !== "all") params.set("confluenceTier", confTier);
  const mcapF = String(opts.mcapTierFilter || "all").trim() || "all";
  if (mcapF !== "all") params.set("mcapTier", mcapF);
  const empty: AlertStatsPageResult = {
    items: [],
    total: 0,
    page: 1,
    pageSize,
    pages: 1,
    summary: summarizeAlertWinRate([]),
    typeOptions: [],
    intervalOptions: [],
    sessionOptions: mergeSessionOptions([]),
    daytypeOptions: mergeDaytypeOptions([]),
    mcapTierOptions: [],
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
      sessionOptions?: AlertStatsSessionOption[];
      daytypeOptions?: AlertStatsDaytypeOption[];
      mcapTierOptions?: McapTierOption[];
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
    const sessionOptions = mergeSessionOptions(
      normalizeSessionOptions(body.sessionOptions),
    );
    const daytypeOptions = mergeDaytypeOptions(
      normalizeDaytypeOptions(body.daytypeOptions),
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
      sessionOptions,
      daytypeOptions,
      mcapTierOptions: Array.isArray(body.mcapTierOptions) ? body.mcapTierOptions : [],
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
      .filter((o) => !isRetiredPatternTypeLabel(o.label))
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
    return rawLabels
      .filter((label) => !isRetiredPatternTypeLabel(String(label)))
      .map((label) => ({
        label: String(label),
        count: 0,
        winRate: null,
        totalPnlPct: null,
      }));
  }
  return listAlertStatsTypeOptions(pageItems);
}

function normalizeSessionOptions(
  rawOpts: AlertStatsSessionOption[] | undefined,
): AlertStatsSessionOption[] {
  if (!Array.isArray(rawOpts) || !rawOpts.length) return [];
  return rawOpts
    .filter((o) => o && typeof o.id === "string")
    .map((o) => ({
      id: o.id as AlertStatsSessionFilter,
      label: String(o.label || ALERT_STATS_SESSION_FILTERS.find((f) => f.id === o.id)?.label || o.id),
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

/** 时段下拉：固定顺序 + 后端联动统计 */
export function mergeSessionOptions(
  raw: AlertStatsSessionOption[],
): AlertStatsSessionOption[] {
  const byId = new Map(raw.map((o) => [o.id, o]));
  return ALERT_STATS_SESSION_FILTERS.map(({ id, label }) => {
    const fromBackend = byId.get(id);
    if (fromBackend) return fromBackend;
    return {
      id,
      label,
      count: 0,
      winRate: null,
      totalPnlPct: null,
    };
  });
}

function normalizeDaytypeOptions(
  rawOpts: AlertStatsDaytypeOption[] | undefined,
): AlertStatsDaytypeOption[] {
  if (!Array.isArray(rawOpts) || !rawOpts.length) return [];
  return rawOpts
    .filter((o) => o && typeof o.id === "string")
    .map((o) => ({
      id: o.id as AlertStatsDaytypeFilter,
      label: String(
        o.label || ALERT_STATS_DAYTYPE_FILTERS.find((f) => f.id === o.id)?.label || o.id,
      ),
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

/** 工作日/周末下拉：固定顺序 + 后端联动统计 */
export function mergeDaytypeOptions(
  raw: AlertStatsDaytypeOption[],
): AlertStatsDaytypeOption[] {
  const byId = new Map(raw.map((o) => [o.id, o]));
  return ALERT_STATS_DAYTYPE_FILTERS.map(({ id, label }) => {
    const fromBackend = byId.get(id);
    if (fromBackend) return fromBackend;
    return {
      id,
      label,
      count: 0,
      winRate: null,
      totalPnlPct: null,
    };
  });
}

/** 时段下拉展示文案：名称 · 胜率 · 合计盈亏 */
export function formatSessionOptionLabel(opt: AlertStatsSessionOption): string {
  return formatAlertTypeOptionLabel(opt);
}

/** 工作日/周末下拉展示文案 */
export function formatDaytypeOptionLabel(opt: AlertStatsDaytypeOption): string {
  return formatAlertTypeOptionLabel(opt);
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
    if (isRetiredPatternInterval(iv)) continue;
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
      .filter((o) => !isRetiredPatternInterval(o.label))
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
  return listAlertStatsIntervalOptions(_pageItems);
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

/** 服务端全库 V2 重算（operator；可能耗时数分钟） */
export async function recalculateAllSettlementsV2(limit?: number): Promise<{
  ok: boolean;
  updated?: number;
  processed?: number;
  summary?: AlertWinRateSummary;
  error?: string;
}> {
  try {
    const res = await fetch("/api/pattern-alert-stats/recalculate-v2", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(limit != null ? { limit } : {}),
    });
    const body = (await res.json()) as Record<string, unknown>;
    if (!res.ok || !body.ok) {
      return { ok: false, error: String(body.error || res.statusText) };
    }
    const s = body.summary as Record<string, unknown> | undefined;
    const summary: AlertWinRateSummary | undefined = s
      ? {
          total: Number(s.total) || 0,
          pending: Number(s.pending) || 0,
          wins: Number(s.wins) || 0,
          losses: Number(s.losses) || 0,
          flats: Number(s.flats) || 0,
          errors: Number(s.errors) || 0,
          winRate:
            s.winRate == null || !Number.isFinite(Number(s.winRate))
              ? null
              : Number(s.winRate),
          totalPnlPct:
            s.totalPnlPct == null || !Number.isFinite(Number(s.totalPnlPct))
              ? null
              : Number(s.totalPnlPct),
          observationExcluded:
            s.observationExcluded != null ? Number(s.observationExcluded) : undefined,
        }
      : undefined;
    return {
      ok: true,
      updated: Number(body.updated) || 0,
      processed: Number(body.processed) || 0,
      summary,
    };
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
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
  let obsExcluded = 0;
  const rows = records.filter((r) => {
    if (isObservationStatsRecord(r)) {
      obsExcluded++;
      return false;
    }
    return true;
  });
  let pending = 0;
  let wins = 0;
  let losses = 0;
  let flats = 0;
  let errors = 0;
  let totalPnl = 0;
  let pnlN = 0;
  for (const r of rows) {
    if (r.outcome === "pending") pending++;
    else if (r.outcome === "take_profit") wins++;
    else if (r.outcome === "stop_loss") losses++;
    else if (r.outcome === "flat") flats++;
    else errors++;

    // 与 alertStatsPnlPct 同口径；缺 movePct 时用 stepPct（TP1 3%）兜底，避免合计空白
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
        const lev = resolveAlertLeverage(r.symbol, resolveRecordAssetClass(r));
        totalPnl += Math.round(signed * lev * 100) / 100;
        pnlN++;
      }
    }
  }
  const settled = wins + losses;
  return {
    total: rows.length,
    pending,
    wins,
    losses,
    flats,
    errors,
    winRate: settled > 0 ? wins / settled : null,
    totalPnlPct: pnlN > 0 ? Math.round(totalPnl * 100) / 100 : null,
    observationExcluded: obsExcluded > 0 ? obsExcluded : undefined,
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
  if (isRetiredPatternAlert(input.alert, input.key)) return null;
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

function tpPrice(entry: number, pct: number, isShort: boolean): number {
  const step = pct / 100;
  return isShort ? entry * (1 - step) : entry * (1 + step);
}

function slPrice(entry: number, pct: number, isShort: boolean): number {
  const step = pct / 100;
  return isShort ? entry * (1 + step) : entry * (1 - step);
}

/** 5m → 15m 聚合（回测/旧缓存兼容） */
function aggregateTo15m(bars: Bar[]): Bar[] {
  if (bars.length < 2) return bars;
  const deltas = bars.slice(0, Math.min(8, bars.length - 1)).map((b, i) => bars[i + 1]!.ts - b.ts);
  const med = [...deltas].sort((a, b) => a - b)[Math.floor(deltas.length / 2)] ?? 0;
  if (med >= 14 * 60_000) return bars;
  const bucketMs = 15 * 60_000;
  const buckets = new Map<number, Bar>();
  for (const b of bars) {
    const key = Math.floor(b.ts / bucketMs);
    const cur = buckets.get(key);
    if (!cur) {
      buckets.set(key, { ts: key * bucketMs, high: b.high, low: b.low, close: b.close });
    } else {
      cur.high = Math.max(cur.high, b.high);
      cur.low = Math.min(cur.low, b.low);
      cur.close = b.close;
    }
  }
  return [...buckets.keys()].sort((a, b) => a - b).map((k) => buckets.get(k)!);
}

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
 * 三档分批 + Runner 跟踪止盈（对齐 pattern_settle.py）。
 * movePct = 各档加权价格变动 %；同时记录窗内最大浮盈。
 */
export function settleAlertByKlines(
  rec: AlertStatsRecord,
  bars: Bar[],
  now = Date.now(),
): AlertStatsRecord {
  if (isRetiredPatternInterval(rec.interval)) {
    return retireDisabledIntervalRecord(rec);
  }
  const isShort = rec.side === "short";
  const entry = rec.entry;
  const plan = buildSettlePlanV2(rec);
  const verifyAt = rec.verifyAt > 0 ? rec.verifyAt : rec.signalAt + plan.verifyDelayMs;
  const tp1 = rec.tp1Price ?? plan.tp1Price;
  const tp2 = rec.tp2Price ?? plan.tp2Price;
  const sl = rec.slPrice ?? plan.slPrice;
  const stepPct =
    entry > 0
      ? Math.round(plan.tp1R * (plan.riskR / entry) * 10000) / 100
      : rec.stepPct > 0
        ? rec.stepPct
        : ALERT_TP1_PCT;
  const windowEnd = Math.min(now, verifyAt);
  const aligned = aggregateTo15m(alignBarsToEntry(bars, entry));
  const sorted = [...aligned]
    .filter((b) => b.ts >= rec.signalAt - 1 && b.ts <= windowEnd + 60_000)
    .sort((a, b) => a.ts - b.ts);

  const rem = [...plan.batchWeights];
  let weightedMove = 0;
  let runnerActive = false;
  let extreme = entry;
  let runnerStop: number | null = null;
  let exitPrice = entry;
  let hitAt: number | undefined;
  const runnerTrailPct = plan.runnerTrailPct;

  const finish = (
    partial: Partial<AlertStatsRecord> & { hitAt?: number },
  ): AlertStatsRecord => {
    const until = partial.hitAt ?? sorted[sorted.length - 1]?.ts ?? windowEnd;
    const max = trackMaxProfit(rec, isShort, sorted, until);
    return {
      ...rec,
      tier: detectTier(rec.symbol),
      stepPct,
      verifyAt,
      settleProfileId: plan.profileId,
      settleRulesVersion: 2,
      slPrice: sl,
      tp1Price: tp1,
      tp2Price: tp2,
      ...partial,
      ...max,
      verifiedAt: now,
    };
  };

  for (const bar of sorted) {
    const remaining = rem[0]! + rem[1]! + rem[2]!;
    if (remaining <= 1e-9) break;

    const slHit = isShort ? bar.high >= sl : bar.low <= sl;
    if (slHit) {
      const move = priceMovePct(entry, sl, isShort);
      weightedMove += move * remaining;
      rem[0] = rem[1] = rem[2] = 0;
      exitPrice = sl;
      hitAt = bar.ts;
      break;
    }

    if (rem[0]! > 0) {
      const hit = isShort ? bar.low <= tp1 : bar.high >= tp1;
      if (hit) {
        weightedMove += priceMovePct(entry, tp1, isShort) * rem[0]!;
        rem[0] = 0;
      }
    }

    if (rem[1]! > 0) {
      const hit = isShort ? bar.low <= tp2 : bar.high >= tp2;
      if (hit) {
        weightedMove += priceMovePct(entry, tp2, isShort) * rem[1]!;
        rem[1] = 0;
        runnerActive = true;
      }
    }

    if (rem[2]! > 0) {
      if (!runnerActive) {
        const act = isShort ? bar.low <= tp2 : bar.high >= tp2;
        if (act) runnerActive = true;
      }
      if (runnerActive) {
        if (isShort) {
          extreme = Math.min(extreme, bar.low);
          const newStop = extreme * (1 + runnerTrailPct / 100);
          runnerStop = runnerStop == null ? newStop : Math.min(runnerStop, newStop);
          if (bar.high >= runnerStop) {
            weightedMove += priceMovePct(entry, runnerStop, isShort) * rem[2]!;
            rem[2] = 0;
            exitPrice = runnerStop;
            hitAt = bar.ts;
          }
        } else {
          extreme = Math.max(extreme, bar.high);
          const newStop = extreme * (1 - runnerTrailPct / 100);
          runnerStop = runnerStop == null ? newStop : Math.max(runnerStop, newStop);
          if (bar.low <= runnerStop) {
            weightedMove += priceMovePct(entry, runnerStop, isShort) * rem[2]!;
            rem[2] = 0;
            exitPrice = runnerStop;
            hitAt = bar.ts;
          }
        }
      }
    }
  }

  const remaining = rem[0]! + rem[1]! + rem[2]!;
  if (remaining > 1e-9 && now < verifyAt) return { ...rec, verifyAt };

  if (remaining > 1e-9) {
    const last = sorted[sorted.length - 1];
    if (!last) {
      return { ...rec, outcome: "error", error: "no_klines", verifiedAt: now };
    }
    const move = priceMovePct(entry, last.close, isShort);
    weightedMove += move * remaining;
    exitPrice = last.close;
    hitAt = last.ts;
  }

  if (Math.abs(weightedMove) < 1e-4) {
    return finish({ outcome: "flat", exitPrice, movePct: weightedMove, hitAt });
  }
  return finish({
    outcome: weightedMove > 0 ? "take_profit" : "stop_loss",
    exitPrice,
    movePct: weightedMove,
    hitAt,
  });
}

function isAlertDueForSettleCheck(rec: AlertStatsRecord, now: number): boolean {
  if (rec.outcome !== "pending") return false;
  if (isRetiredPatternInterval(rec.interval)) return false;
  if (now >= rec.verifyAt) return true;
  const age = now - rec.signalAt;
  if (age < ALERT_VERIFY_INTERVAL_MS) return false;
  const last = rec.lastSettleCheckAt || 0;
  if (last && now - last < ALERT_VERIFY_INTERVAL_MS - 5_000) return false;
  return true;
}

async function fetchBarsForRecord(
  rec: AlertStatsRecord,
): Promise<{ bars: Bar[]; resolvedSymbol: string }> {
  const endMs = Math.min(Date.now(), rec.verifyAt) + 5 * 60_000;
  const sym = rec.tradeSymbol || toUsdtSymbol(rec.symbol) || rec.symbol;
  if (isStablecoinSymbol(sym)) {
    throw new Error("稳定币已排除回溯");
  }
  const { candles, resolvedSymbol } = await fetchBinanceFuturesKlines(sym, "15m", {
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
      if (isRetiredPatternInterval(rec.interval)) {
        const retired = retireDisabledIntervalRecord(rec);
        working = working.map((r) => (r.key === key ? retired : r));
        persistStats(working);
        touched.push(retired);
        onUpdate?.(summarizeAlertWinRate(working));
        continue;
      }
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

/** 核实 pending 信号：每 15m 步进；满 3h 或全平则落最终结果 */
export async function verifyDueAlertStats(
  onUpdate?: (summary: AlertWinRateSummary) => void,
): Promise<AlertWinRateSummary> {
  const summary = () => summarizeAlertWinRate(loadAlertStats());
  let list = loadAlertStats();
  const now = Date.now();
  const retired = list.filter(
    (r) => r.outcome === "pending" && isRetiredPatternInterval(r.interval),
  );
  if (retired.length) {
    list = list.map((r) =>
      r.outcome === "pending" && isRetiredPatternInterval(r.interval)
        ? retireDisabledIntervalRecord(r)
        : r,
    );
    persistStats(list);
    void pushAlertStatsToServer(retired.map(retireDisabledIntervalRecord));
    onUpdate?.(summarizeAlertWinRate(list));
  }
  const due = list.filter((r) => isAlertDueForSettleCheck(r, now));
  if (!due.length) return summary();

  return withVerifyLock(async () => {
    // 排队后重新取，避免与重拉打架
    let working = loadAlertStats();
    const dueNow = Date.now();
    const stillDue = working.filter((r) => isAlertDueForSettleCheck(r, dueNow));
    const touched: AlertStatsRecord[] = [];
    for (const rec of stillDue) {
      if (isRetiredPatternInterval(rec.interval)) {
        const retired = retireDisabledIntervalRecord(rec);
        working = working.map((r) => (r.key === rec.key ? retired : r));
        persistStats(working);
        touched.push(retired);
        onUpdate?.(summarizeAlertWinRate(working));
        continue;
      }
      try {
        const { bars, resolvedSymbol } = await fetchBarsForRecord(rec);
        const withSym =
          resolvedSymbol && resolvedSymbol !== rec.tradeSymbol
            ? { ...rec, tradeSymbol: resolvedSymbol }
            : rec;
        let settled = settleAlertByKlines(withSym, bars, dueNow);
        if (settled.outcome === "pending") {
          settled = { ...settled, lastSettleCheckAt: dueNow };
        }
        working = working.map((r) => (r.key === rec.key ? settled : r));
        persistStats(working);
        if (settled.outcome !== "pending") touched.push(settled);
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
  return resolveAlertLeverage(rec.symbol, resolveRecordAssetClass(rec));
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

/** 形态信号列表已停用周期（不入库/不结算） */
export const RETIRED_PATTERN_INTERVALS = new Set(["30m", "30min"]);

export function isRetiredPatternInterval(interval?: string | null): boolean {
  const iv = String(interval || "").trim().toLowerCase();
  return RETIRED_PATTERN_INTERVALS.has(iv);
}

/** 历史 30m pending 标记为已忽略，不再拉 K 线核实 */
export function retireDisabledIntervalRecord(rec: AlertStatsRecord): AlertStatsRecord {
  return {
    ...rec,
    outcome: "flat",
    movePct: 0,
    error: "30m已停用",
    verifiedAt: Date.now(),
  };
}

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
    if (isRetiredPatternRecord(r)) continue;
    const label =
      String(r.typeLabel || "").trim() ||
      resolveAlertTypeLabel(null, r.key, "") ||
      "未标注";
    if (isRetiredPatternTypeLabel(label)) continue;
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

/** 列表「共振」列展示 */
export function formatMtfResonanceBadge(res?: AlertMtfResonance | null): string {
  if (!res || !Number.isFinite(res.tiers) || res.tiers < 2) return "";
  const ivs = (res.intervals ?? []).join("+") || "—";
  const fam = String(res.familyLabel || res.family || "").trim();
  return `${res.tiers}周期 · ${ivs}${fam ? ` · ${fam}` : ""}`;
}

export function hasMtfResonance(rec: Pick<AlertStatsRecord, "mtfResonance">): boolean {
  const t = rec.mtfResonance?.tiers;
  return typeof t === "number" && t >= 2;
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

export function alertRecordToChartFocus(r: AlertStatsRecord): ChartAlertEntryFocus {
  return {
    key: r.key,
    symbol: r.tradeSymbol || r.symbol,
    interval: r.interval,
    entry: r.entry,
    typeLabel: r.typeLabel,
    signalAt: r.signalAt,
    side: r.side,
    dir: r.dir,
  };
}

function sameAlertSymbol(rec: AlertStatsRecord, symbol: string): boolean {
  const want = humanBaseAsset(symbol);
  if (!want) return false;
  return humanBaseAsset(rec.symbol) === want || humanBaseAsset(rec.tradeSymbol || "") === want;
}

/** 按币种拉胜率库（图表叠加入场点）；客户端再按人类名过滤一层。 */
export async function fetchAlertStatsForSymbol(symbol: string): Promise<AlertStatsRecord[]> {
  const want = String(symbol || "").trim();
  if (!want) return [];
  const items: AlertStatsRecord[] = [];
  let page = 1;
  let pages = 1;
  while (page <= pages && items.length < 400) {
    const chunk = await fetchAlertStatsPage({
      page,
      pageSize: ALERT_STATS_PAGE_SIZE,
      timeFilter: "all",
      typeFilter: "all",
      intervalFilter: "all",
      symbol: want,
    });
    pages = chunk.pages;
    items.push(...chunk.items.filter((r) => sameAlertSymbol(r, want)));
    if (!chunk.items.length) break;
    page += 1;
    if (page > 8) break;
  }
  return items;
}

const MAX_ALERT_CHART_MARKERS = 40;

function alertFocusToMarkerRecord(focus: ChartAlertEntryFocus): AlertStatsRecord {
  return {
    key: focus.key,
    symbol: focus.symbol,
    dir: focus.dir || (focus.side === "short" ? "空" : "多"),
    side: focus.side,
    signalAt: focus.signalAt,
    entry: focus.entry,
    tier: "altcoin",
    stepPct: ALERT_DEFAULT_TP_SL_PCT,
    verifyAt: focus.signalAt,
    outcome: "pending",
    typeLabel: focus.typeLabel,
    interval: focus.interval,
  };
}

function oneAlertEntryMarker(
  rec: AlertStatsRecord,
  focused: boolean,
  refPrice?: number,
): PatternChartMarker | null {
  if (!(rec.entry > 0) || !(rec.signalAt > 0)) return null;
  const isShort = rec.side === "short" || rec.dir === "空";
  const type = String(rec.typeLabel || "").trim() || "信号";
  const iv = String(rec.interval || "").trim();
  const dir = rec.dir === "空" || rec.dir === "多" ? rec.dir : isShort ? "空" : "多";
  const text = focused ? `入${dir} · ${type}` : iv ? `${type} ${iv}` : type;
  const price =
    refPrice && refPrice > 0 ? alignPriceToReference(rec.entry, refPrice) : rec.entry;
  const t = rec.signalAt > 1e12 ? Math.floor(rec.signalAt / 1000) : rec.signalAt;
  return {
    time: t,
    position: isShort ? "aboveBar" : "belowBar",
    color: focused ? (isShort ? "#ff6e40" : "#b8ff3c") : isShort ? "#ef5350" : "#66bb6a",
    shape: isShort ? "arrowDown" : "arrowUp",
    text,
    price,
    kind: focused ? "alert_entry_focus" : "alert_entry",
    size: focused ? 1.25 : 0.85,
  };
}

/** 把胜率列表入场记录转成 K 线标记；聚焦那条始终保留。 */
export function buildAlertEntryMarkers(
  records: AlertStatsRecord[],
  focus?: ChartAlertEntryFocus | null,
  refPrice?: number,
): PatternChartMarker[] {
  const byKey = new Map<string, AlertStatsRecord>();
  for (const r of records) {
    if (r?.key) byKey.set(r.key, r);
  }
  if (focus?.key && !byKey.has(focus.key)) {
    byKey.set(focus.key, alertFocusToMarkerRecord(focus));
  }
  const focusKey = focus?.key;
  const all = [...byKey.values()].sort((a, b) => b.signalAt - a.signalAt);
  const focused = focusKey ? all.filter((r) => r.key === focusKey) : [];
  const rest = all.filter((r) => r.key !== focusKey).slice(0, MAX_ALERT_CHART_MARKERS);
  const out: PatternChartMarker[] = [];
  const seen = new Set<string>();
  for (const r of [...focused, ...rest]) {
    const m = oneAlertEntryMarker(r, r.key === focusKey, refPrice);
    if (!m) continue;
    const k = `${m.time}:${m.kind}:${m.text}`;
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(m);
  }
  return out;
}
