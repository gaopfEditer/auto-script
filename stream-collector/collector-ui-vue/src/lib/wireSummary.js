/** @param {string} s @param {number} m */
export function trunc(s, m = 140) {
  const t = String(s ?? "");
  return t.length > m ? `${t.slice(0, m)}…` : t;
}

/** @param {Record<string, unknown>} msg */
export function wireSummary(msg) {
  const channel = msg.channel;
  const kind = msg.kind;
  if (channel === "frame" && kind === "ws_frame") {
    return `WS opcode=${msg.opcode} len=${msg.len} ${msg.decodeFormat} | MySQL schema=${msg.dbParseOk ? "ok" : "fail"}`;
  }
  if (kind === "net_request")
    return `${msg.resourceType} ${msg.method} ${trunc(msg.url, 100)}`;
  if (kind === "net_response")
    return `${msg.resourceType} HTTP ${msg.status} ${trunc(String(msg.mimeType ?? ""), 40)} ${trunc(msg.url, 80)}`;
  if (kind === "net_failed") return `失败 ${trunc(msg.errorText, 120)}`;
  if (kind === "page") return `page.${msg.phase} ${trunc(msg.url, 100)}`;
  if (kind === "playwright_request_failed")
    return `PW fail ${msg.method} ${trunc(msg.url, 100)}`;
  if (kind === "ws_created") return `WS 创建 ${trunc(msg.url, 120)}`;
  if (kind === "ws_handshake_request") return `WS 握手 → ${trunc(msg.url, 120)}`;
  if (kind === "ws_handshake_response") return `WS 握手 ← HTTP ${msg.status}`;
  if (kind === "goto_begin") return `goto 开始 → ${trunc(msg.targetUrl, 120)}`;
  if (kind === "goto_domcontentloaded")
    return `goto DOM ${msg.httpStatus ?? "?"} ${trunc(msg.finalUrl, 100)}`;
  if (kind === "goto_load") return `load ${msg.ok ? "ok" : "timeout"}`;
  if (kind === "goto_error") return `goto 错误: ${msg.message}`;
  if (kind === "cdp_boot") return `CDP 启动 ${msg.mode} ${trunc(msg.startUrl, 80)}`;
  if (kind === "cdp_attached") return `CDP 附加 tabs=${msg.tabCount} ${trunc(msg.connectUrl, 80)}`;
  return trunc(JSON.stringify(msg), 160);
}
