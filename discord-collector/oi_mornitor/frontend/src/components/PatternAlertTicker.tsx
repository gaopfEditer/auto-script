import { memo, useCallback, useEffect, useMemo, useRef, useState, type PointerEvent as ReactPointerEvent } from "react";
import { createPortal } from "react-dom";
import type { PatternAlert } from "../types";
import { formatAlertHoverDetail } from "../utils/alertHoverDetail";
import { isOiOperator } from "../utils/oiOperator";
import {
  loadAlertStats,
  outcomeLabel,
  formatAlertTotalPnlPct,
  summarizeAlertWinRate,
  syncAlertStatsFromServer,
  upsertAlertForStats,
  verifyDueAlertStats,
  type AlertOutcome,
  type AlertWinRateSummary,
} from "../utils/patternAlertWinRate";
import { displaySymbol } from "../utils/symbol";
import { PatternAlertWinRateModal } from "./PatternAlertWinRateModal";

interface TickerItem {
  id: string;
  key: string;
  alert: PatternAlert;
  /** 信号发生时间（毫秒） */
  signalAt: number;
  dir: "多" | "空" | "—";
  reason: string;
  /** 对齐 Telegram 的完整悬停文案 */
  detailText: string;
}

interface Props {
  alerts: PatternAlert[];
  scanTs: number;
  onOpen?: (symbol: string, interval?: string) => void;
}

/** 头部滚动条保留时长（按信号时间；超过 4h 不展示） */
const TICKER_TTL_MS = 4 * 60 * 60_000;
const TICKER_MAX = 40;
/** v4：修复 seen 挡回填；优先毫秒 close_time */
const TICKER_CACHE_KEY = "oi_pattern_alert_ticker_v4";
/** 顶部滚动条是否捕获新信号：缺省/非 "0" 视为开 */
const TICKER_CAPTURE_KEY = "oi_pattern_ticker_capture_v1";
const LEGACY_CACHE_KEYS = [
  "oi_pattern_alert_ticker_v3",
  "oi_pattern_alert_ticker_v2",
  "oi_pattern_alert_ticker_v1",
];

function readTickerCaptureEnabled(): boolean {
  try {
    return localStorage.getItem(TICKER_CAPTURE_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeTickerCaptureEnabled(on: boolean) {
  try {
    localStorage.setItem(TICKER_CAPTURE_KEY, on ? "1" : "0");
  } catch {
    /* ignore */
  }
}

type TickerCachePayload = {
  items: TickerItem[];
  savedAt: number;
};

type HoverTip = {
  text: string;
  dir: "多" | "空" | "—";
  x: number;
  y: number;
  place: "above" | "below";
};

/** 模块级内存缓存：同页内 Radar↔形态 切换也能立刻还原 */
let memoryTickerItems: TickerItem[] = [];

/** 统一成毫秒时间戳 */
function toSignalAtMs(raw: number, fallbackMs = Date.now()): number {
  let n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallbackMs;
  if (n < 1e12) n *= 1000;
  return n;
}

function alertSignalMs(a: PatternAlert, fallbackMs = Date.now()): number {
  // 按「信号发生时间」取：K 线/入场优先，扫描时间最后（避免回填时用 now 打乱顺序）
  const candidates = [
    a.kline_close_time,
    a.entry_time,
    a.time,
    a.kline_open_time,
    a.scan_ts,
  ];
  for (const c of candidates) {
    const n = Number(c);
    if (Number.isFinite(n) && n > 0) return toSignalAtMs(n, fallbackMs);
  }
  return fallbackMs;
}

/** 时间顺序：早 → 晚（左旧右新）；同秒再按 key 稳定排序 */
function sortTickerByTime(items: TickerItem[]): TickerItem[] {
  return [...items].sort((a, b) => {
    const dt = a.signalAt - b.signalAt;
    if (dt !== 0) return dt;
    return String(a.key || a.id).localeCompare(String(b.key || b.id));
  });
}

/** chip 上展示的信号发送时间 */
function formatChipSignalTime(ms: number): string {
  const d = new Date(ms);
  if (!Number.isFinite(d.getTime())) return "—";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString("zh-CN", {
      hour12: false,
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  }
  return d.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

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

function makeTickerItem(alert: PatternAlert, now = Date.now()): TickerItem {
  const key = alertKey(alert);
  const signalAt = alertSignalMs(alert, now);
  return {
    id: `${key}-${signalAt}`,
    key,
    alert,
    signalAt,
    dir: alertDirection(alert),
    reason: alertReason(alert),
    detailText: formatAlertHoverDetail(alert),
  };
}

function normalizeTickerItem(t: TickerItem, now = Date.now()): TickerItem {
  const signalAt = toSignalAtMs(t.signalAt, alertSignalMs(t.alert, now));
  return {
    ...t,
    key: t.key || alertKey(t.alert),
    signalAt,
    dir: t.dir || alertDirection(t.alert),
    reason: t.reason || alertReason(t.alert),
    detailText: t.detailText || formatAlertHoverDetail(t.alert),
  };
}

function pruneTickerItems(items: TickerItem[], now = Date.now()): TickerItem[] {
  const cutoff = now - TICKER_TTL_MS;
  return sortTickerByTime(
    items
      .map((t) => normalizeTickerItem(t, now))
      .filter((t) => t.signalAt > cutoff),
  ).slice(-TICKER_MAX); // 保留最近 TICKER_MAX 条，仍保持早→晚
}

function isTickerItem(v: unknown): v is TickerItem {
  if (!v || typeof v !== "object") return false;
  const t = v as TickerItem;
  return (
    typeof t.id === "string" &&
    typeof t.signalAt === "number" &&
    t.alert != null &&
    typeof t.alert === "object" &&
    typeof t.alert.symbol === "string"
  );
}

function persistTickerItems(items: TickerItem[]) {
  const pruned = pruneTickerItems(items);
  memoryTickerItems = pruned;
  try {
    const payload: TickerCachePayload = { items: pruned, savedAt: Date.now() };
    localStorage.setItem(TICKER_CACHE_KEY, JSON.stringify(payload));
    for (const k of LEGACY_CACHE_KEYS) localStorage.removeItem(k);
  } catch {
    /* quota / private mode — 内存仍保留 */
  }
  return pruned;
}

function mergeTickerLists(primary: TickerItem[], secondary: TickerItem[]): TickerItem[] {
  const byKey = new Map<string, TickerItem>();
  for (const it of secondary) byKey.set(it.key || alertKey(it.alert), it);
  for (const it of primary) byKey.set(it.key || alertKey(it.alert), it);
  return persistTickerItems([...byKey.values()]);
}

async function pullTickerFromServer(): Promise<TickerItem[]> {
  try {
    const res = await fetch("/api/pattern-alert-ticker", { cache: "no-store" });
    if (!res.ok) return [];
    const body = (await res.json()) as { ok?: boolean; items?: unknown[] };
    if (!body?.ok || !Array.isArray(body.items)) return [];
    return pruneTickerItems(body.items.filter(isTickerItem));
  } catch {
    return [];
  }
}

let pushTimer: number | null = null;

function pushTickerToServerDebounced(items: TickerItem[]) {
  if (typeof window === "undefined") return;
  if (pushTimer != null) window.clearTimeout(pushTimer);
  pushTimer = window.setTimeout(() => {
    pushTimer = null;
    void (async () => {
      try {
        const res = await fetch("/api/pattern-alert-ticker", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ items }),
        });
        if (!res.ok) return;
        const body = (await res.json()) as { ok?: boolean; items?: unknown[] };
        if (body?.ok && Array.isArray(body.items)) {
          mergeTickerLists(
            body.items.filter(isTickerItem),
            items,
          );
        }
      } catch {
        /* offline */
      }
    })();
  }, 800);
}

function loadTickerCache(): TickerItem[] {
  if (memoryTickerItems.length) {
    return pruneTickerItems(memoryTickerItems);
  }
  try {
    let raw = localStorage.getItem(TICKER_CACHE_KEY);
    if (!raw) {
      for (const k of LEGACY_CACHE_KEYS) {
        raw = localStorage.getItem(k);
        if (raw) break;
      }
    }
    if (!raw) return [];
    const parsed = JSON.parse(raw) as TickerCachePayload & { seen?: string[] };
    const items = pruneTickerItems(
      Array.isArray(parsed?.items) ? parsed.items.filter(isTickerItem) : [],
    );
    memoryTickerItems = items;
    // 升到 v4 并丢掉旧 seen 逻辑
    persistTickerItems(items);
    return items;
  } catch {
    return [];
  }
}

/**
 * 合并本轮 SSE 与缓存：
 * - 空数组不清空
 * - 已在列表中的 key 跳过（避免每轮重复）
 * - 不在列表中的 live 信号一律回填（修复旧 seen 挡死）
 */
function mergeFreshAlerts(
  prev: TickerItem[],
  alerts: PatternAlert[],
  now = Date.now(),
): TickerItem[] {
  const cutoff = now - TICKER_TTL_MS;
  const byKey = new Map<string, TickerItem>();
  for (const t of pruneTickerItems(prev, now)) {
    byKey.set(t.key || alertKey(t.alert), t);
  }

  for (const alert of alerts) {
    if (!alert?.symbol) continue;
    const key = alertKey(alert);
    if (byKey.has(key)) continue;
    const item = makeTickerItem(alert, now);
    if (item.signalAt <= cutoff) continue;
    byKey.set(key, item);
  }

  return pruneTickerItems([...byKey.values()], now);
}

function placeHoverTip(rect: DOMRect): { x: number; y: number; place: "above" | "below" } {
  const pad = 10;
  const tipW = 300;
  let x = rect.left + rect.width / 2;
  x = Math.min(Math.max(x, pad + tipW / 2), window.innerWidth - pad - tipW / 2);
  const spaceAbove = rect.top - pad;
  if (spaceAbove >= 120) {
    return { x, y: rect.top - 8, place: "above" };
  }
  return { x, y: rect.bottom + 8, place: "below" };
}

function registerItemsForStats(items: TickerItem[]) {
  for (const it of items) {
    upsertAlertForStats({
      key: it.key || alertKey(it.alert),
      alert: it.alert,
      signalAt: it.signalAt,
      dir: it.dir,
    });
  }
}

function outcomeByKeyMap(): Map<string, AlertOutcome> {
  const map = new Map<string, AlertOutcome>();
  for (const r of loadAlertStats()) map.set(r.key, r.outcome);
  return map;
}

export const PatternAlertTicker = memo(function PatternAlertTicker({
  alerts,
  scanTs,
  onOpen,
}: Props) {
  const operator = useMemo(() => isOiOperator(), []);
  const boot = useMemo(() => loadTickerCache(), []);
  const [captureEnabled, setCaptureEnabled] = useState(readTickerCaptureEnabled);
  const [items, setItems] = useState<TickerItem[]>(() => {
    if (operator) registerItemsForStats(boot);
    return boot;
  });
  const [hover, setHover] = useState<HoverTip | null>(null);
  const [winSummary, setWinSummary] = useState<AlertWinRateSummary>(() =>
    summarizeAlertWinRate(loadAlertStats()),
  );
  const [outcomes, setOutcomes] = useState<Map<string, AlertOutcome>>(() => outcomeByKeyMap());
  const [statsOpen, setStatsOpen] = useState(false);
  const alertsSigRef = useRef("");

  const setCaptureEnabledPersist = useCallback((on: boolean) => {
    writeTickerCaptureEnabled(on);
    setCaptureEnabled(on);
  }, []);

  const refreshStatsUi = useCallback(() => {
    setWinSummary(summarizeAlertWinRate(loadAlertStats()));
    setOutcomes(outcomeByKeyMap());
  }, []);

  const showTip = useCallback(
    (it: TickerItem, el: HTMLElement) => {
      const { x, y, place } = placeHoverTip(el.getBoundingClientRect());
      const oc = outcomes.get(it.key || alertKey(it.alert));
      const base = it.detailText || formatAlertHoverDetail(it.alert);
      const statsLine =
        oc && oc !== "pending"
          ? `\n--------\n核实结果: ${outcomeLabel(oc)}（信号后 3h · 卡片清算规则）`
          : `\n--------\n核实: 信号满 3 小时后按卡片规则核算（±5% · 主流100x/山寨20x）`;
      setHover({
        text: `${base}${statsLine}`,
        dir: it.dir,
        x,
        y,
        place,
      });
    },
    [outcomes],
  );

  const hideTip = useCallback(() => setHover(null), []);

  // 产生端：合并 SSE → 本地 → 推后台（可关捕捉）
  useEffect(() => {
    if (!operator || !captureEnabled) return;
    const list = Array.isArray(alerts) ? alerts : [];
    const sig = `${scanTs}|${list.map(alertKey).join(";")}`;
    if (sig === alertsSigRef.current && list.length === 0) return;
    alertsSigRef.current = sig;

    setItems((prev) => {
      const next = mergeFreshAlerts(prev, list);
      persistTickerItems(next);
      registerItemsForStats(next);
      pushTickerToServerDebounced(next);
      return next;
    });
    refreshStatsUi();
  }, [alerts, scanTs, refreshStatsUi, operator, captureEnabled]);

  // 两端：定时拉后台 ticker（后端扫描会落盘；捕捉开关只拦 SSE 合并）
  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      const remote = await pullTickerFromServer();
      if (cancelled || !remote.length) return;
      setItems((prev) => {
        const next = mergeTickerLists(remote, prev);
        if (operator) registerItemsForStats(next);
        return next;
      });
      if (operator) refreshStatsUi();
    };
    void pull();
    const id = window.setInterval(() => void pull(), 20_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [operator, refreshStatsUi]);

  // 产生端：启动清过期 + 定时回写（拉库见上）
  useEffect(() => {
    if (!operator) return;
    const tick = () => {
      setItems((prev) => {
        const next = pruneTickerItems(prev);
        if (next.length !== prev.length) persistTickerItems(next);
        else if (next.length) persistTickerItems(next);
        if (next.length) pushTickerToServerDebounced(next);
        return next.length === prev.length ? prev : next;
      });
    };
    tick();
    const id = window.setInterval(tick, 20_000);
    return () => window.clearInterval(id);
  }, [operator]);

  // 页签可见 / bfcache 回来时从内存+localStorage 拉回（产生端才核实）
  useEffect(() => {
    const restore = () => {
      if (document.hidden) return;
      if (operator) {
        const cached = loadTickerCache();
        setItems((prev) => {
          const byKey = new Map<string, TickerItem>();
          for (const it of cached) byKey.set(it.key || alertKey(it.alert), it);
          for (const it of prev) byKey.set(it.key || alertKey(it.alert), it);
          const merged = persistTickerItems([...byKey.values()]);
          registerItemsForStats(merged);
          pushTickerToServerDebounced(merged);
          return merged;
        });
        refreshStatsUi();
        void verifyDueAlertStats(setWinSummary).then(() => refreshStatsUi());
      } else {
        void pullTickerFromServer().then((remote) => {
          if (remote.length) setItems((prev) => mergeTickerLists(remote, prev));
        });
        void syncAlertStatsFromServer().then(() => refreshStatsUi());
      }
    };
    document.addEventListener("visibilitychange", restore);
    window.addEventListener("pageshow", restore);
    return () => {
      document.removeEventListener("visibilitychange", restore);
      window.removeEventListener("pageshow", restore);
    };
  }, [refreshStatsUi, operator]);

  // 后台共享信号库 → 本地；多端打开都能看到同一份 TG 推送记录
  useEffect(() => {
    let cancelled = false;
    void syncAlertStatsFromServer().then(() => {
      if (!cancelled) refreshStatsUi();
    });
    const id = window.setInterval(() => {
      void syncAlertStatsFromServer().then(() => {
        if (!cancelled) refreshStatsUi();
      });
    }, 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refreshStatsUi]);

  // 信号满 3h 后按卡片阶梯核实胜负（仅产生端）
  useEffect(() => {
    if (!operator) return;
    let cancelled = false;
    const run = async () => {
      if (document.hidden) return;
      await verifyDueAlertStats((s) => {
        if (!cancelled) setWinSummary(s);
      });
      if (!cancelled) refreshStatsUi();
    };
    void run();
    const id = window.setInterval(() => void run(), 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [refreshStatsUi, operator]);

  const row = useMemo(() => sortTickerByTime(items), [items]);
  const loop = row.length >= 3 ? [...row, ...row] : row;
  const animate = row.length >= 3;
  const trackRef = useRef<HTMLDivElement>(null);
  const offsetRef = useRef(0);
  const hoveringRef = useRef(false);
  const slidingRef = useRef(false);
  const suppressClickRef = useRef(false);
  const pointerStartXRef = useRef(0);
  const offsetAtPointerDownRef = useRef(0);
  const longPressTimerRef = useRef(0);
  const activePointerIdRef = useRef<number | null>(null);
  const [sliding, setSliding] = useState(false);

  const LONG_PRESS_MS = 380;

  const wrapOffset = useCallback((x: number) => {
    const track = trackRef.current;
    if (!track || !animate) return x;
    const half = track.scrollWidth / 2;
    if (half <= 0) return x;
    let next = x;
    while (next <= -half) next += half;
    while (next > 0) next -= half;
    return next;
  }, [animate]);

  const applyOffset = useCallback((x: number) => {
    const track = trackRef.current;
    if (!track) return;
    offsetRef.current = x;
    track.style.transform = `translate3d(${x}px,0,0)`;
  }, []);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = 0;
    }
  }, []);

  const endSliding = useCallback((el?: HTMLDivElement | null, pointerId?: number | null) => {
    clearLongPressTimer();
    if (!slidingRef.current && activePointerIdRef.current == null) return;
    slidingRef.current = false;
    setSliding(false);
    const pid = pointerId ?? activePointerIdRef.current;
    activePointerIdRef.current = null;
    if (el && pid != null) {
      try {
        el.releasePointerCapture(pid);
      } catch {
        /* ignore */
      }
    }
  }, [clearLongPressTimer]);

  // JS 跑马灯：悬停整条 / 滑动中暂停
  useEffect(() => {
    if (!animate) {
      applyOffset(0);
      return;
    }
    let raf = 0;
    let last = performance.now();
    const tick = (now: number) => {
      const dt = Math.min(48, now - last);
      last = now;
      if (!hoveringRef.current && !slidingRef.current) {
        const track = trackRef.current;
        const half = track ? track.scrollWidth / 2 : 0;
        const durationMs = Math.max(18, row.length * 4.5) * 1000;
        const speed = half > 0 ? half / durationMs : 0.04;
        applyOffset(wrapOffset(offsetRef.current - speed * dt));
      }
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [animate, row.length, applyOffset, wrapOffset]);

  useEffect(() => {
    if (!animate) applyOffset(0);
    else applyOffset(wrapOffset(offsetRef.current));
  }, [loop.length, animate, applyOffset, wrapOffset]);

  useEffect(() => () => clearLongPressTimer(), [clearLongPressTimer]);

  const onTickerPointerEnter = useCallback(() => {
    hoveringRef.current = true;
  }, []);

  const onTickerPointerLeave = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      hoveringRef.current = false;
      endSliding(e.currentTarget, e.pointerId);
    },
    [endSliding],
  );

  const onTickerPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (e.button !== 0) return;
      clearLongPressTimer();
      slidingRef.current = false;
      suppressClickRef.current = false;
      setSliding(false);
      pointerStartXRef.current = e.clientX;
      offsetAtPointerDownRef.current = offsetRef.current;
      activePointerIdRef.current = e.pointerId;
      const target = e.currentTarget;
      const pointerId = e.pointerId;
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = 0;
        if (activePointerIdRef.current !== pointerId) return;
        slidingRef.current = true;
        suppressClickRef.current = true;
        setSliding(true);
        hideTip();
        try {
          target.setPointerCapture(pointerId);
        } catch {
          /* ignore */
        }
      }, LONG_PRESS_MS);
    },
    [clearLongPressTimer, hideTip],
  );

  const onTickerPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      // 长按未触发前若明显移动，取消长按（避免误触滑动）
      if (!slidingRef.current) {
        if (Math.abs(e.clientX - pointerStartXRef.current) > 8) {
          clearLongPressTimer();
        }
        return;
      }
      const dx = e.clientX - pointerStartXRef.current;
      applyOffset(wrapOffset(offsetAtPointerDownRef.current + dx));
    },
    [applyOffset, wrapOffset, clearLongPressTimer],
  );

  const onTickerPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const wasSliding = slidingRef.current;
      clearLongPressTimer();
      endSliding(e.currentTarget, e.pointerId);
      if (wasSliding) {
        // 松手结束滑动；吞掉随后 click，避免误进图表
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
    },
    [clearLongPressTimer, endSliding],
  );

  const wrText =
    winSummary.winRate == null
      ? "胜率 —"
      : `胜率 ${(winSummary.winRate * 100).toFixed(0)}%`;
  const wrPnl =
    winSummary.totalPnlPct != null
      ? ` · ${formatAlertTotalPnlPct(winSummary.totalPnlPct)}`
      : "";
  const wrDetail = `已核 ${winSummary.wins + winSummary.losses} · 胜 ${winSummary.wins} / 负 ${winSummary.losses}${
    winSummary.pending ? ` · 待核 ${winSummary.pending}` : ""
  }${wrPnl}`;

  return (
    <div className="pattern-alert-ticker-wrap">
      <div
        className="pattern-alert-winrate"
        role="button"
        tabIndex={0}
        title={`双击查看信号列表与回溯盈亏\n形态信号胜率（对齐卡片清算）\nBTC/ETH/SOL 100x · 山寨 20x · 默认 ±5% TP/SL\n信号满 3 小时后核实\n${wrDetail}`}
        onDoubleClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          setStatsOpen(true);
        }}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            setStatsOpen(true);
          }
        }}
      >
        <strong>{wrText}</strong>
        <span>
          {winSummary.wins}胜/{winSummary.losses}负
          {winSummary.pending > 0 ? ` ·${winSummary.pending}待` : ""}
          {wrPnl}
        </span>
      </div>
      <PatternAlertWinRateModal
        open={statsOpen}
        onClose={() => setStatsOpen(false)}
        onStatsChange={refreshStatsUi}
        captureEnabled={captureEnabled}
        onCaptureEnabledChange={setCaptureEnabledPersist}
        onOpenSymbol={(sym, interval) => {
          setStatsOpen(false);
          onOpen?.(sym, interval);
        }}
      />
      {!row.length ? (
        <div className="pattern-alert-ticker is-empty" aria-live="polite">
          <span className="pattern-alert-ticker-placeholder">
            {operator && !captureEnabled ? "信号捕捉已关闭" : "暂无新信号"}
          </span>
        </div>
      ) : (
        <div
          className={`pattern-alert-ticker${animate ? " is-scroll" : ""}${sliding ? " is-sliding" : ""}`}
          aria-live="polite"
          aria-label="形态信号简讯：悬停暂停；点击币种打开图表；长按后左右滑动"
          onPointerEnter={onTickerPointerEnter}
          onPointerLeave={onTickerPointerLeave}
          onPointerDown={onTickerPointerDown}
          onPointerMove={onTickerPointerMove}
          onPointerUp={onTickerPointerUp}
          onPointerCancel={onTickerPointerUp}
        >
          <div ref={trackRef} className="pattern-alert-ticker-track">
            {loop.map((it, idx) => {
              const oc = outcomes.get(it.key || alertKey(it.alert));
              const ocClass =
                oc === "take_profit"
                  ? " outcome-win"
                  : oc === "stop_loss"
                    ? " outcome-loss"
                    : oc === "pending"
                      ? " outcome-pending"
                      : "";
              return (
                <button
                  key={`${it.id}-${idx}`}
                  type="button"
                  className={`pattern-alert-chip dir-${it.dir === "多" ? "long" : it.dir === "空" ? "short" : "flat"}${ocClass}`}
                  onMouseEnter={(e) => showTip(it, e.currentTarget)}
                  onMouseLeave={hideTip}
                  onFocus={(e) => showTip(it, e.currentTarget)}
                  onBlur={hideTip}
                  onClick={(e) => {
                    if (suppressClickRef.current || slidingRef.current) {
                      e.preventDefault();
                      e.stopPropagation();
                      return;
                    }
                    onOpen?.(
                      it.alert.symbol,
                      String(it.alert.interval || "").trim() || undefined,
                    );
                  }}
                >
                  <strong>{displaySymbol(it.alert.symbol)}</strong>
                  <em>{it.dir}</em>
                  <span className="pattern-alert-chip-time" title={it.reason}>
                    {formatChipSignalTime(it.signalAt)}
                  </span>
                  {oc && oc !== "pending" && oc !== "error" && (
                    <i className="pattern-alert-outcome">{outcomeLabel(oc)}</i>
                  )}
                </button>
              );
            })}
          </div>
          {hover &&
            createPortal(
              <div
                className={`pattern-alert-hover-tip place-${hover.place} dir-${hover.dir === "多" ? "long" : hover.dir === "空" ? "short" : "flat"}`}
                role="tooltip"
                style={{ left: hover.x, top: hover.y }}
              >
                {hover.text}
              </div>,
              document.body,
            )}
        </div>
      )}
    </div>
  );
});
