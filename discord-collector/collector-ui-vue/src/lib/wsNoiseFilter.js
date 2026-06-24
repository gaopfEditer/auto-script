/** 前端兜底：与后端 ws-noise-filter.js 逻辑一致 */

const BLOCKED_WS_EVENT_TYPES = new Set([
  "24hrMiniTicker",
  "aggSnap",
  "aggTrade",
  "trade",
  "kline",
  "continuous_kline",
]);

/** @param {string} stream */
function isBlockedStreamName(stream) {
  const s = String(stream ?? "").toLowerCase();
  if (!s) return false;
  if (
    s.includes("miniticker@arr") ||
    s.includes("!miniticker") ||
    s.includes("@miniticker") ||
    s.includes("@aggtrade") ||
    s.includes("@trade") ||
    s.includes("kline") ||
    s.includes("@depth") ||
    s.includes("@markprice") ||
    s.includes("_perpetual@") ||
    s.includes("@continuous")
  ) {
    return true;
  }
  for (const evt of BLOCKED_WS_EVENT_TYPES) {
    const e = evt.toLowerCase();
    if (s.includes(`@${e}`) || s.includes(e)) return true;
  }
  return false;
}

/** @param {unknown} obj */
function isDiscordGatewayPayload(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return false;
  return typeof /** @type {Record<string, unknown>} */ (obj).op === "number";
}

/** @param {Record<string, unknown>} o */
function isBlockedWidgetEnvelope(o) {
  const t = String(o.msgType ?? o.msg_type ?? "").trim();
  if (!t) return false;
  if (typeof o.op === "number") return false;
  if (o.id != null && o.channel_id != null) return false;
  return true;
}

/** @param {Record<string, unknown>} o */
function isBlockedWidgetHeartbeat(o) {
  const t = String(o.msgType ?? o.msg_type ?? "");
  return t === "HEART_BEAT" || t === "HEARTBEAT";
}

/** @param {Record<string, unknown>} o */
function isBlockedPushEnvelope(o) {
  if (typeof o.pushType !== "number") return false;
  if (typeof o.data === "string" && o.data.includes("contentId")) return true;
  return o.pushType === 5;
}

/** @param {Record<string, unknown>} o */
function isBlockedRpcEnvelope(o) {
  if (typeof o.op === "number") return false;
  if (o.id === undefined || o.id === null) return false;
  if ("result" in o || "error" in o) return true;
  return false;
}

/** @param {Record<string, unknown>} o */
function isBlockedBinanceEnvelope(o) {
  const stream = typeof o.stream === "string" ? o.stream.trim() : "";
  if (stream && o.data !== undefined && o.data !== null) return true;
  if (stream && isBlockedStreamName(stream)) return true;
  return false;
}

/** Socket.IO / TradingView ~m~ / ~h~ 帧 */
function isUnforwardableWsRawText(rawText = "") {
  const t = String(rawText ?? "").trim();
  return t.startsWith("~m~") || t.startsWith("~h~");
}

/** @param {Record<string, unknown>} msg WS frame 广播消息 */
export function isForwardableWsFrameMessage(msg) {
  if (msg?.kind !== "ws_frame") return true;
  const body = msg.body;
  if (!body || typeof body !== "object") return false;
  if (/** @type {{ json?: unknown }} */ (body).json == null) return false;
  return !isBlockedWsFrame(/** @type {{ json?: unknown }} */ (body).json);
}

/** @param {unknown} parsedJson */
export function isBlockedWsFrame(parsedJson) {
  if (parsedJson == null) return false;

  if (Array.isArray(parsedJson)) {
    return parsedJson.length > 0 && parsedJson.every((item) => isBlockedWsFrame(item));
  }

  if (typeof parsedJson !== "object") return false;

  if (isDiscordGatewayPayload(parsedJson)) return false;

  const o = /** @type {Record<string, unknown>} */ (parsedJson);

  if (isBlockedWidgetHeartbeat(o)) return true;
  if (isBlockedWidgetEnvelope(o)) return true;
  if (isBlockedPushEnvelope(o)) return true;
  if (isBlockedRpcEnvelope(o)) return true;
  if (isBlockedBinanceEnvelope(o)) return true;

  if (typeof o.e === "string" && BLOCKED_WS_EVENT_TYPES.has(o.e)) return true;

  const data = o.data;
  if (data != null && typeof data === "object" && !Array.isArray(data)) {
    const e = /** @type {Record<string, unknown>} */ (data).e;
    if (typeof e === "string" && BLOCKED_WS_EVENT_TYPES.has(e)) return true;
  }

  return false;
}
