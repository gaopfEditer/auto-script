import { ref, onMounted, onUnmounted } from "vue";

const status = ref("idle");
const error = ref("");
const lastMessageAt = ref(0);
/** 掉线起始时间戳；0 表示当前已连接 */
const disconnectedSince = ref(0);

/** 未连上超过此时长 → 首次静默刷新 */
const SILENT_REFRESH_FIRST_MS = 30_000;
/** 首次之后仍未连上 → 每隔此时长再静默刷新 */
const SILENT_REFRESH_EVERY_MS = 5 * 60_000;
/** 断线超过此时长 → UI 明显提示 */
export const WS_DISCONNECT_WARN_MS = 5 * 60_000;

/** App 监听此事件做 RouterView 软挂载（非整页 reload） */
export const COLLECTOR_WS_REFRESH_EVENT = "collector-ws-silent-refresh";

/** @type {WebSocket | null} */
let ws = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimer = null;
let reconnectAttempt = 0;
let started = false;

/** @type {ReturnType<typeof setTimeout> | null} */
let refreshWatchTimer = null;
/** 本次掉线起始时间；0 表示当前视为已连接 */
let downSince = 0;
/** 本轮掉线是否已做过 30s 首次静默刷新 */
let didFirstSilentRefresh = false;

/** @type {Set<(msg: Record<string, unknown>) => void>} */
const handlers = new Set();

function wsUrl() {
  const proto = typeof location !== "undefined" && location.protocol === "https:" ? "wss:" : "ws:";
  return typeof location !== "undefined" ? `${proto}//${location.host}/ws` : "";
}

function isWsOpen() {
  return Boolean(ws && ws.readyState === WebSocket.OPEN);
}

/** @param {Record<string, unknown>} msg */
function dispatch(msg) {
  lastMessageAt.value = Date.now();
  for (const h of handlers) {
    try {
      h(msg);
    } catch (e) {
      console.error("[collector-ws] handler error", e);
    }
  }
}

function clearReconnectTimer() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
}

function clearRefreshWatch() {
  if (refreshWatchTimer) {
    clearTimeout(refreshWatchTimer);
    refreshWatchTimer = null;
  }
}

function markConnected() {
  downSince = 0;
  disconnectedSince.value = 0;
  didFirstSilentRefresh = false;
  clearRefreshWatch();
}

function markDisconnected() {
  if (!downSince) {
    downSince = Date.now();
    disconnectedSince.value = downSince;
  }
  armSilentRefreshWatch();
}

function armSilentRefreshWatch() {
  clearRefreshWatch();
  if (isWsOpen() || status.value === "open") {
    markConnected();
    return;
  }
  if (!downSince) {
    downSince = Date.now();
    disconnectedSince.value = downSince;
  }

  const elapsed = Date.now() - downSince;
  const delay = !didFirstSilentRefresh
    ? Math.max(200, SILENT_REFRESH_FIRST_MS - elapsed)
    : SILENT_REFRESH_EVERY_MS;

  refreshWatchTimer = setTimeout(() => {
    refreshWatchTimer = null;
    if (isWsOpen() || status.value === "open") {
      markConnected();
      return;
    }
    didFirstSilentRefresh = true;
    silentRefresh();
    armSilentRefreshWatch();
  }, delay);
}

/** 强制重连 WS，并通知 App 软刷新视图（不 location.reload） */
export function silentRefreshCollectorSocket() {
  console.info(
    "[collector-ws] silent refresh · down=%ss",
    downSince ? Math.round((Date.now() - downSince) / 1000) : 0,
  );
  clearReconnectTimer();
  try {
    if (ws) {
      ws.onclose = null;
      ws.onerror = null;
      ws.onopen = null;
      ws.onmessage = null;
      ws.close();
    }
  } catch {
    /* ignore */
  }
  ws = null;
  status.value = "closed";
  connectCollectorSocket();
  if (typeof window !== "undefined") {
    window.dispatchEvent(new CustomEvent(COLLECTOR_WS_REFRESH_EVENT));
  }
}

function silentRefresh() {
  silentRefreshCollectorSocket();
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connectCollectorSocket();
  }, delay);
}

export function connectCollectorSocket() {
  if (typeof WebSocket === "undefined" || !wsUrl()) return;

  if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
    return;
  }

  try {
    ws?.close();
  } catch {
    /* ignore */
  }

  const url = wsUrl();
  status.value = "connecting";
  error.value = "";
  markDisconnected();
  console.info("[collector-ws] connecting", url);

  ws = new WebSocket(url);

  ws.onopen = () => {
    reconnectAttempt = 0;
    status.value = "open";
    error.value = "";
    markConnected();
    console.info("[collector-ws] connected");
  };

  ws.onclose = () => {
    status.value = "closed";
    if (!error.value) error.value = "连接已断开，正在重连…";
    markDisconnected();
    scheduleReconnect();
  };

  ws.onerror = () => {
    status.value = "error";
    error.value = "WebSocket 连接失败，请确认已运行 pnpm run collect:ui";
    markDisconnected();
  };

  ws.onmessage = (ev) => {
    try {
      dispatch(JSON.parse(String(ev.data)));
    } catch {
      dispatch({ ts: Date.now(), channel: "?", kind: "parse_err", raw: ev.data });
    }
  };
}

/** 应用启动时调用，全局只连一条 WS（/content 独立页跳过） */
export function ensureCollectorSocket() {
  if (typeof location !== "undefined") {
    const p = location.pathname || "";
    if (p === "/content" || p.startsWith("/content/")) return;
  }
  if (started) return;
  started = true;
  connectCollectorSocket();
  markDisconnected();
}

/**
 * 立即注册 WS 回调（不依赖组件 onMounted）。
 * @param {(msg: Record<string, unknown>) => void} handler
 * @returns {() => void}
 */
export function subscribeCollectorSocket(handler) {
  ensureCollectorSocket();
  handlers.add(handler);
  return () => handlers.delete(handler);
}

/**
 * @param {(msg: Record<string, unknown>) => void} [onMessage]
 */
export function useCollectorSocket(onMessage) {
  ensureCollectorSocket();

  if (typeof onMessage === "function") {
    onMounted(() => {
      handlers.add(onMessage);
    });
    onUnmounted(() => {
      handlers.delete(onMessage);
    });
  }

  return {
    status,
    error,
    lastMessageAt,
    disconnectedSince,
    reconnect: connectCollectorSocket,
    silentRefresh: silentRefreshCollectorSocket,
  };
}
