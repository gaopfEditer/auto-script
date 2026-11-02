/**
 * CDP 连接 URL 解析（无 Playwright 依赖，供单测使用）。
 */

/** @param {string} connectUrl */
export function parseCdpConnectHostPort(connectUrl) {
  const raw = String(connectUrl ?? "").trim() || "http://127.0.0.1:9222";
  let base = raw;
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
  try {
    const u = new URL(base);
    const port = Number(u.port) || 9222;
    const host = u.hostname || "127.0.0.1";
    return { host, port, base: base.replace(/\/+$/, "") };
  } catch {
    return { host: "127.0.0.1", port: 9222, base: "http://127.0.0.1:9222" };
  }
}
