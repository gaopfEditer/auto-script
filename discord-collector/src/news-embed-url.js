/** @typedef {{ mount: string }} NewsEmbedUrlOpts */

import { NEWS_EMBED_MOUNT } from "./news-embed-proxy.js";

/**
 * 浏览器 iframe 禁止嵌主站其它路由（/show、/news 等），只允许 /news-embed 或外站。
 * @param {string} url
 * @param {NewsEmbedUrlOpts} [opts]
 */
export function isTrapMainSiteNewsEmbed(url, opts = {}) {
  const mount = String(opts.mount || NEWS_EMBED_MOUNT).replace(/\/$/, "") || NEWS_EMBED_MOUNT;
  const raw = String(url ?? "").trim();
  if (!raw) return true;
  try {
    const base =
      typeof location !== "undefined" && location.href
        ? location.href
        : "https://placeholder.local/";
    const u = new URL(raw, base);
    const host = u.hostname.toLowerCase();
    const isLocalHost = host === "localhost" || host === "127.0.0.1" || host === "[::1]";
    if (isLocalHost && (u.port === "8770" || u.pathname.startsWith(`${mount}/`) || u.pathname === mount)) {
      return false;
    }
    const p = u.pathname.replace(/\/$/, "") || "/";
    if (p === mount || p.startsWith(`${mount}/`)) return false;
    if (isLocalHost) return false;
    const origin = u.origin.toLowerCase();
    if (origin.endsWith(".local") || origin === "https://placeholder.local") {
      return p !== mount && !p.startsWith(`${mount}/`);
    }
    return true;
  } catch {
    return true;
  }
}

/**
 * @param {string} configured
 * @param {string} fallback 例如 /news-embed/
 * @param {NewsEmbedUrlOpts} [opts]
 */
export function sanitizePublicNewsEmbedUrl(configured, fallback, opts = {}) {
  const fb = String(fallback || `${NEWS_EMBED_MOUNT}/`).trim();
  const s = String(configured || "").trim();
  if (!s) return fb;
  if (isTrapMainSiteNewsEmbed(s, opts)) return fb;
  return s.endsWith("/") || s.includes("?") ? s : `${s}/`;
}
