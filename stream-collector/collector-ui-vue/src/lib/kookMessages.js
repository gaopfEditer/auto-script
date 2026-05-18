/**
 * Kook `GET /api/v2/messages/{channelId}` 历史消息（CDP net_response_body）。
 * 兼容查询串如 `?flag=before&page_size=30&msgid=`；正文以 `content` 为主并回退 `kmarkdown` 等；
 * 作者以 `author` 对象为主（`id` / `username` / `nickname` / `identify_num`）。
 */

/**
 * @typedef {{
 *   id: string;
 *   content: string;
 *   create_at: number;
 *   authorId: string;
 *   authorUsername: string;
 *   authorNickname: string;
 *   authorIdentifyNum: string;
 *   authorDisplayName: string;
 *   authorAvatar: string;
 *   bot: boolean;
 *   type: number;
 *   raw: Record<string, unknown>;
 * }} KookHistMsg
 */

const MESSAGES_RE = /\/api\/v2\/messages\/(\d+)\b/i;

const KOOK_IMG_ORIGIN = "https://img.kookapp.cn";

/**
 * 从 author 对象解析可展示的完整头像 URL（兼容相对路径、协议省略、vip_avatar）。
 * @param {Record<string, unknown>} author
 */
export function resolveKookAvatarUrl(author) {
  const candidates = [
    author.avatar,
    author.vip_avatar,
    author.icon,
    author.avatar_url,
    author.head_img,
  ];
  let cand = "";
  for (const x of candidates) {
    if (typeof x === "string" && x.trim()) {
      cand = x.trim();
      break;
    }
  }
  if (!cand) return "";
  if (/^https?:\/\//i.test(cand)) return cand;
  if (cand.startsWith("//")) return `https:${cand}`;
  if (cand.startsWith("/")) return `${KOOK_IMG_ORIGIN}${cand}`;
  return `${KOOK_IMG_ORIGIN}/${cand.replace(/^\/+/, "")}`;
}

/**
 * @param {string} url
 */
export function isKookChannelMessagesUrl(url) {
  const s = String(url ?? "");
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith("kookapp.cn") && !host.includes("kook")) return false;
    return MESSAGES_RE.test(u.pathname);
  } catch {
    return MESSAGES_RE.test(s);
  }
}

/**
 * @param {string} url
 * @returns {string | null}
 */
export function extractChannelIdFromMessagesUrl(url) {
  const s = String(url ?? "");
  try {
    const u = new URL(s);
    const m = u.pathname.match(MESSAGES_RE);
    return m?.[1] ?? null;
  } catch {
    const m = s.match(MESSAGES_RE);
    return m?.[1] ?? null;
  }
}

/**
 * @param {unknown} raw
 * @returns {raw is Record<string, unknown>}
 */
function isObj(raw) {
  return raw != null && typeof raw === "object" && !Array.isArray(raw);
}

/** @param {Record<string, unknown>} r */
function pickAuthorObject(r) {
  if (isObj(r.author)) return /** @type {Record<string, unknown>} */ (r.author);
  if (isObj(r.user)) return /** @type {Record<string, unknown>} */ (r.user);
  return {};
}

/** @param {Record<string, unknown>} r */
function pickMessageText(r) {
  for (const k of ["content", "kmarkdown", "text", "message", "msg"]) {
    const v = r[k];
    if (typeof v === "string" && v.trim()) return v;
  }
  return "";
}

/** @param {Record<string, unknown>} r */
function pickCreateAtMs(r) {
  for (const k of ["create_at", "createAt", "time", "timestamp", "msg_timestamp", "send_time"]) {
    if (r[k] == null || r[k] === "") continue;
    const n = Number(r[k]);
    if (!Number.isNaN(n) && n > 0) return n;
  }
  return 0;
}

/**
 * @returns {KookHistMsg | null}
 */
export function normalizeKookHistoryMessage(raw) {
  if (!isObj(raw)) return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  const author = pickAuthorObject(r);
  const nick = String(author.nickname ?? "").trim();
  const user = String(author.username ?? "").trim();
  const identify = String(author.identify_num ?? author.identifyNum ?? "").trim();
  let authorDisplayName = nick || user;
  if (!authorDisplayName) authorDisplayName = "未知用户";
  const authorId = String(author.id ?? r.author_id ?? r.user_id ?? "").trim();
  const content = pickMessageText(r);
  const create_at = pickCreateAtMs(r);
  return {
    id: String(r.id ?? ""),
    content,
    create_at,
    authorId,
    authorUsername: user,
    authorNickname: nick,
    authorIdentifyNum: identify,
    authorDisplayName,
    authorAvatar: resolveKookAvatarUrl(author),
    bot: Boolean(author.bot),
    type: Number(r.type ?? 0),
    raw: r,
  };
}

/**
 * @param {unknown} bodyJson
 * @returns {KookHistMsg[]}
 */
export function parseKookMessagesResponseBody(bodyJson) {
  const rawList = collectMessageLikeArray(bodyJson);
  /** @type {KookHistMsg[]} */
  const out = [];
  for (const raw of rawList) {
    const n = normalizeKookHistoryMessage(raw);
    if (n && n.id) out.push(n);
  }
  return out;
}

/** 顶层或常见嵌套里直接是「消息数组」的键名 */
const ARRAY_KEYS_TOP = [
  "items",
  "list",
  "messages",
  "records",
  "data",
  "results",
  "msg_list",
  "channel_messages",
  "room_messages",
];

/** `data` 对象内部常见数组键 */
const ARRAY_KEYS_NEST = ["items", "list", "messages", "records", "results", "msg_list", "channel_messages"];

/**
 * @param {unknown} bodyJson
 * @returns {unknown[]}
 */
function collectMessageLikeArray(bodyJson) {
  if (Array.isArray(bodyJson)) return bodyJson;
  if (!isObj(bodyJson)) return [];
  const o = /** @type {Record<string, unknown>} */ (bodyJson);

  for (const k of ARRAY_KEYS_TOP) {
    const v = o[k];
    if (Array.isArray(v)) return v;
  }

  const d = o.data;
  if (Array.isArray(d)) return d;
  if (isObj(d)) {
    const di = /** @type {Record<string, unknown>} */ (d);
    for (const k of ARRAY_KEYS_NEST) {
      const v = di[k];
      if (Array.isArray(v)) return v;
    }
    const d2 = di.data;
    if (Array.isArray(d2)) return d2;
    if (isObj(d2)) {
      const d2i = /** @type {Record<string, unknown>} */ (d2);
      for (const k of ARRAY_KEYS_NEST) {
        const v = d2i[k];
        if (Array.isArray(v)) return v;
      }
    }
  }

  if (typeof o.content === "string" && isObj(o.author)) return [o];
  return [];
}

/**
 * @param {KookHistMsg[]} prev
 * @param {KookHistMsg[]} incoming
 */
export function mergeKookChannelMessages(prev, incoming) {
  const map = new Map();
  for (const m of prev) {
    if (m && m.id) map.set(m.id, m);
  }
  for (const m of incoming) {
    if (m && m.id) map.set(m.id, m);
  }
  return Array.from(map.values()).sort((a, b) => (a.create_at || 0) - (b.create_at || 0));
}
