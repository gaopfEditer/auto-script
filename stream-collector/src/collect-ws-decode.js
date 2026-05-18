/**
 * collect / collector-ui-server 共用的 WS 帧解码与推送到前端的 payload 结构。
 */
import zlib from "node:zlib";

import { processBuffer } from "./processor.js";

/**
 * @param {Buffer} buf
 */
export function tryDecodeWsPayload(buf) {
  try {
    const t = buf.toString("utf8");
    const obj = JSON.parse(t);
    return { format: "json_utf8", obj, len: buf.length };
  } catch {
    try {
      const inflated = zlib.inflateSync(buf);
      const t = inflated.toString("utf8");
      const obj = JSON.parse(t);
      return { format: "json_zlib", obj, len: buf.length };
    } catch {
      try {
        const inflated = zlib.inflateRawSync(buf);
        const t = inflated.toString("utf8");
        const obj = JSON.parse(t);
        return { format: "json_zlib_raw", obj, len: buf.length };
      } catch {
        return {
          format: "opaque",
          len: buf.length,
          hexPreview: buf.subarray(0, 48).toString("hex"),
        };
      }
    }
  }
}

/**
 * 将 WS 帧 Buffer 转为可入库、可读的明文字符串（JSON 或 hex）。
 * @param {Buffer} buf
 */
export function bufferToPlainPayloadText(buf) {
  const decoded = tryDecodeWsPayload(buf);
  if ("obj" in decoded && decoded.obj !== undefined) {
    return JSON.stringify(decoded.obj);
  }
  const utf8 = buf.toString("utf8");
  if (utf8.length > 0 && !utf8.includes("\uFFFD")) {
    return utf8;
  }
  return buf.toString("hex");
}

/** @param {unknown} obj @param {number} [max] */
export function jsonWire(obj, max = 32000) {
  try {
    const s = JSON.stringify(obj);
    if (s.length <= max) return { json: obj, truncated: false };
    return { json: null, truncated: true, snippet: s.slice(0, max) };
  } catch {
    return { json: null, truncated: false, snippet: String(obj).slice(0, max) };
  }
}

/**
 * @param {Buffer} buf
 * @param {{ opcode?: number, pageUrl?: string, requestId?: string }} meta
 * @param {number} seq
 * @param {string[]} requiredTopLevelKeys
 * @returns {{ payload: Record<string, unknown>, proc: ReturnType<typeof processBuffer> }}
 */
export function buildFrameChannelPayload(buf, meta, seq, requiredTopLevelKeys) {
  const decoded = tryDecodeWsPayload(buf);
  const proc = processBuffer(buf, requiredTopLevelKeys);
  const parsedObj = "obj" in decoded && decoded.obj !== undefined ? decoded.obj : undefined;
  const body =
    parsedObj !== undefined
      ? jsonWire(parsedObj)
      : {
          json: null,
          truncated: false,
          snippet: "hexPreview" in decoded ? String(decoded.hexPreview) : null,
          rawLen: decoded.len,
        };

  const payload = {
    kind: "ws_frame",
    seq,
    opcode: meta.opcode,
    pageUrl: meta.pageUrl ?? "",
    requestId: meta.requestId ?? "",
    decodeFormat: decoded.format,
    len: buf.length,
    dbParseOk: proc.ok,
    dbParseError: proc.parseError,
    body,
  };
  return { payload, proc };
}
