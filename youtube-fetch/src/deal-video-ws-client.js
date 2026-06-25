/**
 * deal-video WebSocket 客户端：连接上游任务分发，收到 deal_video_task 后入队拉取文稿。
 *
 * 连接：ws://host:port/api/ws?type=deal-video
 * 流程：welcome → connected(deviceInfo) → deal_video_task → 入队
 */
import os from "node:os";

/**
 * @param {string} wsUrl
 */
function toWebSocketCtor(wsUrl) {
  if (wsUrl.startsWith("https://")) return wsUrl.replace(/^https:/, "wss:");
  if (wsUrl.startsWith("http://")) return wsUrl.replace(/^http:/, "ws:");
  return wsUrl;
}

/**
 * @param {{
 *   wsUrl: string,
 *   enabled: boolean,
 *   clientName: string,
 *   analyzeOnTask: boolean,
 *   reconnectMs: number,
 *   reportResult: boolean,
 *   log: ReturnType<typeof import('./logger.js').createLogger>,
 *   onTask: (task: { videoUrl: string, meta: unknown, timestamp?: string }) => Promise<{ ok: boolean, videoId?: string, title?: string | null, error?: string, skipped?: boolean }>,
 * }} opts
 */
export function createDealVideoWsClient(opts) {
  const { wsUrl, enabled, clientName, analyzeOnTask, reconnectMs, reportResult, log, onTask } = opts;
  /** @type {import('ws').WebSocket | null} */
  let ws = null;
  /** @type {string | null} */
  let clientId = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let reconnectTimer = null;
  let stopped = false;

  const url = toWebSocketCtor(wsUrl);

  function send(payload) {
    if (!ws || ws.readyState !== 1) return false;
    try {
      ws.send(JSON.stringify(payload));
      return true;
    } catch (e) {
      log.warn(`WS 发送失败: ${/** @type {Error} */ (e).message}`);
      return false;
    }
  }

  function deviceInfo() {
    return {
      name: clientName,
      hostname: os.hostname(),
      platform: process.platform,
      nodeVersion: process.version,
      clientType: "deal-video",
      service: "youtube-fetch",
      analyzeOnTask,
    };
  }

  function sendConnected() {
    send({ type: "connected", clientId, deviceInfo: deviceInfo() });
    log.info(`已上报 connected clientId=${clientId ?? "—"}`);
  }

  /**
   * @param {Record<string, unknown>} msg
   */
  async function handleMessage(msg) {
    const type = String(msg.type ?? "");

    if (type === "welcome") {
      clientId = msg.clientId != null ? String(msg.clientId) : clientId;
      log.info(`收到 welcome clientId=${clientId ?? "—"}`);
      sendConnected();
      return;
    }

    if (type === "deal_video_task") {
      const videoUrl = String(msg.videoUrl ?? "").trim();
      const meta = msg.meta ?? null;
      const timestamp = msg.timestamp != null ? String(msg.timestamp) : undefined;
      if (!videoUrl) {
        log.warn("deal_video_task 缺少 videoUrl");
        return;
      }
      log.info(`收到 deal_video_task url=${videoUrl.slice(0, 120)}`);
      try {
        const result = await onTask({ videoUrl, meta, timestamp });
        if (reportResult) {
          send({
            type: "deal_video_result",
            clientId,
            clientType: "deal-video",
            videoUrl,
            meta,
            timestamp: new Date().toISOString(),
            ...result,
          });
        }
      } catch (e) {
        const err = String(/** @type {Error} */ (e).message ?? e);
        log.warn(`deal_video_task 处理失败: ${err}`);
        if (reportResult) {
          send({
            type: "deal_video_result",
            clientId,
            clientType: "deal-video",
            videoUrl,
            ok: false,
            error: err,
            timestamp: new Date().toISOString(),
          });
        }
      }
    }
  }

  function scheduleReconnect() {
    if (stopped || reconnectTimer) return;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      connect();
    }, reconnectMs);
  }

  async function connect() {
    if (!enabled || stopped) return;
    if (ws && (ws.readyState === 0 || ws.readyState === 1)) return;

    try {
      const { default: WebSocket } = await import("ws");
      log.info(`连接 deal-video WS: ${url}`);
      ws = new WebSocket(url);

      ws.on("open", () => {
        log.info("deal-video WebSocket 已连接");
      });

      ws.on("message", (raw) => {
        let msg;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          log.debug(`WS 非 JSON: ${String(raw).slice(0, 120)}`);
          return;
        }
        void handleMessage(msg).catch((e) => {
          log.warn(`处理 WS 消息失败: ${/** @type {Error} */ (e).message}`);
        });
      });

      ws.on("close", (code, reason) => {
        log.warn(`deal-video WS 断开 code=${code} reason=${String(reason || "")}`);
        ws = null;
        scheduleReconnect();
      });

      ws.on("error", (err) => {
        log.warn(`deal-video WS 错误: ${err.message}`);
      });
    } catch (e) {
      log.warn(`deal-video WS 连接失败: ${/** @type {Error} */ (e).message}`);
      scheduleReconnect();
    }
  }

  function start() {
    if (!enabled) {
      log.info("deal-video WebSocket 未启用（DEAL_VIDEO_WS_ENABLED=0）");
      return;
    }
    stopped = false;
    void connect();
  }

  function stop() {
    stopped = true;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (ws) {
      ws.removeAllListeners();
      ws.close();
      ws = null;
    }
  }

  return { start, stop, send, getClientId: () => clientId };
}
