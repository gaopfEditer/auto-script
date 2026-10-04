import { memo, useMemo, useState } from "react";
import type { SandboxCardOrder } from "../types";
import { displaySymbol } from "../utils/symbol";
import { fmtMetaPrice, fmtTs } from "../utils/format";
import { resolveSandboxCardAuthor } from "../utils/cardAuthor";

type StatusFilter = "all" | "tp" | "sl";

type TimeRangeKey = "24h" | "3d" | "1w" | "1m" | "3m";

const STATUS_OPTIONS: Array<{ id: StatusFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "tp", label: "止盈" },
  { id: "sl", label: "止损" },
];

const TIME_RANGES: Array<{ id: TimeRangeKey; label: string; ms: number }> = [
  { id: "24h", label: "24h", ms: 24 * 3600_000 },
  { id: "3d", label: "3d", ms: 3 * 86400_000 },
  { id: "1w", label: "1w", ms: 7 * 86400_000 },
  { id: "1m", label: "1m", ms: 30 * 86400_000 },
  { id: "3m", label: "3m", ms: 90 * 86400_000 },
];

function phaseClass(phase?: string): string {
  switch (phase) {
    case "止盈":
      return "card-phase tp";
    case "止损":
      return "card-phase sl";
    case "入场":
      return "card-phase entered";
    case "挂单":
    case "近场":
      return "card-phase near";
    case "监听":
    case "建立":
      return "card-phase watch";
    case "拒收":
      return "card-phase reject";
    case "出场":
      return "card-phase exit";
    default:
      return "card-phase";
  }
}

function fmtDist(v?: number | null): string {
  if (v == null || Number.isNaN(Number(v))) return "—";
  const n = Number(v);
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

/** 发单/建卡时间（秒） */
function cardEventSec(o: SandboxCardOrder): number {
  const raw = Number(o.signal_at ?? o.created_at ?? o.updated_at ?? 0);
  if (!Number.isFinite(raw) || raw <= 0) return 0;
  return raw > 1e12 ? Math.floor(raw / 1000) : Math.floor(raw);
}

function matchesStatus(o: SandboxCardOrder, filter: StatusFilter): boolean {
  if (filter === "all") return true;
  if (filter === "tp") return Boolean(o.phase_tp || o.phase === "止盈" || o.outcome === "take_profit");
  if (filter === "sl") return Boolean(o.phase_sl || o.phase === "止损" || o.outcome === "stop_loss");
  return true;
}

function StepDots(props: {
  created?: boolean;
  watching?: boolean;
  entered?: boolean;
  exited?: boolean;
  sl?: boolean;
  tp?: boolean;
}) {
  const items = [
    { on: props.created, label: "建" },
    { on: props.watching, label: "听" },
    { on: props.entered, label: "入" },
    { on: props.exited, label: "出" },
    { on: props.sl, label: "损" },
    { on: props.tp, label: "盈" },
  ];
  return (
    <span className="card-life-steps" title="建立 · 监听 · 入场 · 出场 · 止损 · 止盈">
      {items.map((it) => (
        <i key={it.label} className={it.on ? "on" : ""}>
          {it.label}
        </i>
      ))}
    </span>
  );
}

export const CardLifecyclePanel = memo(function CardLifecyclePanel(props: {
  open: boolean;
  orders: SandboxCardOrder[];
  priceTs?: number;
  onClose: () => void;
  onSelectSymbol: (symbol: string) => void;
  onRefreshPrices?: () => void;
  refreshing?: boolean;
}) {
  const { open, orders, priceTs, onClose, onSelectSymbol, onRefreshPrices, refreshing } = props;
  const [statusFilter, setStatusFilter] = useState<StatusFilter>("all");
  const [timeRange, setTimeRange] = useState<TimeRangeKey>("1w");
  /** 空集合 = 不过滤人员；非空 = 仅所选作者 */
  const [selectedAuthors, setSelectedAuthors] = useState<Set<string>>(() => new Set());

  const authorOptions = useMemo(() => {
    const set = new Set<string>();
    for (const o of orders) {
      const a = resolveSandboxCardAuthor(o);
      if (a) set.add(a);
    }
    return [...set].sort((a, b) => a.localeCompare(b, "zh-CN"));
  }, [orders]);

  const rangeMs = TIME_RANGES.find((r) => r.id === timeRange)?.ms ?? TIME_RANGES[2].ms;

  const rows = useMemo(() => {
    const nowSec = Math.floor(Date.now() / 1000);
    const minSec = nowSec - Math.floor(rangeMs / 1000);

    let list = orders.filter((o) => {
      const ts = cardEventSec(o);
      if (ts > 0 && ts < minSec) return false;
      if (!matchesStatus(o, statusFilter)) return false;
      if (selectedAuthors.size > 0) {
        const author = resolveSandboxCardAuthor(o);
        if (!author || !selectedAuthors.has(author)) return false;
      }
      return true;
    });

    list.sort((a, b) => cardEventSec(a) - cardEventSec(b));
    return list;
  }, [orders, statusFilter, timeRange, rangeMs, selectedAuthors]);

  const toggleAuthor = (name: string) => {
    setSelectedAuthors((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  };

  const selectAllAuthors = () => setSelectedAuthors(new Set(authorOptions));
  const clearAuthors = () => setSelectedAuthors(new Set());

  if (!open) return null;

  const authorFilterLabel =
    selectedAuthors.size === 0
      ? "全部人员"
      : selectedAuthors.size === authorOptions.length
        ? "全部人员"
        : `已选 ${selectedAuthors.size} 人`;

  return (
    <div className="card-life-overlay" role="dialog" aria-modal="true" aria-label="卡片生命周期">
      <div className="card-life-panel">
        <header className="card-life-head">
          <div>
            <h3>卡片生命周期</h3>
            <p className="card-life-sub">
              建立 → 监听 → 入场 → 出场 / 止损 / 止盈 · 按发单时间从早到晚
              {priceTs ? ` · 市价更新 ${fmtTs(priceTs)}` : ""}
            </p>
          </div>
          <div className="card-life-actions">
            {onRefreshPrices ? (
              <button
                type="button"
                className="pattern-random-btn"
                disabled={refreshing}
                onClick={onRefreshPrices}
              >
                {refreshing ? "刷新中…" : "立即刷新市价"}
              </button>
            ) : null}
            <button type="button" className="pattern-random-btn ghost" onClick={onClose}>
              关闭
            </button>
          </div>
        </header>

        <div className="card-life-filters">
          <label className="card-life-filter-field">
            <span className="card-life-filter-label">时间范围</span>
            <select
              className="card-life-select"
              value={timeRange}
              onChange={(e) => setTimeRange(e.target.value as TimeRangeKey)}
            >
              {TIME_RANGES.map((r) => (
                <option key={r.id} value={r.id}>
                  {r.label}
                </option>
              ))}
            </select>
          </label>

          <label className="card-life-filter-field">
            <span className="card-life-filter-label">状态</span>
            <select
              className="card-life-select"
              value={statusFilter}
              onChange={(e) => setStatusFilter(e.target.value as StatusFilter)}
            >
              {STATUS_OPTIONS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.label}
                </option>
              ))}
            </select>
          </label>

          <span className="card-life-count">{rows.length} 张</span>
        </div>

        {authorOptions.length ? (
          <div className="card-life-author-bar">
            <div className="card-life-author-head">
              <span className="card-life-filter-label">人员（多选）</span>
              <span className="card-life-author-meta">{authorFilterLabel}</span>
              <button type="button" className="card-life-link-btn" onClick={selectAllAuthors}>
                全选
              </button>
              <button type="button" className="card-life-link-btn" onClick={clearAuthors}>
                清空
              </button>
            </div>
            <div className="card-life-author-chips">
              {authorOptions.map((name) => {
                const on = selectedAuthors.size > 0 && selectedAuthors.has(name);
                return (
                  <label key={name} className={`card-life-author-chip${on ? " on" : ""}`}>
                    <input
                      type="checkbox"
                      checked={on}
                      onChange={() => {
                        if (selectedAuthors.size === 0) {
                          setSelectedAuthors(new Set([name]));
                          return;
                        }
                        toggleAuthor(name);
                      }}
                    />
                    {name}
                  </label>
                );
              })}
            </div>
          </div>
        ) : null}

        <div className="card-life-table-wrap">
          <table className="sandbox-table card-life-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>阶段</th>
                <th>链路</th>
                <th>人员</th>
                <th>卡片</th>
                <th>币种</th>
                <th>方向</th>
                <th>现价</th>
                <th>距入场</th>
                <th>距下一TP</th>
                <th>距SL</th>
                <th>入场 / 出场</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const author = resolveSandboxCardAuthor(o);
                const eventSec = cardEventSec(o);
                return (
                  <tr
                    key={o.card_id}
                    className="clickable"
                    onClick={() => onSelectSymbol(o.symbol)}
                  >
                    <td className="sandbox-tf">
                      {eventSec ? fmtTs(eventSec) : "—"}
                      {o.closed_at ? (
                        <>
                          <br />
                          <span className="sandbox-pnl-sub">平 {fmtTs(o.closed_at)}</span>
                        </>
                      ) : null}
                    </td>
                    <td>
                      <span className={phaseClass(o.phase)}>{o.phase || o.status}</span>
                    </td>
                    <td>
                      <StepDots
                        created={o.phase_created ?? true}
                        watching={o.phase_watching}
                        entered={o.phase_entered}
                        exited={o.phase_exited}
                        sl={o.phase_sl}
                        tp={o.phase_tp}
                      />
                    </td>
                    <td>{author || "—"}</td>
                    <td>{o.card_id}</td>
                    <td>${displaySymbol(o.symbol)}</td>
                    <td>{o.side}</td>
                    <td>{o.last_price != null ? fmtMetaPrice(o.last_price) : "—"}</td>
                    <td>{fmtDist(o.dist_zone_pct ?? o.dist_entry_pct)}</td>
                    <td>
                      {o.next_tp != null
                        ? `TP${o.next_tp} ${fmtDist(o.dist_next_tp_pct)}`
                        : "—"}
                    </td>
                    <td>{fmtDist(o.dist_sl_pct)}</td>
                    <td className="sandbox-tf">
                      {o.fill_price != null
                        ? `入@${fmtMetaPrice(o.fill_price)}`
                        : o.entry_type === "market"
                          ? "市价"
                          : o.entry_low != null
                            ? `区 ${o.entry_low}${
                                o.entry_high != null && o.entry_high !== o.entry_low
                                  ? `-${o.entry_high}`
                                  : ""
                              }`
                            : "—"}
                      {o.exit_price != null ? (
                        <>
                          <br />
                          出@{fmtMetaPrice(o.exit_price)}
                          {o.exit_label ? ` ${o.exit_label}` : ""}
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length ? <p className="muted card-life-empty">暂无符合筛选的卡片</p> : null}
        </div>
      </div>
    </div>
  );
});
