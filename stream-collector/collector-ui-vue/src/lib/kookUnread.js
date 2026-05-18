/**
 * Kook `GET /api/v2/messages/unread`（CDP net_response_body）。
 * 正文多为按频道（或混用外层 key）映射的未读条数、@ 数等。
 */

/** @typedef {{ message_count: number; mention_count: number; mention_label: string | null }} KookChannelUnread */

const UNREAD_PATH = /\/api\/v2\/messages\/unread\b/i;

/**
 * @param {string} url
 */
export function isKookMessagesUnreadApiUrl(url) {
  const s = String(url ?? "");
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith("kookapp.cn") && !host.includes("kook")) return false;
    return UNREAD_PATH.test(`${u.pathname}${u.search}`);
  } catch {
    return UNREAD_PATH.test(s);
  }
}

/**
 * @param {unknown} raw
 * @returns {raw is Record<string, unknown>}
 */
function isObj(raw) {
  return raw != null && typeof raw === "object" && !Array.isArray(raw);
}

/**
 * 从响应 JSON 提取「频道 id → 未读统计」。兼容 `data` 包裹、外层 key 与内层 `id` 不一致等情况。
 * @param {unknown} bodyJson
 * @returns {Record<string, KookChannelUnread>}
 */
export function parseKookMessagesUnreadBody(bodyJson) {
  /** @type {Record<string, KookChannelUnread>} */
  const out = {};

  collectUnreadEntries(bodyJson, out);
  if (Object.keys(out).length) return out;

  if (!isObj(bodyJson)) return out;
  const root = /** @type {Record<string, unknown>} */ (bodyJson);
  const d1 = root.data;
  if (isObj(d1)) {
    collectUnreadEntries(d1, out);
    if (Object.keys(out).length) return out;
    const inner = /** @type {Record<string, unknown>} */ (d1);
    const d2 = inner.data;
    if (isObj(d2)) collectUnreadEntries(d2, out);
  }

  return out;
}

/**
 * @param {unknown} node
 * @param {Record<string, KookChannelUnread>} out
 */
function collectUnreadEntries(node, out) {
  if (!isObj(node)) return;
  const root = /** @type {Record<string, unknown>} */ (node);

  let mapObj = root;
  const data = root.data;
  if (data != null && typeof data === "object" && !Array.isArray(data)) {
    mapObj = /** @type {Record<string, unknown>} */ (data);
  }

  for (const [outerKey, raw] of Object.entries(mapObj)) {
    if (!isObj(raw)) continue;
    if (["meta", "user", "users", "roles", "bots", "emoji"].includes(outerKey)) continue;
    const o = /** @type {Record<string, unknown>} */ (raw);
    if (o.message_count == null && o.mention_count == null) continue;
    const message_count = Math.max(0, Math.floor(Number(o.message_count) || 0));
    const mention_count = Math.max(0, Math.floor(Number(o.mention_count) || 0));
    const ml = o.mention_label;
    const mention_label =
      ml === null || ml === undefined ? null : typeof ml === "string" ? ml : String(ml);

    const entry = { message_count, mention_count, mention_label };

    const innerId = o.id != null ? String(o.id).trim() : "";
    const k = String(outerKey).trim();
    const ids = new Set([innerId, k].filter(Boolean));
    for (const cid of ids) {
      out[cid] = entry;
    }
  }
}

/**
 * 将新抓到的未读合并进已有 map（同频道以新为准）。
 * @param {Record<string, KookChannelUnread>} prev
 * @param {Record<string, KookChannelUnread>} incoming
 */
export function mergeKookUnreadByChannel(prev, incoming) {
  for (const [cid, u] of Object.entries(incoming)) {
    prev[cid] = u;
  }
}

/**
 * WS 等场景：为某频道累加未读（不覆盖 REST /unread 全量快照中的数值，仅增量）。
 * @param {Record<string, KookChannelUnread>} prev
 * @param {string} channelId
 * @param {{ mention?: boolean }} [opts]
 */
export function bumpChannelUnread(prev, channelId, opts = {}) {
  const id = String(channelId ?? "").trim();
  if (!id) return;
  const mention = Boolean(opts.mention);
  const cur = prev[id] ?? { message_count: 0, mention_count: 0, mention_label: null };
  prev[id] = {
    message_count: Math.max(0, cur.message_count + 1),
    mention_count: Math.max(0, cur.mention_count + (mention ? 1 : 0)),
    mention_label: cur.mention_label,
  };
}

/**
 * 用户进入频道后视为已读该频道侧栏未读（仅清本地展示）。
 * @param {Record<string, KookChannelUnread>} prev
 * @param {string} channelId
 */
export function clearChannelUnread(prev, channelId) {
  const id = String(channelId ?? "").trim();
  if (!id || !prev[id]) return;
  delete prev[id];
}
