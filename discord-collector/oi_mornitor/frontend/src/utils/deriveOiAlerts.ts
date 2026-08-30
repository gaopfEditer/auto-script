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

/** 与后端 OI_DELTA_MAX_PCT 对齐：超过视为脏数据，不进异动流 */
const OI_DELTA_MAX_PCT = 150;
const DEFAULT_PRICE_SPIKE_5M = 2;
const DEFAULT_PRICE_SPIKE_15M = 3.5;

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
): boolean {
  if (!Number.isFinite(deltaUsd) || !Number.isFinite(pct)) return false;
  if (Math.abs(pct) > OI_DELTA_MAX_PCT) return false;
  if (currentOiUsd > 0 && Math.abs(deltaUsd) > currentOiUsd * (1 + OI_DELTA_MAX_PCT / 100)) {
    return false;
  }
  return true;
}

function windowRank(window: OiAlertWindow): number {
  return window === "15m" ? 2 : 1;
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
export function deriveOiAlerts(
  rows: TickerRow[],
  thresholds: AlertThresholds,
  maxItems = 60,
  scanTs = 0,
): OiAlertItem[] {
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
      if (!isPlausibleOiDelta(w.deltaUsd, w.pct, row.current_oi_usd ?? 0)) continue;

      const rawWins = row.raw_triggered_windows ?? [];
      const trigWins = row.triggered_windows ?? [];
      const inRaw = rawWins.includes(w.window);
      const inTrig = trigWins.includes(w.window);
      const isSuppressed = inRaw && !inTrig;

      const alertTs =
        Number(row.alert_ts) > 0
          ? Number(row.alert_ts)
          : Number(scanTs) > 0
            ? Number(scanTs)
            : 0;

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

    for (const window of ["5m", "15m"] as OiAlertWindow[]) {
      const pct = pricePct(row, window);
      const limit = window === "5m" ? price5 : price15;
      if (!Number.isFinite(pct) || Math.abs(pct) < limit) continue;
      // 过滤极端脏价
      if (Math.abs(pct) > 80) continue;

      items.push({
        id: `price-${row.symbol}-${window}`,
        row,
        kind: "price",
        window,
        deltaUsd: 0,
        pct,
        isPump: pct > 0,
        isSuppressed: false,
        alertTs: Number(scanTs) > 0 ? Number(scanTs) : 0,
        tags: tagsFor(row, "price", maps),
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
