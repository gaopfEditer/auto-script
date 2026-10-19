/** 跨频道/重渲染记住已失败的附件，避免 404 图片反复请求 */
/** @type {Set<string>} */
const failedKeys = new Set();

/** Discord CDN 换签名时 pathname 不变，必须把 ex/hm 纳入失败键，否则会永久「图片加载失败」 */
/** @param {string} raw */
function urlSignature(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return "";
  try {
    const u = new URL(s);
    const ex = u.searchParams.get("ex") ?? "";
    const hm = u.searchParams.get("hm") ?? "";
    if (ex || hm) return `${u.hostname}${u.pathname}?ex=${ex}&hm=${hm}`;
    const q = u.search || "";
    return q ? `${u.hostname}${u.pathname}${q}` : `${u.hostname}${u.pathname}`;
  } catch {
    return s.slice(-160);
  }
}

/**
 * @param {Record<string, unknown>} att
 * @param {number} index
 * @param {Record<string, unknown>} msg
 */
export function stableAttachmentImgKey(att, index, msg) {
  const mid = String(msg.messageId ?? msg.message_id ?? index);
  const sig =
    urlSignature(att.url) ||
    urlSignature(att.proxyUrl) ||
    urlSignature(att.proxy_url) ||
    `idx-${index}`;
  return `${mid}#${index}#${sig}`;
}

/** 切频道或库内 URL 批量更新后，允许重新尝试加载 */
export function resetAttachmentImgDeadCache() {
  failedKeys.clear();
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

/** @param {string} key */
export function clearAttachmentImgDead(key) {
  if (!key) return;
  failedKeys.delete(key);
}
