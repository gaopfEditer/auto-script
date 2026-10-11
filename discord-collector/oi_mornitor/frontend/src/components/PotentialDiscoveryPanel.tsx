import { memo, useCallback, useEffect, useMemo, useState } from "react";
import { CoinAvatar } from "./CoinAvatar";
import { displaySymbol } from "../utils/symbol";
import { ModelPlaybookTooltip } from "./ModelPlaybookTooltip";
import type {
  PotentialDiscoveryCatalogEntry,
  PotentialDiscoveryItem,
  PotentialDiscoveryPayload,
} from "../types";

const FETCH_MS = 5 * 60 * 1000;

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
            Spring）。二/三梯队偏小市值，请交叉验证并关注失效征兆。
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
        <p className="pattern-hint-main">加载扫描结果…</p>
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
  return (
    <article className="potential-card">
      <button type="button" className="potential-card-main" onClick={onOpen}>
        <div className="potential-card-head">
          <CoinAvatar symbol={sym} size="sm" />
          <strong>${displaySymbol(sym)}</strong>
          <span className={`potential-tier tier-${item.mcap_tier || "t3"}`}>
            {item.mcap_tier?.toUpperCase() || "T3"}
          </span>
          <span className="potential-score">{item.score}</span>
        </div>
        {item.stage ? (
          <span className={`potential-stage stage-${item.stage}`}>{item.stage}</span>
        ) : null}
        <div className="potential-model-chips">
          {(item.models ?? []).map((m) => (
            <ModelPlaybookTooltip
              key={m.id}
              catalog={catalogById.get(m.id)}
              stage={m.stage}
            >
              <span className={`potential-model-chip model-${m.id}`}>
                {m.label}
                <em>{m.score}</em>
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
