import type { TickerRow } from "../types";

export type OiAlertWindow = "5m" | "15m";
export type OiAlertKind = "oi" | "price";

export interface OiAlertItem {
  id: string;
  row: TickerRow;
  kind: OiAlertKind;
  window: OiAlertWindow;
  deltaUsd: number;
  pct: number;
  isPump: boolean;
  isSuppressed: boolean;
  /** 卡片产生时间（unix 秒） */
  alertTs: number;
  /** 展示用标签，如 涨幅榜 #3 */
  tags: string[];
}

export interface AlertThresholds {
  oi_usd_limit: number;
  oi_pct_limit: number;
  price_spike_pct_5m?: number;
  price_spike_pct_15m?: number;
}

/** 与后端短窗上限对齐：5m/15m 超过即脏数据 */
const OI_DELTA_MAX_PCT_5M = 25;
const OI_DELTA_MAX_PCT_15M = 40;
const DEFAULT_PRICE_SPIKE_5M = 2;
const DEFAULT_PRICE_SPIKE_15M = 3.5;

export function oiDeltaMaxPct(window: OiAlertWindow): number {
  return window === "5m" ? OI_DELTA_MAX_PCT_5M : OI_DELTA_MAX_PCT_15M;
}

export function isPlausibleOiAlert(item: Pick<OiAlertItem, "kind" | "window" | "deltaUsd" | "pct" | "row">): boolean {
  if (item.kind === "oi") {
    return isPlausibleOiDelta(
      item.deltaUsd,
      item.pct,
      item.row?.current_oi_usd ?? 0,
      item.window,
    );
  }
  return isPlausiblePriceAlert(item);
}

/** 短窗「价格暴涨/暴跌」应与 24h 方向/量级大致一致（Binance 脏 tick 过滤） */
export function isPlausiblePriceAlert(
  item: Pick<OiAlertItem, "kind" | "pct" | "row">,
): boolean {
  if (item.kind !== "price") return true;
  const pct = item.pct;
  if (!Number.isFinite(pct) || Math.abs(pct) > 80) return false;
  const p24 = Number(item.row?.price_change_pct_24h);
  if (!Number.isFinite(p24) || Math.abs(p24) < 0.05) return true;
  const abs5 = Math.abs(pct);
  const abs24 = Math.abs(p24);
  if (abs5 >= 8 && abs24 < Math.max(2, abs5 * 0.35)) return false;
  if (abs5 >= 6 && abs24 < abs5 * 0.25) return false;
  if (pct !== 0 && p24 !== 0 && Math.sign(pct) !== Math.sign(p24) && abs24 < 6) return false;
  return true;
}

function isTriggered(
  deltaUsd: number,
  pct: number,
  usdLimit: number,
  pctLimit: number,
): boolean {
  return Math.abs(deltaUsd) >= usdLimit || Math.abs(pct) >= pctLimit;
}

function isPlausibleOiDelta(
  deltaUsd: number,
  pct: number,
  currentOiUsd: number,
  window: OiAlertWindow,
): boolean {
  if (!Number.isFinite(deltaUsd) || !Number.isFinite(pct)) return false;
  const maxPct = oiDeltaMaxPct(window);
  if (Math.abs(pct) > maxPct) return false;
  // |Δ| 不应接近/超过当前全部 OI（5m 翻倍级）
  if (currentOiUsd > 0 && Math.abs(deltaUsd) > currentOiUsd * (maxPct / 100)) {
    return false;
  }
  // Δ 与 pct 应大致同号且同量级
  if (Math.abs(pct) >= 1 && Math.abs(deltaUsd) < 1) return false;
  if (deltaUsd !== 0 && pct !== 0 && Math.sign(deltaUsd) !== Math.sign(pct)) return false;
  return true;
}

function windowRank(window: OiAlertWindow): number {
  return window === "15m" ? 2 : 1;
}

function windowSec(window: OiAlertWindow): number {
  return window === "5m" ? 300 : 900;
}

/** unix 秒（后端偶发毫秒） */
export function normalizeAlertTsSec(raw: number): number {
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
}

/** 5m/15m 测量窗口的 K 线收盘时刻（信号落在该根 K 线内） */
export function alignOiWindowCloseSec(scanSec: number, window: OiAlertWindow): number {
  if (!Number.isFinite(scanSec) || scanSec <= 0) return 0;
  const bucket = windowSec(window);
  return (Math.floor(scanSec / bucket) + 1) * bucket;
}

/**
 * 卡片展示用「信号发生时间」（unix 秒）：
 * - OI：后端 alert_ts（首次触发，冷却内不变），且当前窗口仍在触发/抑制集合内
 * - 价格 / 无 alert_ts：用本轮扫描时刻（前端 merge 首次出现时冻结，不再跟随后续 scan）
 */
export function resolveOiAlertSignalTs(
  row: TickerRow,
  window: OiAlertWindow,
  scanTs: number,
  kind: OiAlertKind = "oi",
): number {
  if (kind === "oi") {
    const ts = normalizeAlertTsSec(Number(row.alert_ts));
    const wins = [...(row.raw_triggered_windows ?? []), ...(row.triggered_windows ?? [])];
    if (ts > 0 && wins.includes(window)) return ts;
  }
  if (kind === "price" && row.data_source === "smartb") {
    return 0;
  }
  if (scanTs > 0) return normalizeAlertTsSec(scanTs);
  return 0;
}

function pricePct(row: TickerRow, window: OiAlertWindow): number {
  if (window === "5m") return Number(row.pct_price_5m) || 0;
  const fromMap = row.price_by_tf?.["15m"]?.pct;
  if (fromMap != null && Number.isFinite(fromMap)) return Number(fromMap);
  return Number(row.pct_price_15m) || 0;
}

/** 涨幅 / OI 增 / 强度 简易榜位（全市场本轮） */
function buildRankMaps(rows: TickerRow[]) {
  const live = rows.filter((r) => r.status !== "warming");
  const byPrice = [...live].sort(
    (a, b) => Math.abs(b.pct_price_5m ?? 0) - Math.abs(a.pct_price_5m ?? 0),
  );
  const byOi = [...live].sort(
    (a, b) => Math.abs(b.delta_5m_usd ?? 0) - Math.abs(a.delta_5m_usd ?? 0),
  );
  const byHeat = [...live].sort(
    (a, b) => (a.global_intensity_rank ?? 9999) - (b.global_intensity_rank ?? 9999),
  );

  /** @type {Map<string, number>} */
  const priceRank = new Map();
  /** @type {Map<string, number>} */
  const oiRank = new Map();
  byPrice.forEach((r, i) => priceRank.set(r.symbol, i + 1));
  byOi.forEach((r, i) => oiRank.set(r.symbol, i + 1));

  return { priceRank, oiRank, byHeat };
}

function tagsFor(
  row: TickerRow,
  kind: OiAlertKind,
  maps: ReturnType<typeof buildRankMaps>,
): string[] {
  const tags: string[] = [];
  const pr = maps.priceRank.get(row.symbol);
  const oi = maps.oiRank.get(row.symbol);
  if (kind === "price" && pr != null && pr <= 30) tags.push(`涨跌幅榜 #${pr}`);
  if (kind === "oi" && oi != null && oi <= 30) tags.push(`持仓变动 #${oi}`);
  if (row.global_intensity_rank != null && row.global_intensity_rank <= 50) {
    tags.push(`全场强度 #${row.global_intensity_rank}`);
  }
  if (row.global_volume_rank != null && row.global_volume_rank <= 50) {
    tags.push(`全场量级 #${row.global_volume_rank}`);
  }
  return tags.slice(0, 3);
}

/**
 * 从全量扫描行派生异动：
 * - OI 暴涨/暴跌（5m / 15m）
 * - 价格暴涨/暴跌（5m / 15m）
 * 不依赖后端 is_hot 轮询门控。
 */
export type RadarSource = "local" | "smartb" | string;

export function deriveOiAlerts(
  rows: TickerRow[],
  thresholds: AlertThresholds,
  maxItems = 60,
  scanTs = 0,
  radarSource: RadarSource = "local",
): OiAlertItem[] {
  const fromSmartb =
    radarSource === "smartb" || rows.some((r) => r.data_source === "smartb");
  const usdLimit = Number(thresholds.oi_usd_limit) || 500_000;
  const pctLimit = Number(thresholds.oi_pct_limit) || 2.5;
  const price5 = Number(thresholds.price_spike_pct_5m) || DEFAULT_PRICE_SPIKE_5M;
  const price15 = Number(thresholds.price_spike_pct_15m) || DEFAULT_PRICE_SPIKE_15M;
  const maps = buildRankMaps(rows);
  const items: OiAlertItem[] = [];

  for (const row of rows) {
    if (row.status === "warming") continue;

    const oiWindows: Array<{ window: OiAlertWindow; deltaUsd: number; pct: number }> = [
      { window: "5m", deltaUsd: row.delta_5m_usd, pct: row.pct_5m },
      { window: "15m", deltaUsd: row.delta_15m_usd, pct: row.pct_15m },
    ];

    for (const w of oiWindows) {
      if (!isTriggered(w.deltaUsd, w.pct, usdLimit, pctLimit)) continue;
      if (!isPlausibleOiDelta(w.deltaUsd, w.pct, row.current_oi_usd ?? 0, w.window)) continue;

      const rawWins = row.raw_triggered_windows ?? [];
      const trigWins = row.triggered_windows ?? [];
      const inRaw = rawWins.includes(w.window);
      const inTrig = trigWins.includes(w.window);
      const isSuppressed = inRaw && !inTrig;

      const alertTs = resolveOiAlertSignalTs(row, w.window, scanTs, "oi");

      items.push({
        id: `oi-${row.symbol}-${w.window}`,
        row,
        kind: "oi",
        window: w.window,
        deltaUsd: w.deltaUsd,
        pct: w.pct,
        isPump: w.deltaUsd > 0,
        isSuppressed,
        alertTs,
        tags: tagsFor(row, "oi", maps),
      });
    }

    // smart.b 行无真实短窗价格差分，整类价格异动跳过
    if (fromSmartb) continue;

    for (const window of ["5m", "15m"] as OiAlertWindow[]) {
      const pct = pricePct(row, window);
      const limit = window === "5m" ? price5 : price15;
      if (!Number.isFinite(pct) || Math.abs(pct) < limit) continue;
      // 过滤极端脏价
      if (Math.abs(pct) > 80) continue;

      const draft: OiAlertItem = {
        id: `price-${row.symbol}-${window}`,
        row,
        kind: "price",
        window,
        deltaUsd: 0,
        pct,
        isPump: pct > 0,
        isSuppressed: false,
        alertTs: resolveOiAlertSignalTs(row, window, scanTs, "price"),
        tags: tagsFor(row, "price", maps),
      };
      if (!isPlausiblePriceAlert(draft)) continue;

      items.push({
        ...draft,
      });
    }
  }

  items.sort((a, b) => {
    const t = (b.alertTs || 0) - (a.alertTs || 0);
    if (t !== 0) return t;
    const mag = Math.abs(b.pct) - Math.abs(a.pct);
    if (mag !== 0) return mag;
    const kindRank = (a.kind === "price" ? 1 : 0) - (b.kind === "price" ? 1 : 0);
    if (kindRank !== 0) return kindRank;
    const win = windowRank(b.window) - windowRank(a.window);
    if (win !== 0) return win;
    return (a.row.global_intensity_rank ?? 999) - (b.row.global_intensity_rank ?? 999);
  });

  // 同币同 kind 只保留最强一条，避免刷屏
  const seen = new Set<string>();
  const deduped: OiAlertItem[] = [];
  for (const item of items) {
    const key = `${item.kind}:${item.row.symbol}`;
    if (seen.has(key)) continue;
    seen.add(key);
    deduped.push(item);
    if (deduped.length >= maxItems) break;
  }
  return deduped;
}
