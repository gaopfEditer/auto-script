import { memo, useMemo, useState } from "react";
import type { SandboxCardOrder } from "../types";
import { displaySymbol } from "../utils/symbol";
import { fmtMetaPrice, fmtTs } from "../utils/format";
import { resolveSandboxCardAuthor } from "../utils/cardAuthor";

type PhaseFilter = "all" | "active" | "entered" | "closed" | "sl" | "tp";

const PHASE_FILTERS: Array<{ id: PhaseFilter; label: string }> = [
  { id: "all", label: "全部" },
  { id: "active", label: "进行中" },
  { id: "entered", label: "已入场" },
  { id: "closed", label: "已出场" },
  { id: "tp", label: "止盈" },
  { id: "sl", label: "止损" },
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
  const [filter, setFilter] = useState<PhaseFilter>("all");

  const rows = useMemo(() => {
    let list = [...orders];
    if (filter === "active") {
      list = list.filter((o) =>
        ["watching", "near", "ordered", "filled"].includes(String(o.status)),
      );
    } else if (filter === "entered") {
      list = list.filter((o) => o.phase_entered || o.status === "filled" || o.status === "closed");
    } else if (filter === "closed") {
      list = list.filter((o) => o.status === "closed");
    } else if (filter === "sl") {
      list = list.filter((o) => o.phase_sl || o.phase === "止损");
    } else if (filter === "tp") {
      list = list.filter((o) => o.phase_tp || o.phase === "止盈");
    }
    list.sort((a, b) => Number(b.updated_at || b.created_at || 0) - Number(a.updated_at || a.created_at || 0));
    return list;
  }, [orders, filter]);

  if (!open) return null;

  return (
    <div className="card-life-overlay" role="dialog" aria-modal="true" aria-label="卡片生命周期">
      <div className="card-life-panel">
        <header className="card-life-head">
          <div>
            <h3>卡片生命周期</h3>
            <p className="card-life-sub">
              建立 → 监听 → 入场 → 出场 / 止损 / 止盈
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
          {PHASE_FILTERS.map((f) => (
            <button
              key={f.id}
              type="button"
              className={filter === f.id ? "on" : ""}
              onClick={() => setFilter(f.id)}
            >
              {f.label}
            </button>
          ))}
          <span className="card-life-count">{rows.length} 张</span>
        </div>

        <div className="card-life-table-wrap">
          <table className="sandbox-table card-life-table">
            <thead>
              <tr>
                <th>阶段</th>
                <th>链路</th>
                <th>卡片</th>
                <th>币种</th>
                <th>方向</th>
                <th>现价</th>
                <th>距入场</th>
                <th>距下一TP</th>
                <th>距SL</th>
                <th>入场 / 出场</th>
                <th>时间</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((o) => {
                const author = resolveSandboxCardAuthor(o);
                return (
                  <tr
                    key={o.card_id}
                    className="clickable"
                    onClick={() => onSelectSymbol(o.symbol)}
                  >
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
                    <td>
                      {o.card_id}
                      {author ? <span className="sandbox-pnl-sub">{author}</span> : null}
                    </td>
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
                    <td>
                      {fmtTs(o.signal_at || o.created_at || 0)}
                      {o.closed_at ? (
                        <>
                          <br />
                          <span className="sandbox-pnl-sub">平 {fmtTs(o.closed_at)}</span>
                        </>
                      ) : null}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!rows.length ? <p className="muted card-life-empty">暂无卡片记录</p> : null}
        </div>
      </div>
    </div>
  );
});
