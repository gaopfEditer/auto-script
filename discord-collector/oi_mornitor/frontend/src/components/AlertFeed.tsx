import { memo, useMemo, useRef } from "react";
import { useNavigate } from "react-router-dom";
import type { TickerRow } from "../types";
import {
  deriveOiAlerts,
  type AlertThresholds,
  type OiAlertItem,
} from "../utils/deriveOiAlerts";
import { fmtDelta, fmtPct } from "../utils/format";
import { patternsPathForSymbol } from "../utils/patternNav";
import { coinInitial, displaySymbol } from "../utils/symbol";

interface Props {
  rows: TickerRow[];
  scanTs: number;
  poolSize: number;
  thresholds: AlertThresholds;
}

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
              <span className="coin-avatar">{coinInitial(row.symbol)}</span>
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
  const firstSeenRef = useRef<Map<string, number>>(new Map());

  const alerts = useMemo(() => {
    const derived = deriveOiAlerts(rows, thresholds, 60, scanTs);
    const seen = firstSeenRef.current;
    const alive = new Set<string>();
    const out: OiAlertItem[] = derived.map((item) => {
      alive.add(item.id);
      let alertTs = item.alertTs;
      if (alertTs > 0) {
        seen.set(item.id, alertTs);
      } else {
        const prev = seen.get(item.id);
        if (prev && prev > 0) {
          alertTs = prev;
        } else {
          alertTs = scanTs > 0 ? scanTs : Date.now() / 1000;
          seen.set(item.id, alertTs);
        }
      }
      return { ...item, alertTs };
    });
    for (const id of [...seen.keys()]) {
      if (!alive.has(id)) seen.delete(id);
    }
    return out;
  }, [rows, thresholds, scanTs]);

  const scanTimeLabel = formatClock(scanTs);
  const openPattern = (symbol: string) => navigate(patternsPathForSymbol(symbol));

  return (
    <aside className="panel alert-feed">
      <div className="panel-title">
        <span className="alert-feed-title">
          异动监控
          <span
            className="alert-feed-info"
            title="OI 暴增/暴跌 + 价格暴涨/暴跌（5m/15m），实时派生不依赖冷却门控"
          >
            ⓘ
          </span>
        </span>
        <span className="panel-count">
          LIVE · {alerts.length} · 更新 {scanTimeLabel}
        </span>
      </div>

      <div className="alert-scanner">
        <span className="alert-scanner-label">AI 全市场扫描</span>
        <span className="alert-scanner-meta">{poolSize}+ 币种</span>
      </div>

      <div className="alert-feed-scroll">
        {alerts.length === 0 ? (
          <div className="panel-empty">暂无异动 · 持续扫描中（暖机约需数分钟）</div>
        ) : (
          alerts.map((item) => (
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
