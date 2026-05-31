/**
 * 应完全丢弃的 WS 帧（不入库、不推 UI、不记日志）。
 * Binance 组合流如 {"stream":"btcusdt@aggTrade","data":{...}}
 */

/** @type {Set<string>} */
const BLOCKED_WS_EVENT_TYPES = new Set([
  "24hrMiniTicker",
  "aggSnap",
  "aggTrade",
  "trade",
  "kline",
  "continuous_kline",
  "indexPriceKline",
  "markPriceKline",
  "depthUpdate",
  "markPriceUpdate",
  "forceOrder",
  "bookTicker",
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
function eventTypeOf(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = /** @type {Record<string, unknown>} */ (obj);
  if (typeof o.e === "string") return o.e;
  const data = o.data;
  if (data != null && typeof data === "object" && !Array.isArray(data)) {
    const e = /** @type {Record<string, unknown>} */ (data).e;
    if (typeof e === "string") return e;
  }
  return null;
}

/** @param {unknown} data */
function isBlockedDataArray(data) {
  if (!Array.isArray(data) || !data.length) return false;
  return data.every((item) => {
    if (item == null || typeof item !== "object" || Array.isArray(item)) return false;
    const e = /** @type {Record<string, unknown>} */ (item).e;
    return typeof e === "string" && BLOCKED_WS_EVENT_TYPES.has(e);
  });
}

/**
 * Binance 组合流 envelope：{ stream, data }。
 * Discord Gateway 不使用此结构，页面内嵌行情 WS 一律丢弃。
 * @param {Record<string, unknown>} o
 */
function isBlockedBinanceEnvelope(o) {
  const stream = typeof o.stream === "string" ? o.stream.trim() : "";
  if (stream && o.data !== undefined && o.data !== null) {
    return true;
  }
  if (stream && isBlockedStreamName(stream)) {
    return true;
  }
  if (isBlockedDataArray(o.data)) {
    return true;
  }
  return false;
}

/**
 * Discord Gateway 帧（op/t/d）永远放行，避免被行情/RPC 规则误伤。
 * @param {unknown} obj
 */
export function isDiscordGatewayPayload(obj) {
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

/**
 * 非 Discord 推送计数帧：{ pushType: 5, data: "{contentId,...}" }
 * @param {Record<string, unknown>} o
 */
function isBlockedPushEnvelope(o) {
  if (typeof o.pushType !== "number") return false;
  if (typeof o.data === "string" && o.data.includes("contentId")) return true;
  return o.pushType === 5;
}

/**
 * JSON-RPC / 订阅 ACK：{ result: ..., id: N } 或 { error: ..., id: N }
 * Discord Gateway 使用 { op, t, d }，不含此结构。
 * @param {Record<string, unknown>} o
 */
function isBlockedRpcEnvelope(o) {
  if (typeof o.op === "number") return false;
  if (o.id === undefined || o.id === null) return false;
  if ("result" in o || "error" in o) return true;
  return false;
}

/** @param {unknown} parsedJson */
function isBlockedObject(parsedJson) {
  if (parsedJson == null) return false;

  if (Array.isArray(parsedJson)) {
    if (!parsedJson.length) return false;
    return parsedJson.every((item) => isBlockedObject(item));
  }

  if (typeof parsedJson !== "object") return false;

  if (isDiscordGatewayPayload(parsedJson)) return false;

  const o = /** @type {Record<string, unknown>} */ (parsedJson);

  if (isBlockedWidgetHeartbeat(o)) {
    return true;
  }

  if (isBlockedWidgetEnvelope(o)) {
    return true;
  }

  if (isBlockedPushEnvelope(o)) {
    return true;
  }

  if (isBlockedRpcEnvelope(o)) {
    return true;
  }

  if (isBlockedBinanceEnvelope(o)) {
    return true;
  }

  const et = eventTypeOf(parsedJson);
  if (et && BLOCKED_WS_EVENT_TYPES.has(et)) return true;

  return false;
}

/** @param {string} text */
function rawTextLooksBlocked(text) {
  const t = String(text ?? "");
  // Discord Gateway 实时消息/事件，永不按原始文本丢弃
  if (/"op"\s*:\s*\d+/.test(t) && /"t"\s*:\s*"MESSAGE_(CREATE|UPDATE)"/.test(t)) {
    return false;
  }
  if (/"op"\s*:\s*\d+/.test(t) && /"t"\s*:\s*"/.test(t)) {
    return false;
  }
  if (t.includes('"pushType":5') || t.includes('"pushType": 5')) {
    return true;
  }
  // Binance/直播 widget：{"msgType":"HEART_BEAT"} 等
  if (/"msgType"\s*:\s*"/.test(t) && !/"op"\s*:/.test(t)) {
    return true;
  }
  // JSON-RPC ACK：{"result":...,"id":N}
  if (/"id"\s*:\s*\d+/.test(t) && (/"result"\s*:/.test(t) || /"error"\s*:/.test(t)) && !/"op"\s*:/.test(t)) {
    return true;
  }
  // Binance 组合流：{"stream":"xxx@yyy","data":...}
  if (/"stream"\s*:\s*"[^"]*@[^"]*"/.test(t) && /"data"\s*:/.test(t)) {
    return true;
  }
  for (const evt of BLOCKED_WS_EVENT_TYPES) {
    if (t.includes(`"e":"${evt}"`) || t.includes(`"e": "${evt}"`)) {
      return true;
    }
  }
  if (
    t.includes("24hrMiniTicker") ||
    t.includes("aggSnap") ||
    t.includes("aggTrade") ||
    t.includes("continuous_kline")
  ) {
    try {
      return isBlockedObject(JSON.parse(t));
    } catch {
      return true;
    }
  }
  return false;
}

/**
 * @param {unknown} parsedJson 解码后的 JSON（可为 undefined）
 * @param {string} [rawText] 原始 UTF-8 文本，解析失败时作兜底
 */
export function isBlockedWsPayload(parsedJson, rawText = "") {
  if (isBlockedObject(parsedJson)) return true;
  if (rawText && rawTextLooksBlocked(rawText)) return true;
  return false;
}
