import { shallowRef } from "vue";

const MAX_NET = 500;
const MAX_MISC = 280;

const NET_MERGE_KINDS = new Set([
  "net_request",
  "net_response",
  "net_finished",
  "net_failed",
  "net_response_body",
  "ws_created",
  "ws_handshake_request",
  "ws_handshake_response",
]);

/** @param {string} url */
export function nameFromUrl(url) {
  const s = String(url ?? "");
  try {
    const u = new URL(s);
    const p = `${u.pathname}${u.search}`;
    if (p && p !== "/") return p.length > 96 ? `${p.slice(0, 94)}…` : p;
    return u.host || s.slice(0, 96);
  } catch {
    return s.length > 96 ? `${s.slice(0, 94)}…` : s;
  }
}

/** @param {unknown} n */
export function formatBytes(n) {
  if (n == null || Number.isNaN(Number(n))) return "—";
  const v = Number(n);
  if (v <= 0) return "—";
  if (v < 1024) return `${v} B`;
  if (v < 1024 * 1024) return `${(v / 1024).toFixed(1)} KB`;
  return `${(v / (1024 * 1024)).toFixed(2)} MB`;
}

/** @param {{ status?: number, phase?: string, failed?: boolean, wsFrame?: boolean, parseError?: string }} row */
export function displayStatus(row) {
  if (row.wsFrame) return row.parseError ? "(fail)" : "JSON";
  if (row.failed || row.phase === "failed") return "(failed)";
  if (row.status != null && row.status !== "") return String(row.status);
  return "…";
}

/** @param {string} s */
export function statusPillClass(s) {
  if (s === "JSON") return "st-2";
  if (s === "…" || s === "(failed)" || s === "(fail)") return s === "(failed)" || s === "(fail)" ? "st-fail" : "st-pending";
  const n = Number(s);
  if (Number.isNaN(n)) return "st-fail";
  if (n >= 200 && n < 300) return "st-2";
  if (n >= 300 && n < 400) return "st-3";
  if (n >= 400 && n < 500) return "st-4";
  if (n >= 500) return "st-5";
  return "st-other";
}

/**
 * 将 CDP 网络类事件按 requestId 合并为 DevTools「网络」表一行。
 */
export function useDebugNetwork() {
  /** @type {Map<string, Record<string, unknown>>} */
  const byId = new Map();
  let order = 0;
  const netRows = shallowRef(/** @type {Record<string, unknown>[]} */ ([]));
  const miscEvents = shallowRef(/** @type {Record<string, unknown>[]} */ ([]));

  function flushNet() {
    netRows.value = Array.from(byId.values())
      .sort((a, b) => Number(b._ord) - Number(a._ord))
      .slice(0, MAX_NET);
  }

  /** @param {Record<string, unknown>} msg */
  function pushMisc(msg) {
    miscEvents.value = [msg, ...miscEvents.value].slice(0, MAX_MISC);
  }

  /** @param {string} id @returns {Record<string, unknown>} */
  function ensureRow(id) {
    let r = byId.get(id);
    if (!r) {
      r = { requestId: id, _ord: ++order };
      byId.set(id, r);
    }
    return r;
  }

  /** @param {Record<string, unknown>} msg */
  function ingest(msg) {
    const ch = String(msg.channel ?? "");
    const k = String(msg.kind ?? "");

    if (ch === "frame") {
      pushMisc(msg);
      return;
    }

    if (k === "ws_frame_parsed" && msg.requestId != null && msg.frameSeq != null) {
      const connId = String(msg.requestId);
      const rowKey = `wsf|${connId}|${Number(msg.frameSeq)}`;
      const r = ensureRow(rowKey);
      r.rowKind = "ws_frame";
      r.requestId = rowKey;
      r.connectionRequestId = connId;
      r.name = `WS 帧 #${msg.frameSeq}`;
      r.url = String(msg.pageUrl ?? "") || `ws:${connId}`;
      r.method = `op${msg.opcode}`;
      r.resourceType = "WS-Frame";
      r.initiator = String(msg.decodePath ?? "");
      if (msg.bodyLen != null) r.transferSize = Number(msg.bodyLen);
      r.parsedJson = msg.parsedJson;
      r.parseError = msg.parseError;
      r.rawPreview = msg.rawPreview;
      r.hexPreview = msg.hexPreview;
      r.decodePath = msg.decodePath;
      r.opcode = msg.opcode;
      r.frameSeq = msg.frameSeq;
      r.wsFrame = true;
      const parent = byId.get(connId);
      r.wsLinkReqHeaders = parent?.wsReqHeaders ?? null;
      r.wsLinkRespHeaders = parent?.wsRespHeaders ?? null;
      flushNet();
      return;
    }

    if (NET_MERGE_KINDS.has(k) && msg.requestId) {
      const id = String(msg.requestId);
      const r = ensureRow(id);

      if (k === "net_request") {
        r.name = nameFromUrl(/** @type {string} */ (msg.url));
        r.url = msg.url;
        r.method = msg.method;
        r.resourceType = msg.resourceType;
        r.initiator = msg.initiator ?? "";
        r.reqHeaders = msg.headers;
        r.postData = msg.postData;
        r.hasPostData = msg.hasPostData;
        if (msg.cdpTimestamp != null) r.startCdpTs = msg.cdpTimestamp;
        r.phase = "pending";
      } else if (k === "net_response") {
        r.status = msg.status;
        r.statusText = msg.statusText;
        r.mimeType = msg.mimeType;
        r.respHeaders = msg.headers;
        if (msg.encodedDataLength != null) r.headerEncodedLen = msg.encodedDataLength;
        if (msg.cdpTimestamp != null) r.respCdpTs = msg.cdpTimestamp;
        if (r.phase !== "failed") r.phase = "responded";
        if (!r.name && msg.url) {
          r.name = nameFromUrl(/** @type {string} */ (msg.url));
          r.url = msg.url;
        }
      } else if (k === "net_finished") {
        if (msg.encodedDataLength != null) r.transferSize = msg.encodedDataLength;
        if (msg.cdpTimestamp != null) {
          r.finishCdpTs = msg.cdpTimestamp;
          if (r.startCdpTs != null) {
            r.durationMs = Math.max(0, (Number(msg.cdpTimestamp) - Number(r.startCdpTs)) * 1000);
          }
        }
        if (r.phase !== "failed") r.phase = "done";
        r.responseBodyPending = true;
      } else if (k === "net_response_body") {
        r.responseBodyPending = false;
        if (msg.bodyError) {
          r.responseBodyError = msg.bodyError;
          r.responseBodyJson = undefined;
          r.responseBodyText = undefined;
        } else {
          r.responseBodyError = undefined;
          r.responseBodyJson = msg.bodyJson;
          r.responseBodyText = msg.bodyRawText != null ? String(msg.bodyRawText) : undefined;
          r.responseBodyTruncated = Boolean(msg.responseBodyTruncated);
        }
      } else if (k === "net_failed") {
        r.failed = true;
        r.phase = "failed";
        r.responseBodyPending = false;
        r.errorText = msg.errorText;
        r.blockedReason = msg.blockedReason;
        if (msg.url) {
          r.url = msg.url;
          r.name = nameFromUrl(/** @type {string} */ (msg.url));
        }
        if (msg.method) r.method = msg.method;
        if (msg.resourceType) r.resourceType = msg.resourceType;
        if (msg.cdpTimestamp != null && r.startCdpTs != null) {
          r.durationMs = Math.max(0, (Number(msg.cdpTimestamp) - Number(r.startCdpTs)) * 1000);
        }
      } else if (k === "ws_created") {
        r.resourceType = "WebSocket";
        r.url = msg.url;
        r.name = nameFromUrl(/** @type {string} */ (msg.url));
        if (msg.cdpTimestamp != null && r.startCdpTs == null) r.startCdpTs = msg.cdpTimestamp;
        r.phase = "ws";
      } else if (k === "ws_handshake_request") {
        r.method = "GET";
        r.url = msg.url;
        r.name = nameFromUrl(/** @type {string} */ (msg.url));
        r.wsReqHeaders = msg.headers;
      } else if (k === "ws_handshake_response") {
        r.status = msg.status;
        r.statusText = msg.statusText;
        r.wsRespHeaders = msg.headers;
        r.phase = "ws_open";
        if (msg.cdpTimestamp != null && r.startCdpTs != null) {
          r.durationMs = Math.max(0, (Number(msg.cdpTimestamp) - Number(r.startCdpTs)) * 1000);
        }
      }

      flushNet();
      return;
    }

    pushMisc(msg);
  }

  return { netRows, miscEvents, ingest };
}
