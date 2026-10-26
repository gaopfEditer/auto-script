import type {
  FlowWindowSnapshot,
  OiByTf,
  OiTimeframe,
  PriceByTf,
  RankDomain,
  RankMetricSnapshot,
  TickerRow,
} from "../types";

export const TIMEFRAMES: OiTimeframe[] = ["5m", "15m", "30m", "1h", "4h", "1d"];

const EMPTY_FLOW = { net_usd: 0, volume_usd: 0 };
const EMPTY_PRICE = { pct: 0 };
const EMPTY_RANK: RankMetricSnapshot = {
  magnitude_usd: 0,
  change_rate: 0,
  z_score: 0,
  intensity_score: 0,
};

export function getOiWindow(row: TickerRow, tf: OiTimeframe): { delta_usd: number; pct: number } {
  const fromMap = row.oi_by_tf?.[tf];
  const raw = fromMap
    ? fromMap
    : tf === "15m"
      ? { delta_usd: row.delta_15m_usd ?? 0, pct: row.pct_15m ?? 0 }
      : { delta_usd: row.delta_5m_usd ?? 0, pct: row.pct_5m ?? 0 };

  // 前端兜底：屏蔽历史脏点导致的荒谬 OI 差分（与后端短窗上限对齐）
  const maxPct = tf === "5m" ? 25 : tf === "15m" ? 40 : 80;
  if (!Number.isFinite(raw.pct) || Math.abs(raw.pct) > maxPct) {
    return { delta_usd: 0, pct: 0 };
  }
  const oiUsd = row.current_oi_usd ?? 0;
  if (oiUsd > 0 && Math.abs(raw.delta_usd) > oiUsd * (maxPct / 100)) {
    return { delta_usd: 0, pct: 0 };
  }
  return raw;
}

export function getPriceWindow(row: TickerRow, tf: OiTimeframe): PriceWindowSnapshot {
  const fromMap = row.price_by_tf?.[tf];
  if (fromMap != null && Number.isFinite(fromMap.pct)) return fromMap;
  if (tf === "5m") return { pct: row.pct_price_5m ?? 0 };
  if (tf === "15m") return { pct: row.pct_price_15m ?? 0 };
  return EMPTY_PRICE;
}

export function getFlowWindow(row: TickerRow, tf: OiTimeframe): FlowWindowSnapshot {
  return row.flow_by_tf?.[tf] ?? EMPTY_FLOW;
}

export function getSpotFlowWindow(row: TickerRow, tf: OiTimeframe): FlowWindowSnapshot {
  return row.spot_flow_by_tf?.[tf] ?? EMPTY_FLOW;
}

function rankMetricFromWindows(
  row: TickerRow,
  tf: OiTimeframe,
  domain: RankDomain,
): RankMetricSnapshot | null {
  if (domain === "price") {
    const pct = getPriceWindow(row, tf).pct;
    if (!Number.isFinite(pct) || pct === 0) return null;
    const oiUsd = row.current_oi_usd ?? 0;
    return {
      magnitude_usd: Math.abs(pct / 100) * oiUsd,
      change_rate: pct / 100,
      z_score: 0,
      intensity_score: 0,
    };
  }
  if (domain === "oi") {
    const w = getOiWindow(row, tf);
    if (!w.delta_usd && !w.pct) return null;
    return {
      magnitude_usd: Math.abs(w.delta_usd),
      change_rate: w.pct / 100,
      z_score: 0,
      intensity_score: 0,
    };
  }
  if (domain === "contract_flow") {
    const f = getFlowWindow(row, tf);
    if (!f.net_usd && !f.volume_usd) return null;
    const rate = f.volume_usd > 1e-9 ? f.net_usd / f.volume_usd : 0;
    return {
      magnitude_usd: f.net_usd,
      change_rate: rate,
      z_score: 0,
      intensity_score: 0,
    };
  }
  if (domain === "spot_flow") {
    const f = getSpotFlowWindow(row, tf);
    if (!f.net_usd && !f.volume_usd) return null;
    const rate = f.volume_usd > 1e-9 ? f.net_usd / f.volume_usd : 0;
    return {
      magnitude_usd: f.net_usd,
      change_rate: rate,
      z_score: 0,
      intensity_score: 0,
    };
  }
  return null;
}

/** smart.b 榜单字段不可信时，用 price_by_tf / oi_by_tf 真差分覆盖 price/oi 展示 */
export function getRankMetric(
  row: TickerRow,
  tf: OiTimeframe,
  domain: RankDomain,
): RankMetricSnapshot {
  const fromRank = row.rank_by_tf?.[tf]?.[domain];
  const fromWindows = rankMetricFromWindows(row, tf, domain);
  if (row.data_source === "smartb" && fromWindows) {
    return {
      ...fromWindows,
      intensity_score: fromRank?.intensity_score ?? fromWindows.intensity_score,
    };
  }
  if (fromRank && (fromRank.change_rate !== 0 || fromRank.magnitude_usd !== 0)) {
    return fromRank;
  }
  return fromWindows ?? fromRank ?? EMPTY_RANK;
}

/** 强度榜：取 OI % 与价格 % 中绝对值更大者（保留正负号）。 */
export function strengthPct(row: TickerRow, tf: OiTimeframe): number {
  const oiPct = getOiWindow(row, tf).pct;
  const pricePct = getPriceWindow(row, tf).pct;
  return Math.abs(oiPct) >= Math.abs(pricePct) ? oiPct : pricePct;
}

export function strengthMagnitude(row: TickerRow, tf: OiTimeframe): number {
  return Math.abs(strengthPct(row, tf));
}

export function matrixTopLabel(tf: OiTimeframe, top = 7): string {
  return `${tf} OI · Top ${top}`;
}

export function tfSubtitle(tf: OiTimeframe, suffix: string): string {
  return `${tf} ${suffix}`;
}

export function emptyOiByTf(): OiByTf {
  return {
    "5m": { delta_usd: 0, pct: 0 },
    "15m": { delta_usd: 0, pct: 0 },
    "30m": { delta_usd: 0, pct: 0 },
    "1h": { delta_usd: 0, pct: 0 },
    "4h": { delta_usd: 0, pct: 0 },
    "1d": { delta_usd: 0, pct: 0 },
  };
}
