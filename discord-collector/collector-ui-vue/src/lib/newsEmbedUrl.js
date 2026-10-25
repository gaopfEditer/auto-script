export const NEWS_EMBED_MOUNT = "/news-embed";

/**
 * 同源只允许 /news-embed；/show、/news 等主站路由一律拒绝（否则会嵌成 Show）。
 * @param {string} url
 */
export function isTrapMainSiteNewsEmbed(url) {
  const raw = String(url ?? "").trim();
  if (!raw) return true;
  try {
    const u = new URL(raw, typeof location !== "undefined" ? location.href : "https://local/");
    const p = u.pathname.replace(/\/$/, "") || "/";
    if (p === NEWS_EMBED_MOUNT || p.startsWith(`${NEWS_EMBED_MOUNT}/`)) return false;
    if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(u.href) && u.port === "8770") {
      return false;
    }
    if (typeof location !== "undefined" && u.origin === location.origin) return true;
    return false;
  } catch {
    return true;
  }
}

/**
 * @param {Record<string, unknown>} [status]
 */
export function pickNewsIframeEmbedUrl(status) {
  const fallback = `${NEWS_EMBED_MOUNT}/`;
  const deployErr = String(status?.embedDeployError ?? "").trim();
  if (deployErr) return "";

  const candidates = [status?.publicEmbedUrl, status?.embedUrl, fallback];
  for (const raw of candidates) {
    const s = String(raw ?? "").trim();
    if (!s || isTrapMainSiteNewsEmbed(s)) continue;
    return s.endsWith("/") || s.includes("?") ? s : `${s}/`;
  }
  return fallback;
}
