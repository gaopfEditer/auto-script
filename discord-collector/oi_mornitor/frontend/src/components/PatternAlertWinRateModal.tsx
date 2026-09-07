import { memo, useEffect, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import {
  ALERT_SETTLE_RULES_SUMMARY,
  ALERT_STATS_PAGE_SIZE,
  alertStatsLeverage,
  alertStatsPnlPct,
  fetchAlertStatsPage,
  formatAlertStatsTime,
  outcomeLabel,
  retryFailedAlertStats,
  reverifyAlertStatsByKeys,
  formatAlertTotalPnlPct,
  formatAlertTypeOptionLabel,
  formatIntervalOptionLabel,
  type AlertStatsIntervalOption,
  type AlertStatsRecord,
  type AlertStatsTimeFilter,
  type AlertStatsTypeOption,
  type AlertWinRateSummary,
} from "../utils/patternAlertWinRate";
import { PATTERN_ENTRY_RULES } from "../utils/patternEntryRules";
import { isOiOperator } from "../utils/oiOperator";

interface Props {
  open: boolean;
  onClose: () => void;
  onOpenSymbol?: (symbol: string, interval?: string) => void;
  /** 列表重拉/筛选后同步头部胜率 */
  onStatsChange?: () => void;
  /** 顶部滚动条是否继续捕获新 SSE 信号（仅 operator 有意义） */
  captureEnabled?: boolean;
  onCaptureEnabledChange?: (enabled: boolean) => void;
}

const TIME_FILTERS: { id: AlertStatsTimeFilter | "all"; label: string }[] = [
  { id: "all", label: "全部" },
  { id: "2h", label: "2h" },
  { id: "4h", label: "4h" },
  { id: "8h", label: "8h" },
  { id: "24h", label: "24h" },
  { id: "3d", label: "3d" },
  { id: "7d", label: "近一周" },
  { id: "14d", label: "2w" },
  { id: "30d", label: "近一月" },
  { id: "1m", label: "1m" },
  { id: "2m", label: "2m" },
  { id: "3m", label: "3m" },
];

const EMPTY_SUMMARY: AlertWinRateSummary = {
  total: 0,
  pending: 0,
  wins: 0,
  losses: 0,
  flats: 0,
  errors: 0,
  winRate: null,
  totalPnlPct: null,
};
function fmtPrice(v: number): string {
  if (!Number.isFinite(v)) return "—";
  if (Math.abs(v) >= 1000) return v.toFixed(2);
  if (Math.abs(v) >= 1) return v.toFixed(4);
  return v.toFixed(6).replace(/\.?0+$/, "") || "0";
}

function fmtPnl(
  rec: AlertStatsRecord,
  hideYield = false,
): { text: string; cls: string; title?: string } {
  if (rec.outcome === "pending") return { text: "待核实", cls: "muted" };
  if (rec.outcome === "error") {
    const reason = rec.error || "未知错误";
    const short =
      /Invalid symbol|invalid symbol|-1121/i.test(reason)
        ? "合约名无效"
        : /Failed to fetch|NetworkError|CORS|network|超时|timeout|ECONNREFUSED|代拉|服务端/i.test(
            reason,
          )
          ? "网络/代拉失败"
          : /K线为空|no_klines/i.test(reason)
            ? "无K线"
            : "核实失败";
    return { text: short, cls: "neg", title: reason };
  }
  if (rec.outcome === "flat") {
    const tip =
      rec.exitPrice != null && Number.isFinite(rec.exitPrice)
        ? `结算价 ${fmtPrice(rec.exitPrice)}`
        : undefined;
    return { text: hideYield ? "平" : "平 · ≈0", cls: "muted", title: tip };
  }
  const pnl = alertStatsPnlPct(rec);
  if (pnl == null) return { text: "已核 · —", cls: "muted" };
  const lev = alertStatsLeverage(rec);
  const sign = pnl >= 0 ? "+" : "";
  const tipParts: string[] = [];
  if (rec.exitPrice != null && Number.isFinite(rec.exitPrice)) {
    tipParts.push(`结算价 ${fmtPrice(rec.exitPrice)}`);
  }
  if (
    rec.outcome === "take_profit" &&
    rec.maxProfitPrice != null &&
    Number.isFinite(rec.maxProfitPrice) &&
    rec.maxProfitPct != null &&
    rec.maxProfitPct > 0
  ) {
    const sameAsExit =
      rec.exitPrice != null &&
      Math.abs(rec.maxProfitPrice - rec.exitPrice) / Math.max(Math.abs(rec.exitPrice), 1e-12) <
        1e-6;
    if (!sameAsExit) {
      tipParts.push(`最大盈利价 ${fmtPrice(rec.maxProfitPrice)}`);
      tipParts.push(`最大盈利 +${rec.maxProfitPct.toFixed(1)}%`);
    }
  }
  const title = tipParts.length ? tipParts.join("\n") : undefined;
  const yieldText = `${sign}${pnl.toFixed(1)}% (@${lev}x)`;
  if (hideYield) {
    if (rec.outcome === "take_profit") {
      return { text: "止盈", cls: "pos", title };
    }
    if (rec.outcome === "stop_loss") {
      return { text: "止损", cls: "neg", title };
    }
  }
  return {
    text: yieldText,
    cls: pnl >= 0 ? "pos" : "neg",
    title,
  };
}

const HIDE_YIELD_LS = "oi_pattern_wr_hide_yield_v1";

function readHideYield(): boolean {
  try {
    return localStorage.getItem(HIDE_YIELD_LS) === "1";
  } catch {
    return false;
  }
}

export const PatternAlertWinRateModal = memo(function PatternAlertWinRateModal({
  open,
  onClose,
  onOpenSymbol,
  onStatsChange,
  captureEnabled = true,
  onCaptureEnabledChange,
}: Props) {
  const [filter, setFilter] = useState<AlertStatsTimeFilter>("all");
  const [typeFilter, setTypeFilter] = useState<string>("all");
  const [intervalFilter, setIntervalFilter] = useState<string>("all");
  const [page, setPage] = useState(1);
  const [rows, setRows] = useState<AlertStatsRecord[]>([]);
  const [summary, setSummary] = useState<AlertWinRateSummary>(EMPTY_SUMMARY);
  const [typeOptions, setTypeOptions] = useState<AlertStatsTypeOption[]>([]);
  const [intervalOptions, setIntervalOptions] = useState<AlertStatsIntervalOption[]>([]);
  const [total, setTotal] = useState(0);
  const [pages, setPages] = useState(1);
  const [loadingList, setLoadingList] = useState(false);
  const [retrying, setRetrying] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(() => new Set());
  const [statusNote, setStatusNote] = useState("");
  const [hideYield, setHideYield] = useState(readHideYield);
  const [showEntryRules, setShowEntryRules] = useState(false);
  /** 待确认的捕捉开关目标值；非 null 时显示二次确认 */
  const [pendingCapture, setPendingCapture] = useState<boolean | null>(null);
  const canWriteStats = useMemo(() => isOiOperator(), []);
  const showCaptureToggle = canWriteStats && typeof onCaptureEnabledChange === "function";

  const bump = () => {
    onStatsChange?.();
  };

  const reloadPage = async (opts?: { page?: number }) => {
    const nextPage = opts?.page ?? page;
    setLoadingList(true);
    try {
      const res = await fetchAlertStatsPage({
        page: nextPage,
        pageSize: ALERT_STATS_PAGE_SIZE,
        timeFilter: filter,
        typeFilter,
        intervalFilter,
      });
      setRows(res.items);
      setSummary(res.summary);
      setTypeOptions(res.typeOptions);
      setIntervalOptions(res.intervalOptions ?? []);
      setTotal(res.total);
      setPages(res.pages);
      setPage(res.page);
      bump();
    } finally {
      setLoadingList(false);
    }
  };

  const toggleHideYield = () => {
    setHideYield((prev) => {
      const next = !prev;
      try {
        localStorage.setItem(HIDE_YIELD_LS, next ? "1" : "0");
      } catch {
        /* ignore */
      }
      return next;
    });
  };

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setStatusNote("");
    setPendingCapture(null);
    setPage(1);
    void reloadPage({ page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps -- 打开时拉第一页
  }, [open]);

  useEffect(() => {
    if (!open) return;
    setSelected(new Set());
    setPage(1);
    void reloadPage({ page: 1 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filter, typeFilter, intervalFilter]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      if (pendingCapture != null) {
        setPendingCapture(null);
        return;
      }
      onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose, pendingCapture]);

  useEffect(() => {
    if (typeFilter === "all") return;
    if (!typeOptions.some((o) => o.label === typeFilter)) setTypeFilter("all");
  }, [typeOptions, typeFilter]);

  const failCount = summary.errors;
  const selectedCount = selected.size;
  const allKeys = useMemo(() => rows.map((r) => r.key), [rows]);
  const allSelected = allKeys.length > 0 && allKeys.every((k) => selected.has(k));

  const toggleOne = (key: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  };

  const toggleAll = () => {
    if (allSelected) setSelected(new Set());
    else setSelected(new Set(allKeys));
  };

  const onRetryFails = async () => {
    if (retrying) return;
    setRetrying(true);
    setStatusNote("正在重试失败项…");
    try {
      await retryFailedAlertStats(() => bump());
      setStatusNote("失败项重试完成");
      setSelected(new Set());
      await reloadPage();
    } finally {
      setRetrying(false);
    }
  };

  const onReverifySelected = async () => {
    if (retrying || selectedCount === 0) return;
    const keys = [...selected];
    setRetrying(true);
    setStatusNote(`正在重拉 ${keys.length} 条…`);
    bump();
    try {
      await reverifyAlertStatsByKeys(keys, () => bump());
      setStatusNote(`已重拉 ${keys.length} 条`);
      setSelected(new Set());
      await reloadPage();
    } finally {
      setRetrying(false);
    }
  };

  const goPage = (p: number) => {
    const next = Math.min(pages, Math.max(1, p));
    setSelected(new Set());
    void reloadPage({ page: next });
  };

  if (!open) return null;

  const wr =
    summary.winRate == null ? "—" : `${(summary.winRate * 100).toFixed(0)}%`;

  return createPortal(
    <div
      className="pattern-wr-overlay"
      role="dialog"
      aria-modal="true"
      aria-label="形态信号胜率明细"
      onClick={onClose}
    >
      <div
        className="pattern-wr-panel"
        onClick={(e) => e.stopPropagation()}
      >
        <header className="pattern-wr-head">
          <div>
            <h2>形态信号列表</h2>
            <p>
              筛选共 {summary.total} 条 · 胜率 {wr} · 已核 {summary.wins + summary.losses}（胜{" "}
              {summary.wins} / 负 {summary.losses}）
              {summary.pending > 0 ? ` · 待核 ${summary.pending}` : ""}
              {summary.flats > 0 ? ` · 平 ${summary.flats}` : ""}
              {failCount > 0 ? ` · 失败 ${failCount}` : ""}
              {summary.totalPnlPct != null
                ? ` · ${formatAlertTotalPnlPct(summary.totalPnlPct)}`
                : ""}
              {statusNote ? ` · ${statusNote}` : ""}
            </p>
            <p className="pattern-wr-rules">{ALERT_SETTLE_RULES_SUMMARY}</p>
          </div>
          <div className="pattern-wr-head-actions">
            {showCaptureToggle ? (
              <button
                type="button"
                className={`pattern-wr-toggle-yield pattern-wr-capture${captureEnabled ? " on" : ""}`}
                onClick={() => setPendingCapture(!captureEnabled)}
                title={
                  captureEnabled
                    ? "当前正在捕获新形态信号到顶部滚动条；点击可关闭"
                    : "当前已停止捕获新信号；点击可重新开启"
                }
              >
                信号捕捉：{captureEnabled ? "开" : "关"}
              </button>
            ) : null}
            <button
              type="button"
              className={`pattern-wr-toggle-yield${showEntryRules ? " on" : ""}`}
              onClick={() => setShowEntryRules((v) => !v)}
              title="查看各类型入场达成条件"
            >
              {showEntryRules ? "收起入场规则" : "入场规则"}
            </button>
            <button
              type="button"
              className={`pattern-wr-toggle-yield${hideYield ? " on" : ""}`}
              onClick={toggleHideYield}
              title={
                hideYield
                  ? "当前已隐藏收益率，单元格显示止盈/止损；悬停仍看结算价"
                  : "隐藏 +xx% (@杠杆) 收益率文案，改为止盈/止损"
              }
            >
              {hideYield ? "显示收益率" : "隐藏收益率"}
            </button>
            {canWriteStats ? (
              <>
                <button
                  type="button"
                  className="pattern-wr-retry selected"
                  disabled={retrying || selectedCount === 0}
                  onClick={() => void onReverifySelected()}
                  title="对勾选信号重新拉 K 线并核算"
                >
                  {retrying ? "重拉中…" : `重拉选中(${selectedCount})`}
                </button>
                {failCount > 0 ? (
                  <button
                    type="button"
                    className="pattern-wr-retry"
                    disabled={retrying}
                    onClick={() => void onRetryFails()}
                  >
                    {retrying ? "重试中…" : `重试失败(${failCount})`}
                  </button>
                ) : null}
              </>
            ) : null}
            <button type="button" className="pattern-wr-close" onClick={onClose}>
              关闭
            </button>
          </div>
        </header>

        {pendingCapture != null ? (
          <div
            className="pattern-wr-confirm"
            role="dialog"
            aria-modal="true"
            aria-label="确认切换信号捕捉"
          >
            <div className="pattern-wr-confirm-card">
              <p className="pattern-wr-confirm-title">
                {pendingCapture ? "确认开启信号捕捉？" : "确认关闭信号捕捉？"}
              </p>
              <p className="pattern-wr-confirm-body">
                {pendingCapture
                  ? "开启后，本机将继续把新形态信号写入顶部滚动条并同步后台。"
                  : "关闭后，本机不再把新 SSE 信号写入顶部滚动条；已有条目与胜率列表不受影响。"}
              </p>
              <div className="pattern-wr-confirm-actions">
                <button
                  type="button"
                  className="pattern-wr-confirm-cancel"
                  onClick={() => setPendingCapture(null)}
                >
                  取消
                </button>
                <button
                  type="button"
                  className={`pattern-wr-confirm-ok${pendingCapture ? "" : " danger"}`}
                  onClick={() => {
                    onCaptureEnabledChange?.(pendingCapture);
                    setPendingCapture(null);
                  }}
                >
                  确认{pendingCapture ? "开启" : "关闭"}
                </button>
              </div>
            </div>
          </div>
        ) : null}

        {showEntryRules ? (
          <section className="pattern-wr-entry-rules" aria-label="入场条件明细">
            <p className="pattern-wr-entry-rules-lead">
              列表「类型」对应的入场达成条件（与结构/蜡烛扫描代码一致；完整版见{" "}
              <code>SIGNAL_LOGIC.md §5.5</code>）。
            </p>
            <ul className="pattern-wr-entry-rules-list">
              {PATTERN_ENTRY_RULES.map((rule) => (
                <li key={rule.label} className="pattern-wr-entry-rule">
                  <div className="pattern-wr-entry-rule-head">
                    <strong>{rule.label}</strong>
                    <span
                      className={`pattern-wr-dir ${
                        rule.side === "多" ? "long" : rule.side === "空" ? "short" : "flat"
                      }`}
                    >
                      {rule.side}
                    </span>
                  </div>
                  <p className="pattern-wr-entry-rule-sum">{rule.summary}</p>
                  <ol>
                    {rule.conditions.map((c) => (
                      <li key={c}>{c}</li>
                    ))}
                  </ol>
                </li>
              ))}
            </ul>
          </section>
        ) : null}

        <div className="pattern-wr-filters">
          <div className="pattern-wr-time-filters" role="group" aria-label="时间筛选">
            <label className="pattern-wr-type-filter">
              <span>时间</span>
              <select
                value={filter}
                onChange={(e) => setFilter(e.target.value as AlertStatsTimeFilter)}
                aria-label="按时间范围筛选"
              >
                {TIME_FILTERS.map((f) => (
                  <option key={f.id} value={f.id}>
                    {f.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <label className="pattern-wr-type-filter">
            <span>类型</span>
            <select
              value={typeFilter}
              onChange={(e) => setTypeFilter(e.target.value)}
              aria-label="按信号类型筛选"
            >
              <option value="all">全部类型</option>
              {typeOptions.map((t) => (
                <option key={t.label} value={t.label}>
                  {formatAlertTypeOptionLabel(t)}
                </option>
              ))}
            </select>
          </label>
          <label className="pattern-wr-type-filter">
            <span>周期</span>
            <select
              value={intervalFilter}
              onChange={(e) => setIntervalFilter(e.target.value)}
              aria-label="按周期筛选"
            >
              <option value="all">全部周期</option>
              {intervalOptions.map((o) => (
                <option key={o.label} value={o.label}>
                  {formatIntervalOptionLabel(o)}
                </option>
              ))}
            </select>
          </label>
        </div>

        <div className="pattern-wr-table-wrap">
          {loadingList && rows.length === 0 ? (
            <p className="pattern-wr-empty">加载中…</p>
          ) : rows.length === 0 ? (
            <p className="pattern-wr-empty">该筛选下暂无信号</p>
          ) : (
            <table className="pattern-wr-table">
              <thead>
                <tr>
                  {canWriteStats ? (
                    <th className="pattern-wr-check-col">
                      <input
                        type="checkbox"
                        checked={allSelected}
                        onChange={toggleAll}
                        aria-label="全选当前列表"
                        title="全选当前列表"
                      />
                    </th>
                  ) : null}
                  <th>时间</th>
                  <th>币种</th>
                  <th>方向</th>
                  <th>类型</th>
                  <th>周期</th>
                  <th>入场</th>
                  <th>结果</th>
                  <th>回溯盈亏</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r) => {
                  const pnl = fmtPnl(r, hideYield);
                  const isOn = selected.has(r.key);
                  return (
                    <tr
                      key={r.key}
                      className={`${onOpenSymbol ? "clickable" : ""}${isOn ? " is-selected" : ""}`}
                    >
                      {canWriteStats ? (
                        <td
                          className="pattern-wr-check-col"
                          onClick={(e) => e.stopPropagation()}
                        >
                          <input
                            type="checkbox"
                            checked={isOn}
                            onChange={() => toggleOne(r.key)}
                            aria-label={`选择 ${r.symbol}`}
                          />
                        </td>
                      ) : null}
                      <td
                        className="mono"
                        onClick={() => onOpenSymbol?.(r.symbol, r.interval)}
                        title={onOpenSymbol ? `打开 ${r.symbol} 图表` : undefined}
                      >
                        {formatAlertStatsTime(r.signalAt)}
                      </td>
                      <td onClick={() => onOpenSymbol?.(r.symbol, r.interval)}>
                        <strong>${r.symbol}</strong>
                      </td>
                      <td onClick={() => onOpenSymbol?.(r.symbol, r.interval)}>
                        <span
                          className={`pattern-wr-dir ${
                            r.dir === "多" ? "long" : r.dir === "空" ? "short" : "flat"
                          }`}
                        >
                          {r.dir}
                        </span>
                      </td>
                      <td className="muted" onClick={() => onOpenSymbol?.(r.symbol, r.interval)}>
                        {r.typeLabel || "—"}
                      </td>
                      <td className="muted" onClick={() => onOpenSymbol?.(r.symbol, r.interval)}>
                        {r.interval || "—"}
                      </td>
                      <td className="mono" onClick={() => onOpenSymbol?.(r.symbol, r.interval)}>
                        {fmtPrice(r.entry)}
                      </td>
                      <td onClick={() => onOpenSymbol?.(r.symbol, r.interval)}>
                        <span className={`pattern-wr-out oc-${r.outcome}`}>
                          {outcomeLabel(r.outcome)}
                        </span>
                      </td>
                      <td
                        className={`mono ${pnl.cls}`}
                        title={pnl.title}
                        onClick={() => onOpenSymbol?.(r.symbol, r.interval)}
                      >
                        {pnl.text}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>

        <div className="pattern-wr-pager" aria-label="分页">
          <span className="pattern-wr-pager-meta">
            共 {total} 条 · 每页 {ALERT_STATS_PAGE_SIZE} · 第 {page}/{pages} 页
            {loadingList ? " · 加载中…" : ""}
          </span>
          <div className="pattern-wr-pager-btns">
            <button type="button" disabled={page <= 1 || loadingList} onClick={() => goPage(1)}>
              首页
            </button>
            <button type="button" disabled={page <= 1 || loadingList} onClick={() => goPage(page - 1)}>
              上一页
            </button>
            <button
              type="button"
              disabled={page >= pages || loadingList}
              onClick={() => goPage(page + 1)}
            >
              下一页
            </button>
            <button
              type="button"
              disabled={page >= pages || loadingList}
              onClick={() => goPage(pages)}
            >
              末页
            </button>
          </div>
        </div>

        <footer className="pattern-wr-foot">
          {canWriteStats
            ? "勾选后点「重拉选中」可按当前规则重算；列表长期保存于服务端，每页 100 条。"
            : "只读浏览 · 列表长期保存 · 每页 100 条（核实由本机产生端写入）。"}
        </footer>
      </div>
    </div>,
    document.body,
  );
});
