import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useSearchParams } from "react-router-dom";
import type {
  ChartAlertEntryFocus,
  EquityPoolItem,
  EquityPatternState,
  MoonshotItem,
  PatternAlert,
  PatternPayload,
  PatternState,
  PatternWatchItem,
} from "../types";
import { displaySymbol, humanBaseAsset } from "../utils/symbol";
import { CoinAvatar } from "../components/CoinAvatar";
import { MercuHeader } from "../components/MercuHeader";
import { PatternChartPanel } from "../components/PatternChartPanel";
import { PatternAlertTicker } from "../components/PatternAlertTicker";
import { CardLifecyclePanel } from "../components/CardLifecyclePanel";
import { useRadarSSE } from "../hooks/useRadarSSE";
import { useSpecialFocus } from "../hooks/useSpecialFocus";

const STATUS_CLASS: Record<string, string> = {
  SEARCHING_TOP: "pat-search",
  EXPIRED: "pat-expired",
};

const EQUITY_TAG_LABEL: Record<string, string> = {
  "crypto-proxy": "crypto-proxy",
  beta: "beta",
  macro: "macro",
};

const MOONSHOT_CLASS: Record<string, string> = {
  COMPRESS: "ms-compress",
  WAIT_HL: "ms-wait",
  LH_NEAR: "ms-lh",
  READY_BREAK: "ms-ready",
  IN_POSITION: "ms-hold",
  FIND_TOP: "ms-top",
  INVALID: "ms-invalid",
};

export const PatternMonitorPage = memo(function PatternMonitorPage() {
  const { snapshot, online, patchPattern } = useRadarSSE();
  const [searchParams, setSearchParams] = useSearchParams();
  const pattern = snapshot.pattern;
  const [input, setInput] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");
  const [selectedSymbol, setSelectedSymbol] = useState<string | null>(null);
  /** 从信号 chip / 胜率列表打开图表时带上的周期 */
  const [chartPreferredTf, setChartPreferredTf] = useState<string | null>(null);
  const [chartTfNonce, setChartTfNonce] = useState(0);
  /** 形态信号列表点开时，在 K 线上标出入场点 */
  const [chartAlertFocus, setChartAlertFocus] = useState<ChartAlertEntryFocus | null>(null);
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number; symbol: string } | null>(null);
  /** 本页是否已做过「进入默认选中」；用户手动关掉图表后不再强选 */
  const didAutoSelectRef = useRef(false);

  const watchlist: PatternWatchItem[] = pattern?.watchlist ?? [];
  const states: PatternState[] = pattern?.states ?? [];
  const alerts: PatternAlert[] = pattern?.pattern_alerts ?? [];
  const watchSet = useMemo(
    () => new Set(watchlist.map((w) => w.symbol.toUpperCase())),
    [watchlist],
  );
  const scanTs = pattern?.scan_ts ?? snapshot.scan_ts;
  const maxWatchSymbols = pattern?.max_watch_symbols ?? 50;
  const cardOrders = pattern?.card_orders ?? [];
  const activeCardSymbols = useMemo(() => {
    const set = new Set<string>();
    for (const o of cardOrders) {
      if (["watching", "near", "ordered", "filled"].includes(String(o.status))) {
        const s = String(o.symbol || "").trim().toUpperCase();
        if (s) set.add(s);
      }
    }
    return set;
  }, [cardOrders]);

  /** 左侧列表：置顶 → 进行中持仓 → 其余（按 symbol 排序） */
  const moonshotBySym = useMemo(() => {
    const map = pattern?.moonshot_by_symbol;
    if (map && typeof map === "object") return map as Record<string, MoonshotItem>;
    const out: Record<string, MoonshotItem> = {};
    for (const m of pattern?.moonshot ?? []) {
      if (m?.symbol) out[String(m.symbol).toUpperCase()] = m;
    }
    return out;
  }, [pattern?.moonshot, pattern?.moonshot_by_symbol]);

  const equityEnabled = Boolean(pattern?.equity_enabled);
  const equityPool: EquityPoolItem[] = pattern?.equity_pool ?? [];
  const equityStatesBySym = useMemo(() => {
    const map = new Map<string, EquityPatternState>();
    for (const st of pattern?.equity_states ?? []) {
      const sym = String(st.symbol || "").trim().toUpperCase();
      if (sym) map.set(sym, st);
    }
    return map;
  }, [pattern?.equity_states]);

  const sortedWatchlist = useMemo(() => {
    const pinned: PatternWatchItem[] = [];
    const trading: PatternWatchItem[] = [];
    const rest: PatternWatchItem[] = [];
    for (const w of watchlist) {
      const sym = String(w.symbol || "").trim().toUpperCase();
      if (w.pinned) pinned.push(w);
      else if (activeCardSymbols.has(sym)) trading.push(w);
      else rest.push(w);
    }
    const bySymbol = (a: PatternWatchItem, b: PatternWatchItem) =>
      String(a.symbol || "").localeCompare(String(b.symbol || ""), undefined, { sensitivity: "base" });
    rest.sort(bySymbol);
    trading.sort(bySymbol);
    return [...pinned, ...trading, ...rest];
  }, [watchlist, activeCardSymbols]);

  const [cardLifeOpen, setCardLifeOpen] = useState(false);
  const [cardPriceBusy, setCardPriceBusy] = useState(false);

  const refreshCardPrices = useCallback(async () => {
    setCardPriceBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/cards/prices", { method: "POST" });
      const data = await res.json();
      if (!data.ok && data.error) {
        setErr(data.error || "卡片市价刷新失败");
        return;
      }
      patchPattern({
        card_orders: data.card_orders,
        card_price_ts: data.card_price_ts ?? data.ts,
      } as Partial<PatternPayload>);
    } catch {
      setErr("卡片市价刷新网络错误");
    } finally {
      setCardPriceBusy(false);
    }
  }, [patchPattern]);

  const addSymbol = useCallback(
    async (symbolOverride?: string) => {
      const sym = (symbolOverride ?? input).trim().toUpperCase();
      if (!sym) return false;
      setBusy(true);
      setErr("");
      try {
        const res = await fetch("/api/patterns/watch", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ symbol: sym, manual: true }),
        });
        const data = await res.json();
        if (!data.ok) {
          setErr(data.error || "添加失败");
          return false;
        }
        if (!symbolOverride) setInput("");
        setSelectedSymbol(sym);
        if (Array.isArray(data.watchlist)) {
          patchPattern({
            watchlist: data.watchlist,
            ...(data.manual_slot_symbol !== undefined
              ? { manual_slot_symbol: data.manual_slot_symbol }
              : {}),
          });
        }
        return true;
      } catch {
        setErr("网络错误");
        return false;
      } finally {
        setBusy(false);
      }
    },
    [input, patchPattern],
  );

  // 雷达榜单 / Toast → /patterns?symbol=XXX[&add=1]
  useEffect(() => {
    const raw = searchParams.get("symbol");
    if (!raw) return;
    const sym = raw.trim().toUpperCase();
    if (!sym) return;
    didAutoSelectRef.current = true;
    setSelectedSymbol(sym);
    const wantAdd = searchParams.get("add") === "1";
    const next = new URLSearchParams(searchParams);
    next.delete("symbol");
    next.delete("add");
    setSearchParams(next, { replace: true });
    if (wantAdd && !watchSet.has(sym)) {
      void addSymbol(sym);
    }
    // 仅响应 URL 变化；勿把 watchSet/addSymbol 放进 deps 以免重复加
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchParams]);

  // 进入形态页：默认选中左侧列表第一个币种（展示 K 线）
  useEffect(() => {
    if (didAutoSelectRef.current) return;
    if (searchParams.get("symbol")) return;
    if (selectedSymbol) {
      didAutoSelectRef.current = true;
      return;
    }
    const first = sortedWatchlist[0]?.symbol;
    if (!first) return;
    didAutoSelectRef.current = true;
    setSelectedSymbol(first);
  }, [sortedWatchlist, selectedSymbol, searchParams]);

  const removeSymbol = useCallback(async (symbol: string, e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setBusy(true);
    setErr("");
    try {
      const res = await fetch(`/api/patterns/watch?symbol=${encodeURIComponent(symbol)}`, {
        method: "DELETE",
      });
      const data = await res.json();
      if (!data.ok) {
        setErr(data.error || "移除失败");
        return;
      }
      const nextWatch: PatternWatchItem[] = Array.isArray(data.watchlist)
        ? data.watchlist
        : watchlist.filter((w) => w.symbol !== symbol);
      patchPattern({
        watchlist: nextWatch,
        states: states.filter((s) => s.symbol !== symbol),
      });
      if (selectedSymbol === symbol) setSelectedSymbol(null);
    } catch {
      setErr("网络错误");
    } finally {
      setBusy(false);
    }
  }, [selectedSymbol, watchlist, states, patchPattern]);

  const openWatchCtxMenu = useCallback((e: React.MouseEvent, symbol: string) => {
    e.preventDefault();
    e.stopPropagation();
    setCtxMenu({ x: e.clientX, y: e.clientY, symbol });
  }, []);

  const pinSymbolToTop = useCallback(async (symbol: string, pinned: boolean) => {
    setCtxMenu(null);
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/patterns/watch/pin", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol, pinned }),
      });
      const data = await res.json();
      if (!data.ok) {
        setErr(data.error || (pinned ? "置顶失败" : "取消置顶失败"));
        return;
      }
      if (Array.isArray(data.watchlist)) {
        patchPattern({ watchlist: data.watchlist });
      }
    } catch {
      setErr("网络错误");
    } finally {
      setBusy(false);
    }
  }, [patchPattern]);

  const togglePin = useCallback(
    (symbol: string, currentlyPinned: boolean, e?: React.MouseEvent) => {
      e?.stopPropagation();
      e?.preventDefault();
      void pinSymbolToTop(symbol, !currentlyPinned);
    },
    [pinSymbolToTop],
  );

  useEffect(() => {
    if (!ctxMenu) return;
    const close = () => setCtxMenu(null);
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") close();
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("scroll", close, true);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("scroll", close, true);
      window.removeEventListener("keydown", onKey);
    };
  }, [ctxMenu]);

  const randomPick = useCallback(async () => {
    setBusy(true);
    setErr("");
    try {
      const res = await fetch("/api/patterns/random", { method: "POST" });
      const data = await res.json();
      if (!data.ok) setErr(data.error || "随机挑选失败");
      else setSelectedSymbol(null);
    } catch {
      setErr("网络错误");
    } finally {
      setBusy(false);
    }
  }, []);

  const { symbols: focusSymbols, add: addFocus, remove: removeFocus, has: hasFocus } =
    useSpecialFocus();

  const autoPickCount = pattern?.auto_pick_count ?? 50;
  const heavyPool = pattern?.heavyweight_pool_size ?? 0;
  const selectedState = states.find((s) => s.symbol === selectedSymbol);
  const selectedTicker = selectedSymbol
    ? snapshot.all_tickers.find((t) => t.symbol === selectedSymbol)
    : undefined;

  useEffect(() => {
    if (!chartAlertFocus || !selectedSymbol) return;
    const a = humanBaseAsset(chartAlertFocus.symbol);
    const b = humanBaseAsset(selectedSymbol);
    if (a && b && a !== b) setChartAlertFocus(null);
  }, [selectedSymbol, chartAlertFocus]);

  return (
    <div className="mercu-app pattern-app">
      <MercuHeader
        online={online}
        scanTs={scanTs}
        poolMeta={snapshot.pool_meta}
        poolSize={snapshot.pool_size}
        focusSymbols={focusSymbols}
        onRemoveFocus={(sym) => void removeFocus(sym)}
      />

      <div className="pattern-layout">
        <aside className="pattern-sidebar panel" data-onboard="oi-sidebar">
          <h2>形态追踪</h2>
          <p className="pattern-desc">
            上限 {maxWatchSymbols} · 每{" "}
            {Math.round((pattern?.watchlist_refresh_sec ?? 7200) / 3600)} 小时热钱刷新{" "}
            {autoPickCount} 个；雷达「涨幅∩持仓」「OI 异动∩多榜」即时入池；已进场与沙盒持仓保留 ·
            点击查看 K 线
          </p>

          <div className="pattern-toolbar">
            <button type="button" className="pattern-random-btn" onClick={randomPick} disabled={busy}>
              热钱重选
            </button>
            <span className="pattern-pool-hint">大象池 {heavyPool} 个</span>
          </div>

          <div className="pattern-add">
            <input
              type="text"
              placeholder="手动看盘 · 如 BTCUSDT"
              value={input}
              onChange={(e) => setInput(e.target.value.toUpperCase())}
              onKeyDown={(e) => e.key === "Enter" && void addSymbol()}
              disabled={busy}
              title="占用 1 个手动专用槽；再次输入会替换上一个手动币，列表满也可添加"
            />
            <button type="button" onClick={() => void addSymbol()} disabled={busy || !input.trim()}>
              添加
            </button>
          </div>
          {err && <p className="pattern-err">{err}</p>}
          <p className="pattern-meta">
            已监听 {watchlist.length} / {maxWatchSymbols}
            {(pattern?.manual_reserved_slots ?? 1) > 0
              ? `（含手动槽 1 · 当前 ${pattern?.manual_slot_symbol || "空"}）`
              : ""}
            ；排序：置顶 → 持仓 → 潜力分 → 其他
            {pattern?.moonshot_enabled
              ? ` · 暴涨漏斗 A池 ${pattern.moonshot_a_pool_size ?? 0}${pattern.moonshot_full_scan ? " ·全市场扫" : ""}`
              : ""}
          </p>

          {equityEnabled && sortedWatchlist.length > 0 ? (
            <p className="pattern-group-label">加密</p>
          ) : null}
          <ul className="pattern-watchlist">
            {sortedWatchlist.length === 0 ? (
              <li className="pattern-empty">
                {equityEnabled
                  ? "等待雷达扫描后按合约流入 / OI 爆发自动挑选…"
                  : "等待雷达扫描后按合约流入 / OI 爆发自动挑选…"}
              </li>
            ) : (
              sortedWatchlist.map((w) => {
                const st = states.find((s) => s.symbol === w.symbol);
                const ms = moonshotBySym[String(w.symbol || "").toUpperCase()];
                const msCls = ms?.state ? MOONSHOT_CLASS[ms.state] : "";
                const cls =
                  msCls ||
                  STATUS_CLASS[st?.status ?? "SEARCHING_TOP"] ||
                  "pat-search";
                const active = selectedSymbol === w.symbol;
                const pinned = Boolean(w.pinned);
                const isManual = Boolean(w.manual) || w.slot === "manual";
                const entered = activeCardSymbols.has(String(w.symbol || "").trim().toUpperCase());
                const pinHours =
                  pinned && (w.pin_remaining_sec ?? 0) > 0
                    ? Math.max(1, Math.ceil((w.pin_remaining_sec ?? 0) / 3600))
                    : 0;
                const statusText =
                  ms?.state_label ||
                  ms?.state ||
                  st?.status_label ||
                  st?.status ||
                  "—";
                return (
                  <li
                    key={w.symbol}
                    className={`pattern-watch-item ${cls}${active ? " active" : ""}${pinned ? " pinned" : ""}${entered ? " entered" : ""}${isManual ? " manual-slot" : ""}`}
                    data-entered={entered ? "1" : undefined}
                    data-manual={isManual ? "1" : undefined}
                    role="button"
                    tabIndex={0}
                    title={
                      [
                        isManual ? "手动输入槽" : "",
                        entered ? "卡片进行中" : "",
                        pinned ? `已置顶，约剩 ${pinHours} 小时` : "",
                        ms
                          ? `潜力 ${ms.state_label || ms.state}${(ms.reasons || []).length ? ` · ${(ms.reasons || []).join(" / ")}` : ""}`
                          : "点击查看 K 线",
                      ]
                        .filter(Boolean)
                        .join(" · ")
                    }
                    onClick={() => {
                      setSelectedSymbol(w.symbol);
                    }}
                    onContextMenu={(e) => openWatchCtxMenu(e, w.symbol)}
                    onKeyDown={(e) => e.key === "Enter" && setSelectedSymbol(w.symbol)}
                  >
                    <div className="pattern-watch-head">
                      <CoinAvatar symbol={w.symbol} size="sm" />
                      <span className="pattern-sym">${displaySymbol(w.symbol)}</span>
                      {isManual ? (
                        <span className="pattern-manual-badge" title="手动输入专用槽">
                          手动
                        </span>
                      ) : null}
                      {entered ? (
                        <span className="pattern-entered-badge" title="卡片进行中">
                          卡片
                        </span>
                      ) : null}
                      <button
                        type="button"
                        className={`pattern-pin-btn${pinned ? " on" : ""}`}
                        onClick={(e) => togglePin(w.symbol, pinned, e)}
                        disabled={busy}
                        title={
                          pinned
                            ? `已置顶${pinHours > 0 ? ` · 约剩 ${pinHours}h` : ""}，再点取消`
                            : "置顶至少 1 天"
                        }
                        aria-label={pinned ? "取消置顶" : "置顶"}
                        aria-pressed={pinned}
                      >
                        置顶
                      </button>
                      <button
                        type="button"
                        className="pattern-rm"
                        onClick={(e) => removeSymbol(w.symbol, e)}
                        disabled={busy}
                        aria-label="移除"
                      >
                        ×
                      </button>
                    </div>
                    <div className="pattern-status">{statusText}</div>
                    {st?.message && <div className="pattern-msg">{st.message}</div>}
                  </li>
                );
              })
            )}
          </ul>

          {equityEnabled ? (
            <>
              <p className="pattern-group-label">
                币股 · {equityPool.length}
                {pattern?.equity_scan_ts
                  ? ` · ${new Date(pattern.equity_scan_ts * 1000).toLocaleTimeString("zh-CN", { hour12: false })}`
                  : ""}
              </p>
              <ul className="pattern-watchlist pattern-equity-list">
                {equityPool.length === 0 ? (
                  <li className="pattern-empty">白名单匹配中（按 24h 成交额入池，OI 非必须）…</li>
                ) : (
                  equityPool.map((item) => {
                    const sym = String(item.symbol || "").trim();
                    const active = selectedSymbol === sym;
                    const est = equityStatesBySym.get(sym.toUpperCase());
                    const tag = EQUITY_TAG_LABEL[item.ui_tag || ""] || item.ui_tag || "";
                    const ivText = (est?.intervals || []).join("/") || "1h/4h";
                    return (
                      <li
                        key={sym}
                        className={`pattern-watch-item pat-equity${active ? " active" : ""}${est?.session_ok === false ? " session-off" : ""}`}
                        role="button"
                        tabIndex={0}
                        title={[
                          tag,
                          item.oi_available && item.oi_usd != null
                            ? `OI $${Math.round(item.oi_usd).toLocaleString()}`
                            : "OI 非必须",
                          est?.session_ok === false ? "非美股时段（仅标注）" : "",
                        ]
                          .filter(Boolean)
                          .join(" · ")}
                        onClick={() => setSelectedSymbol(sym)}
                        onKeyDown={(e) => e.key === "Enter" && setSelectedSymbol(sym)}
                      >
                        <div className="pattern-watch-head">
                          <CoinAvatar symbol={sym} size="sm" />
                          <span className="pattern-sym">${displaySymbol(sym)}</span>
                          {tag ? (
                            <span className="pattern-equity-tag">{tag}</span>
                          ) : null}
                        </div>
                        <div className="pattern-status">
                          {ivText}
                          {item.oi_available && item.oi_usd != null
                            ? ` · OI $${(item.oi_usd / 1e6).toFixed(1)}M`
                            : ""}
                        </div>
                      </li>
                    );
                  })
                )}
              </ul>
            </>
          ) : null}
        </aside>

        <main className="pattern-main panel" data-onboard="oi-main">
          <div className="pattern-main-head">
            <div className="pattern-main-tabs" role="tablist">
              <span className="pattern-main-tab active" role="tab" aria-selected={!selectedSymbol}>
                形态预警流
                {alerts.length > 0 && <em>{alerts.length}</em>}
              </span>
              <button
                type="button"
                className="pattern-random-btn"
                onClick={() => setCardLifeOpen(true)}
              >
                卡片看板
                {activeCardSymbols.size > 0 && <em>{activeCardSymbols.size}</em>}
              </button>
            </div>
            <PatternAlertTicker
              alerts={alerts}
              scanTs={scanTs}
              onOpen={(sym, interval, focus) => {
                setSelectedSymbol(sym);
                setChartPreferredTf(interval || null);
                setChartTfNonce((n) => n + 1);
                setChartAlertFocus(focus ?? null);
              }}
            />
            <span className="pattern-scan">
              {selectedSymbol
                ? `K 线 · $${displaySymbol(selectedSymbol)}`
                : `最近扫描 ${scanTs ? new Date(scanTs * 1000).toLocaleTimeString("zh-CN") : "—"}`}
            </span>
          </div>

          {selectedSymbol ? (
            <PatternChartPanel
              symbol={selectedSymbol}
              preferredTimeframe={chartPreferredTf}
              preferredTimeframeNonce={chartTfNonce}
              alertFocus={chartAlertFocus}
              alertFocusNonce={chartTfNonce}
              state={selectedState}
              liveTicker={selectedTicker}
              onClose={() => {
                setSelectedSymbol(null);
                setChartPreferredTf(null);
                setChartAlertFocus(null);
              }}
              onTitleContextMenu={openWatchCtxMenu}
              inWatchlist={watchSet.has(selectedSymbol.toUpperCase())}
              addWatchBusy={busy}
              onAddToWatchlist={(sym) => void addSymbol(sym)}
            />
          ) : (
                <div className="pattern-flow pattern-tab-panel">
                  <p className="pattern-hint-main">
                    ← 点击左侧币种查看 15m K 线与蜡烛/结构标注；新信号见顶栏滚动条（形态卡片、结构、量价等）。
                  </p>
                  {alerts.length > 0 && (
                    <section className="pattern-section">
                      <h3>本轮扫描告警</h3>
                      <div className="pattern-card-grid">
                        {alerts.map((a) => (
                          <button
                            key={`${a.symbol}-${a.kline_close_time}-${a.type}`}
                            type="button"
                            className="pattern-alert-card watch"
                            onClick={() => setSelectedSymbol(a.symbol)}
                          >
                            <div className="pattern-alert-card-head">
                              <CoinAvatar symbol={a.symbol} size="sm" />
                              <strong>${displaySymbol(a.symbol)}</strong>
                              <span className="pattern-alert-badge">
                                {a.type_label || a.status_label || a.type}
                              </span>
                            </div>
                            {a.message && <p className="pattern-alert-card-msg">{a.message}</p>}
                          </button>
                        ))}
                      </div>
                    </section>
                  )}
                </div>
          )}
        </main>
      </div>

      <CardLifecyclePanel
        open={cardLifeOpen}
        orders={cardOrders}
        priceTs={pattern?.card_price_ts}
        onClose={() => setCardLifeOpen(false)}
        onSelectSymbol={(sym) => {
          setSelectedSymbol(sym);
          setCardLifeOpen(false);
        }}
        onRefreshPrices={() => void refreshCardPrices()}
        refreshing={cardPriceBusy}
      />

      {ctxMenu && (
        <div
          className="pattern-ctx-menu"
          style={{ left: ctxMenu.x, top: ctxMenu.y }}
          role="menu"
          onMouseDown={(e) => e.stopPropagation()}
        >
          {(() => {
            const item = watchlist.find((w) => w.symbol === ctxMenu.symbol);
            const pinned = Boolean(item?.pinned);
            const focused = hasFocus(ctxMenu.symbol);
            return (
              <>
                <button
                  type="button"
                  role="menuitem"
                  disabled={busy}
                  onClick={() => void pinSymbolToTop(ctxMenu.symbol, !pinned)}
                >
                  {pinned
                    ? `取消置顶 $${displaySymbol(ctxMenu.symbol)}`
                    : `置顶 $${displaySymbol(ctxMenu.symbol)}（至少 1 天）`}
                </button>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => {
                    setCtxMenu(null);
                    void (focused ? removeFocus(ctxMenu.symbol) : addFocus(ctxMenu.symbol));
                  }}
                >
                  {focused
                    ? `取消特别关注 $${displaySymbol(ctxMenu.symbol)}`
                    : `特别关注 $${displaySymbol(ctxMenu.symbol)}`}
                </button>
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
});

