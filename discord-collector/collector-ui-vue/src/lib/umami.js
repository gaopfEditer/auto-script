/**
 * Umami 访客统计（https://bz.ezcoin.ink）
 *
 * 脚本已写入 collector-ui-vue/index.html：
 *   <script defer src="https://bz.ezcoin.ink/script.js"
 *     data-website-id="2a409684-5ffa-4c8c-8b28-68c2b22c21ee"></script>
 *
 * SPA 路由变更由官方脚本 hook history.pushState 自动上报。
 * 本模块仅提供自定义事件封装。
 */

/**
 * 自定义事件（可选）
 * @param {string} name
 * @param {Record<string, unknown>} [data]
 */
export function trackUmamiEvent(name, data) {
  const fn = typeof window !== "undefined" ? window.umami?.track : null;
  if (typeof fn !== "function") return;
  try {
    if (data && typeof data === "object") fn(name, data);
    else fn(name);
  } catch {
    /* ignore */
  }
}
