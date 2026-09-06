import type { RadarSnapshot } from "../types";
import { EMPTY_SNAPSHOT } from "../types";

const CACHE_KEY = "oi_radar_snapshot_v1";
/** 热榜本地缓存时长 */
const CACHE_TTL_MS = 2 * 60 * 60_000;

type RadarCachePayload = {
  savedAt: number;
  snapshot: RadarSnapshot;
};

function hasBoardData(s: RadarSnapshot | null | undefined): boolean {
  if (!s) return false;
  return (
    (s.all_tickers?.length ?? 0) > 0 ||
    (s.hot_tickers?.length ?? 0) > 0 ||
    !!s.market_matrix
  );
}

/** 只持久化热榜相关字段，pattern 体量大且另有页内状态，不强制覆盖 */
function pickBoardSnapshot(s: RadarSnapshot): RadarSnapshot {
  return {
    ...EMPTY_SNAPSHOT,
    scan_ts: s.scan_ts || 0,
    meta: s.meta,
    pool_meta: s.pool_meta,
    hot_tickers: s.hot_tickers ?? [],
    all_tickers: s.all_tickers ?? [],
    market_matrix: s.market_matrix,
    breakout_alerts: s.breakout_alerts ?? [],
    pool_size: s.pool_size || 0,
    thresholds: s.thresholds ?? EMPTY_SNAPSHOT.thresholds,
    // 保留 pattern 以免切回形态页瞬间空白；无则用空壳
    pattern: s.pattern ?? EMPTY_SNAPSHOT.pattern,
  };
}

export function loadRadarSnapshotCache(): RadarSnapshot | null {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as RadarCachePayload;
    if (!parsed?.savedAt || Date.now() - parsed.savedAt > CACHE_TTL_MS) {
      localStorage.removeItem(CACHE_KEY);
      return null;
    }
    if (!hasBoardData(parsed.snapshot)) return null;
    return pickBoardSnapshot(parsed.snapshot);
  } catch {
    return null;
  }
}

export function saveRadarSnapshotCache(snapshot: RadarSnapshot) {
  if (!hasBoardData(snapshot)) return;
  try {
    const payload: RadarCachePayload = {
      savedAt: Date.now(),
      snapshot: pickBoardSnapshot(snapshot),
    };
    localStorage.setItem(CACHE_KEY, JSON.stringify(payload));
  } catch {
    /* quota / private mode */
  }
}

export function mergeRadarSnapshot(
  prev: RadarSnapshot,
  data: RadarSnapshot,
): RadarSnapshot {
  const incomingEmpty =
    !data.all_tickers?.length && !data.hot_tickers?.length && !data.market_matrix;
  const hadRadar = hasBoardData(prev);

  if (incomingEmpty && hadRadar) {
    return {
      ...data,
      all_tickers: prev.all_tickers,
      hot_tickers: prev.hot_tickers,
      market_matrix: prev.market_matrix,
      meta: data.meta ?? prev.meta,
      pool_meta: data.pool_meta ?? prev.pool_meta,
      pool_size: data.pool_size || prev.pool_size,
      thresholds: data.thresholds ?? prev.thresholds,
      scan_ts: data.scan_ts || prev.scan_ts,
      breakout_alerts: data.breakout_alerts?.length
        ? data.breakout_alerts
        : prev.breakout_alerts,
      pattern: data.pattern ?? prev.pattern,
    };
  }

  // 部分字段空时尽量保留上一轮，避免热榜闪空
  return {
    ...data,
    all_tickers: data.all_tickers?.length ? data.all_tickers : prev.all_tickers,
    hot_tickers: data.hot_tickers?.length ? data.hot_tickers : prev.hot_tickers,
    market_matrix: data.market_matrix ?? prev.market_matrix,
    meta: data.meta ?? prev.meta,
    pool_meta: data.pool_meta ?? prev.pool_meta,
    pool_size: data.pool_size || prev.pool_size,
    thresholds: data.thresholds ?? prev.thresholds,
    breakout_alerts: data.breakout_alerts?.length
      ? data.breakout_alerts
      : prev.breakout_alerts,
    pattern: data.pattern ?? prev.pattern,
  };
}
