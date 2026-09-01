import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { PatternAlert } from "../types";
import { displaySymbol } from "../utils/symbol";

interface TickerItem {
  id: string;
  alert: PatternAlert;
  createdAt: number;
  dir: "多" | "空" | "—";
  reason: string;
}

interface Props {
  alerts: PatternAlert[];
  scanTs: number;
  onOpen?: (symbol: string) => void;
}

/** 头部滚动条保留时长 */
const TICKER_TTL_MS = 8 * 60_000;
const TICKER_MAX = 24;

function alertDirection(a: PatternAlert): "多" | "空" | "—" {
  const side = String(a.side || "").toLowerCase();
  if (side === "bull" || side === "long") return "多";
  if (side === "bear" || side === "short") return "空";

  const hint = String(a.side_hint || "");
  if (hint.includes("多")) return "多";
  if (hint.includes("空")) return "空";

  const kind = `${a.kind || ""} ${a.signal_kind || ""}`.toLowerCase();
  if (
    /shoot|upper_wick|liquidity_sweep|hs_|m_top|curvature|continuous_upper|continuous_non_upper/.test(
      kind,
    )
  ) {
    return "空";
  }
  if (
    /hammer|lower_wick|bottom|spring|continuous_lower|continuous_non_lower/.test(kind)
  ) {
    return "多";
  }

  const label = `${a.status_label || ""} ${a.type_label || ""} ${a.message || ""}`;
  if (/看跌|做空|顶部|射击|头肩|M顶|掠夺/.test(label)) return "空";
  if (/看涨|做多|底部|倒锤|探底|多头|扳机/.test(label)) return "多";
  if (a.type === "trigger" || a.status === "TRIGGER") return "多";
  return "—";
}

function alertReason(a: PatternAlert): string {
  const raw =
    a.type_label ||
    a.pattern_label ||
    a.signal_text ||
    a.status_label ||
    a.message ||
    "信号";
  let s = String(raw)
    .replace(/形态多头爆发/g, "多头爆发")
    .replace(/顶部结构确认/g, "顶部")
    .replace(/底部二次探底确认/g, "二次探底")
    .replace(/破底翻确认/g, "破底翻")
    .replace(/形态\+OI\s*·\s*推荐短线/g, "形态+OI")
    .replace(/形态卡片\s*·\s*/g, "")
    .replace(/结构卡片\s*·\s*/g, "")
    .trim();
  if (a.interval) s = `${s}·${a.interval}`;
  return s.length > 18 ? `${s.slice(0, 17)}…` : s;
}

function alertKey(a: PatternAlert): string {
  return `${a.type}:${a.symbol}:${a.kline_close_time}:${a.message || a.type_label || ""}`;
}

export const PatternAlertTicker = memo(function PatternAlertTicker({
  alerts,
  scanTs,
  onOpen,
}: Props) {
  const [items, setItems] = useState<TickerItem[]>([]);
  const seenRef = useRef<Set<string>>(new Set());
  const scanRef = useRef(0);

  useEffect(() => {
    if (!scanTs || scanTs === scanRef.current) return;
    scanRef.current = scanTs;

    const fresh = alerts.filter((a) => {
      const key = alertKey(a);
      if (seenRef.current.has(key)) return false;
      seenRef.current.add(key);
      return true;
    });
    if (!fresh.length) return;

    if (seenRef.current.size > 500) {
      seenRef.current = new Set([...seenRef.current].slice(-250));
    }

    const now = Date.now();
    setItems((prev) =>
      [
        ...fresh.map((alert) => ({
          id: `${alertKey(alert)}-${now}`,
          alert,
          createdAt: now,
          dir: alertDirection(alert),
          reason: alertReason(alert),
        })),
        ...prev,
      ].slice(0, TICKER_MAX),
    );
  }, [alerts, scanTs]);

  useEffect(() => {
    if (!items.length) return;
    const id = window.setInterval(() => {
      const cutoff = Date.now() - TICKER_TTL_MS;
      setItems((prev) => prev.filter((t) => t.createdAt > cutoff));
    }, 5000);
    return () => window.clearInterval(id);
  }, [items.length]);

  const row = useMemo(() => items, [items]);
  // 条数少时不复制；多时复制一份做无缝滚动
  const loop = row.length >= 3 ? [...row, ...row] : row;
  const animate = row.length >= 3;

  if (!row.length) {
    return (
      <div className="pattern-alert-ticker is-empty" aria-live="polite">
        <span className="pattern-alert-ticker-placeholder">暂无新信号</span>
      </div>
    );
  }

  return (
    <div
      className={`pattern-alert-ticker${animate ? " is-scroll" : ""}`}
      aria-live="polite"
      title="形态信号简讯（点击打开图表）"
    >
      <div
        className="pattern-alert-ticker-track"
        style={
          animate
            ? { animationDuration: `${Math.max(18, row.length * 4.5)}s` }
            : undefined
        }
      >
        {loop.map((it, idx) => (
          <button
            key={`${it.id}-${idx}`}
            type="button"
            className={`pattern-alert-chip dir-${it.dir === "多" ? "long" : it.dir === "空" ? "short" : "flat"}`}
            onClick={() => onOpen?.(it.alert.symbol)}
          >
            <strong>{displaySymbol(it.alert.symbol)}</strong>
            <em>{it.dir}</em>
            <span>{it.reason}</span>
          </button>
        ))}
      </div>
    </div>
  );
});
