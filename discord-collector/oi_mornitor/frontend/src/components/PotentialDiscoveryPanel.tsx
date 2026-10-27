import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { CoinAvatar } from "./CoinAvatar";
import { displaySymbol } from "../utils/symbol";
import { ModelPlaybookTooltip } from "./ModelPlaybookTooltip";
import { PageBootLoading } from "./PageBootLoading";
import type {
  PotentialDiscoveryCatalogEntry,
  PotentialDiscoveryItem,
  PotentialDiscoveryPayload,
  PotentialSignalOutcome,
} from "../types";

const FETCH_MS = 5 * 60 * 1000;

function modelSignalTime(m: {
  signal_time_utc8?: string | null;
  signal_tf?: string;
  tf?: string;
}): string {
  return m.signal_time_utc8?.trim() || "";
}

function modelSignalTf(m: { signal_tf?: string; tf?: string }): string {
  return (m.signal_tf || m.tf || "").trim();
}

function OutcomeBlock({ outcome }: { outcome?: PotentialSignalOutcome }) {
  if (!outcome) return null;
  if (outcome.pending) {
    const left =
      outcome.hours_left != null && Number.isFinite(outcome.hours_left)
        ? ` · 约 ${outcome.hours_left.toFixed(1)}h 后或衰竭/离池时结算`
        : "";
    return (
      <p className="potential-outcome pending">
        观察窗进行中（默认 12h）{left}
      </p>
    );
  }
  const mp = outcome.max_profit_pct;
  const md = outcome.max_drawdown_pct;
  const end = outcome.end_pnl_pct;
  const label = outcome.settle_label || "已评判";
  return (
    <p className="potential-outcome settled">
      <strong>{label}</strong>
      {mp != null ? ` · 最大盈利 +${mp}%` : ""}
      {md != null ? ` · 最大回撤 ${md}%` : ""}
      {end != null ? (
        <>
          {" "}
          · 窗末{" "}
          <span className={end >= 0 ? "pnl-up" : "pnl-down"}>
            {end >= 0 ? "+" : ""}
            {end}%
          </span>
        </>
      ) : null}
    </p>
  );
}

type Props = {
  onOpenSymbol: (symbol: string) => void;
};

export const PotentialDiscoveryPanel = memo(function PotentialDiscoveryPanel({
  onOpenSymbol,
}: Props) {
  const [payload, setPayload] = useState<PotentialDiscoveryPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [modelFilter, setModelFilter] = useState<string>("all");
  const [expandedEnd, setExpandedEnd] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const res = await fetch("/api/potential-discovery", { cache: "no-store" });
      if (!res.ok) return;
      const body = (await res.json()) as PotentialDiscoveryPayload;
      if (body?.ok) setPayload(body);
    } catch {
      /* ignore */
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load();
    const id = window.setInterval(() => void load(), FETCH_MS);
    return () => window.clearInterval(id);
  }, [load]);

  const catalog = payload?.catalog ?? [];
  const items = payload?.items ?? [];

  const catalogById = useMemo(() => {
    const m = new Map<string, PotentialDiscoveryCatalogEntry>();
    for (const c of catalog) m.set(c.id, c);
    return m;
  }, [catalog]);

  const filtered = useMemo(() => {
    if (modelFilter === "all") return items;
    return items.filter((it) =>
      (it.models ?? []).some((m) => m.id === modelFilter),
    );
  }, [items, modelFilter]);

  const updated = payload?.updated_utc8 ?? (payload?.updated_at
    ? new Date(payload.updated_at * 1000).toLocaleString("zh-CN", { hour12: false })
    : "—");
  const fastAt = payload?.fast_scan_at_utc8;
  const slowAt = payload?.slow_scan_at_utc8;

  return (
    <div className="potential-discovery">
      <header className="potential-discovery-head">
        <div>
          <h2>潜力发现</h2>
          <p className="pattern-hint-main">
            快扫约 15 分钟（M2 费率/OI、M5 打靶、M3 短线相对强弱）；慢扫约 1 小时（M1 OI 趋势、M4 箱体
            Spring）。二/三梯队偏小市值，请交叉验证并关注失效征兆。每条信号默认{" "}
            <strong>12h</strong> 观察窗（或阶段 <code>exiting</code> / 离池时提前结算），按方向统计{" "}
            <strong>最大盈利</strong>与<strong>最大回撤</strong>（15m K，入场=信号 K 收盘价）。
          </p>
        </div>
        <span className="potential-discovery-meta">
          更新 {updated}
          {fastAt ? ` · 快扫 ${fastAt}` : ""}
          {slowAt ? ` · 慢扫 ${slowAt}` : ""}
        </span>
      </header>

      <section className="potential-catalog-ref">
        <h3>模型说明与终结信号</h3>
        <p className="pattern-hint-main potential-catalog-hint">
          悬停模型卡片、筛选标签或下方列表内的模型名，可查看常见走势、注意事项与失效征兆。
        </p>
        <div className="potential-catalog-grid">
          {catalog.map((m) => (
            <ModelPlaybookTooltip key={m.id} catalog={m} className="potential-catalog-tip">
              <article className="potential-catalog-card">
                <h4>{m.label}</h4>
                <p>{m.summary}</p>
                <ul>
                  {(m.end_signals ?? []).map((s) => (
                    <li key={s}>
                      <strong>失效</strong> {s}
                    </li>
                  ))}
                </ul>
              </article>
            </ModelPlaybookTooltip>
          ))}
        </div>
      </section>

      <h3 className="potential-list-heading">扫描列表</h3>

      <div className="potential-discovery-filters" role="tablist">
        <button
          type="button"
          className={`potential-filter-chip${modelFilter === "all" ? " active" : ""}`}
          onClick={() => setModelFilter("all")}
        >
          全部
          {items.length > 0 && <em>{items.length}</em>}
        </button>
        {catalog.map((m) => (
          <ModelPlaybookTooltip key={m.id} catalog={m} className="potential-filter-tip">
            <button
              type="button"
              className={`potential-filter-chip${modelFilter === m.id ? " active" : ""}`}
              onClick={() => setModelFilter(m.id)}
            >
              {m.label}
            </button>
          </ModelPlaybookTooltip>
        ))}
      </div>

      {loading && !payload ? (
        <PageBootLoading
          inset={false}
          message="加载潜力发现…"
          hint="正在读取扫描快照与模型说明"
        />
      ) : filtered.length === 0 ? (
        <p className="pattern-hint-main">
          暂无满足阈值的标的（后台约 15 分钟快扫、1 小时慢扫）。列表门槛{" "}
          <code>OI_POTENTIAL_SCORE_LIST_MIN</code>
          {payload?.score_list_min != null ? `（当前 ${payload.score_list_min}）` : ""}
          ；与 <code>OI_POTENTIAL_DISCOVERY_MIN_SCORE</code> 是同一项（后者为兼容别名）。
          {payload?.soft_export_min != null && payload.soft_export_min > 0 ? (
            <>
              {" "}
              观察合并门槛 <code>OI_POTENTIAL_SOFT_EXPORT_MIN</code>（当前{" "}
              {payload.soft_export_min}）：单模型未 hit 但分数够高也会进列表，不等于 spec 全满足。
            </>
          ) : (
            <>
              {" "}
              若 <code>OI_POTENTIAL_SOFT_EXPORT_MIN=0</code>，只有五模型严格 hit 才会出现，多数时候会是空的。
            </>
          )}
          {payload?.scan_diagnostics?.fast || payload?.scan_diagnostics?.slow ? (
            <>
              {" "}
              上次扫描：
              {payload.scan_diagnostics.slow
                ? ` 慢扫评估 ${payload.scan_diagnostics.slow.evaluated} 币、严格命中 ${payload.scan_diagnostics.slow.model_hits ?? 0}、观察 ${payload.scan_diagnostics.slow.soft_merged ?? 0}`
                : ""}
              {payload.scan_diagnostics.fast
                ? ` · 快扫评估 ${payload.scan_diagnostics.fast.evaluated} 币、严格命中 ${payload.scan_diagnostics.fast.model_hits ?? 0}、观察 ${payload.scan_diagnostics.fast.soft_merged ?? 0}`
                : ""}
              {payload.scan_diagnostics.fast?.exported != null ||
              payload.scan_diagnostics.slow?.exported != null
                ? ` · 看板 ${Math.max(
                    payload.scan_diagnostics.fast?.exported ?? 0,
                    payload.scan_diagnostics.slow?.exported ?? 0,
                  )} 条`
                : ""}
              。
            </>
          ) : (
            <>
              {" "}
              若刚重启 collect:ui，请等首轮扫描或 <code>pnpm run oi:potential-scan</code>。
            </>
          )}
        </p>
      ) : (
        <div className="potential-discovery-grid">
          {filtered.map((it) => (
            <PotentialCard
              key={it.symbol}
              item={it}
              catalogById={catalogById}
              expandedEnd={expandedEnd}
              onToggleEnd={(sym) =>
                setExpandedEnd((prev) => (prev === sym ? null : sym))
              }
              onOpen={() => onOpenSymbol(it.symbol)}
            />
          ))}
        </div>
      )}
    </div>
  );
});

function PotentialCard({
  item,
  catalogById,
  expandedEnd,
  onToggleEnd,
  onOpen,
}: {
  item: PotentialDiscoveryItem;
  catalogById: Map<string, PotentialDiscoveryCatalogEntry>;
  expandedEnd: string | null;
  onToggleEnd: (sym: string) => void;
  onOpen: () => void;
}) {
  const sym = item.symbol;
  const showEnd = expandedEnd === sym;
  const cardTf = (item.signal_tf || item.tf || "").trim();
  const cardTime = item.signal_time_utc8?.trim() || "";
  const dir = item.direction || "neutral";
  const dirLabel =
    item.direction_label ||
    (dir === "long" ? "看多" : dir === "short" ? "看空" : "观望");
  return (
    <article className="potential-card">
      <button type="button" className="potential-card-main" onClick={onOpen}>
        <div className="potential-card-head">
          <CoinAvatar symbol={sym} size="sm" />
          <strong>${displaySymbol(sym)}</strong>
          <span className={`potential-tier tier-${item.mcap_tier || "t3"}`}>
            {item.mcap_tier?.toUpperCase() || "T3"}
          </span>
          <span className={`potential-direction dir-${dir}`}>{dirLabel}</span>
          <span className="potential-score" title="综合评分">
            {item.score}
          </span>
        </div>
        {item.stage ? (
          <span className={`potential-stage stage-${item.stage}`}>{item.stage}</span>
        ) : null}
        {item.score_summary || (item.score_reasons?.length ?? 0) > 0 ? (
          <div className="potential-score-block">
            {item.score_summary ? (
              <p className="potential-score-summary">{item.score_summary}</p>
            ) : null}
            {(item.score_reasons?.length ?? 0) > 0 ? (
              <ul className="potential-score-reasons">
                {(item.score_reasons ?? []).slice(0, 8).map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}
        {cardTf || cardTime ? (
          <dl
            className="potential-signal-dl"
            title="出现时间 = 该周期最近一根已收盘 K 的开盘时刻（北京时间）"
          >
            <div>
              <dt>周期</dt>
              <dd>{cardTf || "—"}</dd>
            </div>
            <div>
              <dt>出现</dt>
              <dd>
                {cardTime ? (
                  <time dateTime={String(item.signal_time_ms ?? "")}>{cardTime}</time>
                ) : (
                  <span className="potential-signal-pending">待下轮扫描补全</span>
                )}
              </dd>
            </div>
          </dl>
        ) : null}
        <OutcomeBlock outcome={item.outcome} />
        <div className="potential-model-chips">
          {(item.models ?? []).map((m) => (
            <ModelPlaybookTooltip
              key={m.id}
              catalog={catalogById.get(m.id)}
              stage={m.stage}
              signalTf={modelSignalTf(m)}
              signalTimeUtc8={modelSignalTime(m) || null}
            >
              <span className={`potential-model-chip model-${m.id}`}>
                {m.direction_label ? (
                  <span className={`potential-chip-dir dir-${m.direction || "neutral"}`}>
                    {m.direction_label}
                  </span>
                ) : null}
                {m.label}
                <em>{m.score}</em>
                {modelSignalTf(m) || modelSignalTime(m) ? (
                  <small className="potential-chip-signal">
                    {modelSignalTf(m) ? (
                      <span className="potential-chip-tf">{modelSignalTf(m)}</span>
                    ) : null}
                    {modelSignalTime(m) ? (
                      <span className="potential-chip-at">{modelSignalTime(m)}</span>
                    ) : (
                      <span className="potential-signal-pending">时间待补</span>
                    )}
                  </small>
                ) : null}
                {m.outcome && !m.outcome.pending ? (
                  <small className="potential-chip-outcome">
                    {m.outcome.settle_label ? `${m.outcome.settle_label} ` : ""}
                    {m.outcome.max_profit_pct != null
                      ? `盈+${m.outcome.max_profit_pct}%`
                      : ""}
                    {m.outcome.max_drawdown_pct != null
                      ? ` 回撤${m.outcome.max_drawdown_pct}%`
                      : ""}
                  </small>
                ) : null}
              </span>
            </ModelPlaybookTooltip>
          ))}
        </div>
        {item.entry ? <p className="potential-entry">{item.entry}</p> : null}
        {item.exit ? <p className="potential-exit">{item.exit}</p> : null}
        {!item.entry && (item.models?.[0]?.reasons?.length ?? 0) > 0 ? (
          <ul className="potential-reasons">
            {(item.models?.[0]?.reasons ?? []).slice(0, 2).map((r) => (
              <li key={r}>{r}</li>
            ))}
          </ul>
        ) : null}
      </button>
      <button
        type="button"
        className="potential-end-toggle"
        onClick={() => onToggleEnd(sym)}
      >
        {showEnd ? "收起失效征兆" : "失效征兆"}
      </button>
      {showEnd ? (
        <ul className="potential-end-list">
          {(item.models ?? []).flatMap((m) =>
            (m.end_signals ?? []).map((s) => (
              <li key={`${m.id}-${s}`}>
                <span className="potential-end-tag">{m.label}</span>
                {s}
              </li>
            )),
          )}
        </ul>
      ) : null}
    </article>
  );
}
