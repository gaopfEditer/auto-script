import { memo, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import type { TickerRow } from "../types";
import {
  deriveOiAlerts,
  isPlausibleOiAlert,
  type AlertThresholds,
  type OiAlertItem,
} from "../utils/deriveOiAlerts";
import { fmtDelta, fmtPct } from "../utils/format";
import { patternsPathForSymbol } from "../utils/patternNav";
import { displaySymbol } from "../utils/symbol";
import { CoinAvatar } from "./CoinAvatar";

interface Props {
  rows: TickerRow[];
  scanTs: number;
  poolSize: number;
  thresholds: AlertThresholds;
}

/** 异动流本地缓存时长 */
const ALERT_FEED_TTL_MS = 2 * 60 * 60_000;
const ALERT_FEED_MAX = 80;
/** v2：丢掉旧缓存里 5m OI +100% 这类脏点 */
const ALERT_FEED_CACHE_KEY = "oi_alert_feed_v2";

type AlertFeedCachePayload = {
  items: OiAlertItem[];
};

function formatClock(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function windowLabel(window: OiAlertItem["window"]): string {
  return window === "5m" ? "5分钟内" : "15分钟内";
}

function typeLabel(item: OiAlertItem): string {
  if (item.kind === "price") {
    return item.isPump ? "价格暴涨" : "价格暴跌";
  }
  return item.isPump ? "OI 暴增" : "OI 暴跌";
}

function pruneAlertItems(items: OiAlertItem[], nowMs = Date.now()): OiAlertItem[] {
  const cutoffSec = (nowMs - ALERT_FEED_TTL_MS) / 1000;
  return items
    .filter((it) => Number(it.alertTs) > cutoffSec)
    .filter((it) => isPlausibleOiAlert(it))
    .sort((a, b) => (b.alertTs || 0) - (a.alertTs || 0))
    .slice(0, ALERT_FEED_MAX);
}

function isAlertItem(v: unknown): v is OiAlertItem {
  if (!v || typeof v !== "object") return false;
  const it = v as OiAlertItem;
  return (
    typeof it.id === "string" &&
    it.row != null &&
    typeof it.row === "object" &&
    typeof it.row.symbol === "string" &&
    typeof it.alertTs === "number"
  );
}

function loadAlertFeedCache(): OiAlertItem[] {
  try {
    const raw =
      localStorage.getItem(ALERT_FEED_CACHE_KEY) ||
      localStorage.getItem("oi_alert_feed_v1");
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AlertFeedCachePayload;
    const items = Array.isArray(parsed?.items) ? parsed.items.filter(isAlertItem) : [];
    const pruned = pruneAlertItems(items);
    localStorage.setItem(ALERT_FEED_CACHE_KEY, JSON.stringify({ items: pruned }));
    localStorage.removeItem("oi_alert_feed_v1");
    return pruned;
  } catch {
    return [];
  }
}

function saveAlertFeedCache(items: OiAlertItem[]) {
  try {
    const payload: AlertFeedCachePayload = { items: pruneAlertItems(items) };
    localStorage.setItem(ALERT_FEED_CACHE_KEY, JSON.stringify(payload));
  } catch {
    /* quota / private mode */
  }
}

/** 合并本轮派生与缓存：同 id 保留首次出现时间，刷新数值与标签 */
function mergeAlertFeed(
  cached: OiAlertItem[],
  live: OiAlertItem[],
  scanTs: number,
): OiAlertItem[] {
  const byId = new Map<string, OiAlertItem>();
  for (const it of cached) byId.set(it.id, it);

  const fallbackTs = scanTs > 0 ? scanTs : Date.now() / 1000;
  for (const item of live) {
    const prev = byId.get(item.id);
    const alertTs =
      prev && Number(prev.alertTs) > 0
        ? Number(prev.alertTs)
        : Number(item.alertTs) > 0
          ? Number(item.alertTs)
          : fallbackTs;
    byId.set(item.id, { ...item, alertTs });
  }

  return pruneAlertItems([...byId.values()]);
}

const AlertCard = memo(function AlertCard({
  item,
  timeLabel,
  onSelect,
}: {
  item: OiAlertItem;
  timeLabel: string;
  onSelect?: (symbol: string) => void;
}) {
  const { row, window, deltaUsd, pct, isPump, isSuppressed, kind, tags } = item;

  return (
    <article
      className={`alert-card ${isPump ? "pump" : "dump"} ${isSuppressed ? "suppressed" : ""}${onSelect ? " alert-card-clickable" : ""}`}
      onClick={() => onSelect?.(row.symbol)}
      title={onSelect ? `查看 ${displaySymbol(row.symbol)} 形态 K 线` : undefined}
      role={onSelect ? "button" : undefined}
    >
      <div className="alert-card-row">
        <time className="alert-ts">{timeLabel}</time>
        <div className="alert-card-body">
          <div className="alert-card-head">
            <div className="alert-coin">
              <CoinAvatar symbol={row.symbol} />
              <span className="alert-symbol">${displaySymbol(row.symbol)}</span>
            </div>
            <span className={`alert-type ${isPump ? "pump" : "dump"}`}>
              {typeLabel(item)}
              {isSuppressed ? " · 已抑制" : ""}
            </span>
          </div>
          <p className={`alert-desc ${isPump ? "pos" : "neg"}`}>
            {kind === "price" ? (
              <>
                {windowLabel(window)} 价格 {fmtPct(pct)}
              </>
            ) : (
              <>
                {windowLabel(window)} OI {fmtDelta(deltaUsd)} ({fmtPct(pct)})
              </>
            )}
          </p>
          <div className="alert-tags">
            {tags.map((t) => (
              <span key={t} className="alert-tag">
                {t}
              </span>
            ))}
          </div>
        </div>
      </div>
    </article>
  );
});

export const AlertFeed = memo(function AlertFeed({
  rows,
  scanTs,
  poolSize,
  thresholds,
}: Props) {
  const navigate = useNavigate();
  const [items, setItems] = useState<OiAlertItem[]>(() => loadAlertFeedCache());

  const liveAlerts = useMemo(
    () => deriveOiAlerts(rows, thresholds, 60, scanTs),
    [rows, thresholds, scanTs],
  );

  useEffect(() => {
    setItems((prev) => {
      const next = mergeAlertFeed(prev, liveAlerts, scanTs);
      saveAlertFeedCache(next);
      return next;
    });
  }, [liveAlerts, scanTs]);

  useEffect(() => {
    if (!items.length) return;
    const id = window.setInterval(() => {
      setItems((prev) => {
        const next = pruneAlertItems(prev);
        if (next.length !== prev.length) saveAlertFeedCache(next);
        return next;
      });
    }, 30_000);
    return () => window.clearInterval(id);
  }, [items.length]);

  const scanTimeLabel = formatClock(scanTs);
  const openPattern = (symbol: string) => navigate(patternsPathForSymbol(symbol));

  return (
    <aside className="panel alert-feed">
      <div className="panel-title">
        <span className="alert-feed-title">
          异动监控
          <span
            className="alert-feed-info"
            title="OI 暴增/暴跌 + 价格暴涨/暴跌（5m/15m）；本地缓存约 2 小时，刷新不丢"
          >
            ⓘ
          </span>
        </span>
        <span className="panel-count">
          LIVE · {items.length} · 更新 {scanTimeLabel}
        </span>
      </div>

      <div className="alert-scanner">
        <span className="alert-scanner-label">AI 全市场扫描</span>
        <span className="alert-scanner-meta">{poolSize}+ 币种</span>
      </div>

      <div className="alert-feed-scroll">
        {items.length === 0 ? (
          <div className="panel-empty">暂无异动 · 持续扫描中（暖机约需数分钟）</div>
        ) : (
          items.map((item) => (
            <AlertCard
              key={item.id}
              item={item}
              timeLabel={formatClock(item.alertTs)}
              onSelect={openPattern}
            />
          ))
        )}
      </div>
    </aside>
  );
});
