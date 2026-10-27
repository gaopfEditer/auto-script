/**
 * Umami 访客统计（https://bz.ezcoin.ink）
 *
 * 脚本在 index.html 中按域名条件加载；localhost / 127.0.0.1 不加载，避免本地误报。
 * SPA 路由变更由官方脚本 hook history.pushState 自动上报。
 * 本模块仅提供自定义事件封装。
 */

/** @returns {boolean} */
export function isUmamiTrackingEnabled() {
  if (typeof location === "undefined") return false;
  const host = String(location.hostname || "").toLowerCase();
  if (host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1") {
    return false;
  }
  return true;
}

/**
 * 自定义事件（可选）
 * @param {string} name
 * @param {Record<string, unknown>} [data]
 */
export function trackUmamiEvent(name, data) {
  if (!isUmamiTrackingEnabled()) return;
  const fn = typeof window !== "undefined" ? window.umami?.track : null;
  if (typeof fn !== "function") return;
  try {
    if (data && typeof data === "object") fn(name, data);
    else fn(name);
  } catch {
    /* ignore */
  }
}
