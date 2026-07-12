import { ref, onMounted, onUnmounted } from "vue";

const status = ref("idle");
const error = ref("");
const lastMessageAt = ref(0);

/** @type {WebSocket | null} */
let ws = null;
/** @type {ReturnType<typeof setTimeout> | null} */
let reconnectTimer = null;
let reconnectAttempt = 0;
let started = false;

/** @type {Set<(msg: Record<string, unknown>) => void>} */
const handlers = new Set();

function wsUrl() {
  const proto = typeof location !== "undefined" && location.protocol === "https:" ? "wss:" : "ws:";
  return typeof location !== "undefined" ? `${proto}//${location.host}/ws` : "";
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

function scheduleReconnect() {
  if (reconnectTimer) return;
  const delay = Math.min(1000 * 2 ** reconnectAttempt, 15000);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect();
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
  console.info("[collector-ws] connecting", url);

  ws = new WebSocket(url);

  ws.onopen = () => {
    reconnectAttempt = 0;
    status.value = "open";
    error.value = "";
    console.info("[collector-ws] connected");
  };

  ws.onclose = () => {
    status.value = "closed";
    if (!error.value) error.value = "连接已断开，正在重连…";
    scheduleReconnect();
  };

  ws.onerror = () => {
    status.value = "error";
    error.value = "WebSocket 连接失败，请确认已运行 pnpm run collect:ui";
  };

  ws.onmessage = (ev) => {
    try {
      dispatch(JSON.parse(String(ev.data)));
    } catch {
      dispatch({ ts: Date.now(), channel: "?", kind: "parse_err", raw: ev.data });
    }
  };
}

/** 应用启动时调用，全局只连一条 WS */
export function ensureCollectorSocket() {
  if (started) return;
  started = true;
  connectCollectorSocket();
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
    reconnect: connectCollectorSocket,
  };
}
