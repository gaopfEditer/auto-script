/**
 * 巨鲸 kolvip 实时 WebSocket（/api-v1/webu/ws?token=…）→ 与 HTTP 轮询共用 ingest。
 */
import WebSocket from "ws";
import { config } from "./config.js";
import { resolveKolvipApiWtoken } from "./kolvip-api-auth.js";
import { kolvipApiRawToDomMessage } from "./kolvip-api-message.js";
import { getKolvipMappingByKolvipId } from "./kolvip-cdp-config.js";
import { ingestKolvipMessageBatch } from "./kolvip-ingest.js";
import { cacheKolvipMessageAuthorAvatars } from "./kolvip-avatar-cache.js";

/**
 * @param {string} wtoken
 */
export function kolvipWebSocketUrl(wtoken) {
  const base = String(config.kolvipApiBaseUrl ?? "https://kolvip.vip/api-v1").replace(/\/$/, "");
  const wsBase = base.replace(/^http/i, "ws");
  return `${wsBase}/webu/ws?token=${encodeURIComponent(String(wtoken ?? "").trim())}`;
}

/**
 * @param {unknown} raw
 */
export function parseKolvipWsFrame(raw) {
  if (!raw || typeof raw !== "object") return { kind: "ignore" };
  const o = /** @type {{ type?: string, data?: Record<string, unknown> }} */ (raw);
  const type = String(o.type ?? "").trim().toLowerCase();
  if (type === "hb" || type === "ping") return { kind: "heartbeat" };
  if (type !== "msg" || !o.data || typeof o.data !== "object") return { kind: "ignore" };
  const dom = kolvipApiRawToDomMessage(/** @type {Record<string, unknown>} */ (o.data));
  if (!dom.dataId) return { kind: "ignore" };
  const kid = String(/** @type {{ channel_id?: unknown }} */ (o.data).channel_id ?? "").trim();
  if (!kid) return { kind: "ignore" };
  return { kind: "message", kolvipChannelId: kid, message: dom };
}

/**
 * @param {{
 *   store: ReturnType<typeof import("./store.js").openStore>,
 *   log: ReturnType<typeof import("./logger.js").createLogger>,
 *   broadcast?: (channel: string, payload: Record<string, unknown>) => void,
 *   signalCards: NonNullable<Parameters<typeof ingestKolvipMessageBatch>[0]["signalCards"]>,
 *   getSeen: () => Promise<Record<string, unknown>>,
 *   saveSeen: (seen: Record<string, unknown>) => Promise<void>,
 *   onReconnect?: () => void,
 * }} deps
 */
export function createKolvipWsService(deps) {
  const log = deps.log;
  const reconnectMs = Math.max(2000, Number(config.kolvipWsReconnectMs) || 5_000);

  /** @type {WebSocket | null} */
  let socket = null;
  let connecting = false;
  let stopped = false;
  let failStreak = 0;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let reconnectTimer = null;
  let connected = false;
  let lastMessageAt = 0;
  let messagesIngested = 0;
  let lastError = "";
  let hadConnectedOnce = false;

  function clearReconnect() {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
  }

  function scheduleReconnect(reason = "") {
    if (stopped || reconnectTimer) return;
    failStreak += 1;
    const delay = Math.min(120_000, reconnectMs * Math.min(failStreak, 12));
    log.warn(`巨鲸 WS ${delay}ms 后重连${reason ? `（${reason}）` : ""}`);
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connect();
    }, delay);
  }

  async function onWsMessage(text) {
    let parsed;
    try {
      parsed = JSON.parse(text);
    } catch {
      return;
    }
    const frame = parseKolvipWsFrame(parsed);
    if (frame.kind === "heartbeat") return;
    if (frame.kind !== "message") return;

    const mapping = getKolvipMappingByKolvipId(frame.kolvipChannelId);
    const seen = await deps.getSeen();
    try {
      await cacheKolvipMessageAuthorAvatars([frame.message], log);
      const result = await ingestKolvipMessageBatch({
        kolvipChannelId: frame.kolvipChannelId,
        channelName: mapping?.logicName ?? frame.kolvipChannelId,
        messages: [frame.message],
        mode: "live",
        curated: Boolean(mapping),
        seen,
        signalCards: deps.signalCards,
        store: deps.store,
        log,
        broadcast: deps.broadcast,
      });
      await deps.saveSeen(seen);
      lastMessageAt = Date.now();
      if (result.cardsCreated > 0 || result.messagesUpserted > 0) {
        messagesIngested += 1;
        deps.broadcast?.("meta", {
          kind: "kolvip_ws_message",
          kolvipChannelId: frame.kolvipChannelId,
          cardsCreated: result.cardsCreated,
          messagesUpserted: result.messagesUpserted,
        });
      }
    } catch (e) {
      log.warn(`巨鲸 WS ingest: ${/** @type {Error} */ (e).message}`);
    }
  }

  async function connect() {
    if (stopped || connecting) return;
    if (socket && (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING)) {
      return;
    }
    connecting = true;
    clearReconnect();
    try {
      const { wtoken, source } = await resolveKolvipApiWtoken(log);
      if (!wtoken) {
        lastError = "无 wtoken";
        connecting = false;
        scheduleReconnect("未配置 wtoken");
        return;
      }
      const url = kolvipWebSocketUrl(wtoken);
      const ws = new WebSocket(url);
      socket = ws;
      ws.on("open", () => {
        connecting = false;
        connected = true;
        failStreak = 0;
        lastError = "";
        log.info(`巨鲸 WS 已连接（token=${source}）`);
        if (hadConnectedOnce) {
          try {
            deps.onReconnect?.();
          } catch {
            /* ignore */
          }
        }
        hadConnectedOnce = true;
      });
      ws.on("message", (data) => {
        void onWsMessage(data.toString());
      });
      ws.on("close", (code) => {
        connecting = false;
        connected = false;
        if (socket === ws) socket = null;
        if (!stopped) scheduleReconnect(`close ${code}`);
      });
      ws.on("error", (err) => {
        lastError = String(/** @type {Error} */ (err).message ?? err);
        log.warn(`巨鲸 WS 错误: ${lastError}`);
      });
    } catch (e) {
      connecting = false;
      socket = null;
      lastError = /** @type {Error} */ (e).message;
      scheduleReconnect(lastError);
    }
  }

  function start() {
    if (!config.kolvipWsEnabled) return;
    stopped = false;
    void connect();
  }

  function stop() {
    stopped = true;
    clearReconnect();
    connected = false;
    try {
      socket?.close();
    } catch {
      /* ignore */
    }
    socket = null;
  }

  function isConnected() {
    return connected && socket?.readyState === WebSocket.OPEN;
  }

  function status() {
    return {
      enabled: config.kolvipWsEnabled,
      connected: isConnected(),
      connecting,
      lastMessageAt: lastMessageAt || null,
      messagesIngested,
      lastError: lastError || null,
      url: config.kolvipApiBaseUrl.replace(/\/$/, "") + "/webu/ws",
    };
  }

  return { start, stop, connect, isConnected, status };
}