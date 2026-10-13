/** 跨频道/重渲染记住已失败的附件，避免 404 图片反复请求 */
/** @type {Set<string>} */
const failedKeys = new Set();

/** @param {string} raw */
function urlPathKey(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    return `${u.hostname}${u.pathname}`;
  } catch {
    return s.split("?")[0].slice(-120);
  }
}

/**
 * @param {Record<string, unknown>} att
 * @param {number} index
 * @param {Record<string, unknown>} msg
 */
export function stableAttachmentImgKey(att, index, msg) {
  const mid = String(msg.messageId ?? msg.message_id ?? index);
  const path =
    urlPathKey(att.url) ||
    urlPathKey(att.proxyUrl) ||
    urlPathKey(att.proxy_url) ||
    `idx-${index}`;
  return `${mid}#${index}#${path}`;
}

/** @param {string} key */
export function isAttachmentImgDead(key) {
  return failedKeys.has(key);
}

/** @param {string} key */
export function markAttachmentImgDead(key) {
  if (!key) return;
  failedKeys.add(key);
}
