import { memo, useEffect, useMemo, useState } from "react";
import { useLongPressDragScroll } from "../hooks/useLongPressDragScroll";
import { NavLink, useNavigate } from "react-router-dom";
import type { PoolMeta } from "../types";
import { useHeaderRankBoards } from "../hooks/useHeaderRankBoards";
import { isOiOperator } from "../utils/oiOperator";
import {
  focusSymbolsToItems,
  HEADER_BOARDS,
  HEADER_FETCH_MS,
  type FocusEntryMeta,
  type HeaderBoardId,
} from "../utils/headerRankBoards";
import { displaySymbol } from "../utils/symbol";

interface Props {
  online: boolean;
  scanTs: number;
  poolMeta?: PoolMeta;
  poolSize: number;
  focusSymbols?: string[];
  focusEntries?: Record<string, FocusEntryMeta>;
  onRemoveFocus?: (symbol: string) => void;
}

const NAV = [
  { to: "/", label: "雷达", end: true },
  { to: "/patterns", label: "形态", end: false },
  { to: "/backtest", label: "回测", end: false },
  { to: "/train", label: "盲K训练", end: false },
] as const;

export const MercuHeader = memo(function MercuHeader({
  online,
  scanTs,
  poolMeta,
  poolSize,
  focusSymbols = [],
  focusEntries = {},
  onRemoveFocus,
}: Props) {
  const [clock, setClock] = useState("");
  const [boardId, setBoardId] = useState<HeaderBoardId>("focus");
  const navigate = useNavigate();
  const canEditFocus = useMemo(() => isOiOperator(), []);

  const { boardItems, meta, dormantMeta, hasBoardData } = useHeaderRankBoards();

  useEffect(() => {
    const tick = () => {
      const now = new Date();
      const h = String(now.getHours()).padStart(2, "0");
      const m = String(now.getMinutes()).padStart(2, "0");
      const s = String(now.getSeconds()).padStart(2, "0");
      setClock(`${h}:${m}:${s}`);
    };
    tick();
    const id = setInterval(tick, 1000);
    return () => clearInterval(id);
  }, []);

  const scanLabel = scanTs
    ? new Date(scanTs * 1000).toLocaleTimeString("zh-CN", { hour12: false })
    : "—";

  const equityBadge =
    poolMeta?.equity_enabled && poolMeta.equity_eligible != null
      ? ` | 币股${poolMeta.equity_eligible}`
      : "";
  const poolLabel = poolMeta
    ? `大象${poolMeta.heavyweight_count ?? 0}·中场${poolMeta.midweight_count ?? 0}·监控${poolMeta.eligible_count ?? poolSize}${equityBadge}`
    : `监控 ${poolSize}`;

  const sourceId = poolMeta?.data_source || "binance";
  const sourceLabel = poolMeta?.data_source_label || "Binance";
  const isFallback = sourceId !== "binance";

  const boardLabel = HEADER_BOARDS.find((b) => b.id === boardId)?.label ?? "榜单";
  const fetchedLabel = meta.updatedAt
    ? new Date(meta.updatedAt).toLocaleTimeString("zh-CN", { hour12: false })
    : "—";

  const items = useMemo(() => {
    if (boardId === "focus") return focusSymbolsToItems(focusSymbols, focusEntries);
    return boardItems(boardId);
  }, [boardId, focusSymbols, focusEntries, boardItems]);

  const dragScrollEnabled = items.length > 0;
  const {
    ref: focusListRef,
    sliding: focusSliding,
    isScrollable: focusScrollable,
    suppressClickRef: focusSuppressClickRef,
    handlers: focusDragHandlers,
  } = useLongPressDragScroll(dragScrollEnabled, [boardId, items.length, items.map((i) => i.symbol).join(",")]);

  const dormantFetched = dormantMeta.updatedAt
    ? new Date(dormantMeta.updatedAt).toLocaleTimeString("zh-CN", { hour12: false })
    : "—";
  const boardTitle =
    boardId === "focus"
      ? "特别关注 · 含沉寂拉盘点火（自动 36h）"
      : boardId === "dormant"
        ? `沉寂拉盘 · 第三梯队小市值 · 慢扫4h筛候选(地量+试盘) · 快扫15m点火 · 更新 ${dormantFetched}`
        : `${boardLabel} · ${meta.sourceLabel} · 24h · 每 ${HEADER_FETCH_MS / 60_000} 分钟刷新 · 更新 ${fetchedLabel}${meta.error ? ` · ${meta.error}` : ""}`;

  return (
    <header className="mercu-header">
      <div className="mercu-header-left">
        <nav className="mercu-nav">
          {NAV.map(({ to, label, end }) => (
            <NavLink
              key={to}
              to={to}
              end={end}
              className={({ isActive }) => `mercu-nav-item${isActive ? " active" : ""}`}
            >
              {label}
            </NavLink>
          ))}
        </nav>
        <span className="mercu-pool-badge">{poolLabel}</span>
        <span
          className={`mercu-source-badge${isFallback ? " fallback" : ""}`}
          title={
            isFallback
              ? `备选 · ${poolMeta?.fallback_reason || "限流/封禁"} · 链 ${(poolMeta?.fallback_chain || []).join("→")}`
              : `主源 Binance · 备选 ${(poolMeta?.fallback_chain || ["bybit", "okx", "bitget", "gate"]).join("→")}`
          }
        >
          源 {isFallback ? sourceLabel : "Binance"}
        </span>
      </div>

      <div className="mercu-header-focus" title={boardTitle}>
        <label className="mercu-focus-select-wrap">
          <select
            className="mercu-focus-select"
            value={boardId}
            onChange={(e) => setBoardId(e.target.value as HeaderBoardId)}
            aria-label="切换榜单"
          >
            {HEADER_BOARDS.map((b) => (
              <option key={b.id} value={b.id}>
                {b.label}
              </option>
            ))}
          </select>
        </label>
        <div
          ref={focusListRef}
          className={`mercu-focus-list${focusScrollable ? " is-scroll" : ""}${focusSliding ? " is-sliding" : ""}`}
          role="list"
          aria-label={`${boardLabel}${focusScrollable ? "：长按后左右滑动" : ""}`}
          {...focusDragHandlers}
        >
          {boardId === "focus" && items.length === 0 ? (
            <span className="mercu-focus-empty">暂无</span>
          ) : boardId === "dormant" && items.length === 0 ? (
            <span className="mercu-focus-empty">暂无候选（等待慢扫/快扫）</span>
          ) : boardId !== "focus" && items.length === 0 ? (
            <span className="mercu-focus-empty">
              {!hasBoardData && meta.error
                ? meta.error.includes("重启 OI")
                  ? meta.error
                  : "拉取失败"
                : hasBoardData
                  ? "暂无"
                  : "加载币安榜单…"}
            </span>
          ) : (
            items.map((item) => {
              const sym = item.symbol;
              const isFocus = boardId === "focus";
              return (
                <span key={`${boardId}-${sym}`} className="mercu-focus-chip" role="listitem">
                  {item.rank != null ? (
                    <span className="mercu-focus-rank">#{item.rank}</span>
                  ) : null}
                  <button
                    type="button"
                    className="mercu-focus-sym"
                    onClick={() => {
                      if (focusSuppressClickRef.current) return;
                      navigate(`/patterns?symbol=${encodeURIComponent(sym)}`);
                    }}
                    title={`打开 ${displaySymbol(sym)} 形态图`}
                  >
                    {displaySymbol(sym)}
                  </button>
                  {item.badge ? (
                    <span className={`mercu-focus-badge ${item.tone ?? "neutral"}`}>
                      {item.badge}
                    </span>
                  ) : null}
                  {isFocus && canEditFocus ? (
                    <button
                      type="button"
                      className="mercu-focus-x"
                      aria-label={`取消特别关注 ${displaySymbol(sym)}`}
                      onClick={(e) => {
                        e.stopPropagation();
                        onRemoveFocus?.(sym);
                      }}
                    >
                      ×
                    </button>
                  ) : null}
                </span>
              );
            })
          )}
        </div>
      </div>

      <div className="mercu-header-right">
        <div className="mercu-status">
          <span className={`live-pill ${online ? "on" : "off"}`}>
            <span className="live-dot" />
            {online ? "LIVE" : "OFF"}
          </span>
          <span className="mercu-clock">UTC+8 {clock}</span>
          <span className="mercu-scan">扫描 {scanLabel}</span>
        </div>
      </div>
    </header>
  );
});
