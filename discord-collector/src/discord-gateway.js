/**
 * Discord Gateway / REST 消息解析辅助。
 */
import { avatarFromAuthor } from "./discord-avatar.js";

/** @param {string} snowflake */
export function snowflakeToMs(snowflake) {
  try {
    const id = BigInt(String(snowflake));
    return Number((id >> 22n) + 1420070400000n);
  } catch {
    return Date.now();
  }
}

/**
 * @param {unknown} obj Gateway 帧 JSON
 * @returns {{ op?: number, t?: string, d?: unknown, s?: number } | null}
 */
export function parseGatewayFrame(obj) {
  if (obj == null || typeof obj !== "object" || Array.isArray(obj)) return null;
  const o = /** @type {Record<string, unknown>} */ (obj);
  return {
    op: typeof o.op === "number" ? o.op : undefined,
    t: typeof o.t === "string" ? o.t : undefined,
    d: o.d,
    s: typeof o.s === "number" ? o.s : undefined,
  };
}

const MESSAGE_EVENTS = new Set(["MESSAGE_CREATE", "MESSAGE_UPDATE"]);

/** Gateway 实时消息事件（config.gatewayMessageLog=1 时打印） */
export const GATEWAY_REALTIME_LOG_EVENTS = MESSAGE_EVENTS;

/** @param {unknown} json */
export function formatGatewayRealtimeLog(json) {
  const frame = parseGatewayFrame(json);
  if (!frame?.t || !GATEWAY_REALTIME_LOG_EVENTS.has(frame.t)) return null;
  const d = asRecord(frame.d);
  if (!d) return null;
  const author = asRecord(d.author);
  const uname = String(author?.global_name ?? author?.username ?? "?");
  const cid = String(d.channel_id ?? "?");
  const gid = d.guild_id != null ? String(d.guild_id) : "";
  const content = String(d.content ?? "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 280);
  const attachN = Array.isArray(d.attachments) ? d.attachments.length : 0;
  const extra = attachN ? ` [${attachN}附件]` : "";
  const where = gid ? `#${cid} guild=${gid}` : `#${cid}`;
  return `[gateway ${frame.t}] ${where} @${uname}: ${content || "（无文本）"}${extra}`;
}

/** @param {unknown} v */
function asRecord(v) {
  return v != null && typeof v === "object" && !Array.isArray(v)
    ? /** @type {Record<string, unknown>} */ (v)
    : null;
}

/** @param {unknown} obj */
export function looksLikeDiscordMessage(obj) {
  const o = asRecord(obj);
  if (!o?.id || o.channel_id == null) return false;
  if (typeof o.op === "number") return false;
  const author = asRecord(o.author);
  if (author?.id != null) return true;
  if (o.webhook_id != null) return true;
  if (typeof o.content === "string") return true;
  if (Array.isArray(o.attachments) && o.attachments.length) return true;
  return false;
}

/**
 * @param {unknown} data Gateway dispatch `d`
 * @param {string} eventType `t`
 * @param {string} source
 */
export function normalizeDiscordMessage(data, eventType, source = "gateway_ws") {
  if (data == null || typeof data !== "object" || Array.isArray(data)) return null;
  const m = /** @type {Record<string, unknown>} */ (data);
  const id = m.id != null ? String(m.id) : "";
  if (!id) return null;

  const author = m.author && typeof m.author === "object" ? /** @type {Record<string, unknown>} */ (m.author) : null;

  return {
    messageId: id,
    guildId: m.guild_id != null ? String(m.guild_id) : "",
    channelId: m.channel_id != null ? String(m.channel_id) : "",
    authorId: author?.id != null ? String(author.id) : "",
    createdAtMs: snowflakeToMs(id),
    content: typeof m.content === "string" ? m.content : "",
    authorUsername: author?.username != null ? String(author.username) : null,
    authorGlobalName: author?.global_name != null ? String(author.global_name) : null,
    authorAvatar: author ? avatarFromAuthor(author) : null,
    eventType: eventType || "MESSAGE_CREATE",
    source,
    rawJson: m,
  };
}

/**
 * 从 Gateway WS 帧 body 提取消息行。
 * @param {unknown} parsedJson
 */
export function extractMessageFromGatewayFrame(parsedJson) {
  const frame = parseGatewayFrame(parsedJson);
  if (!frame || frame.op !== 0 || !frame.t || !MESSAGE_EVENTS.has(frame.t)) return null;
  return normalizeDiscordMessage(frame.d, frame.t, "gateway_ws");
}

/**
 * Gateway 帧或 Discord 客户端裸消息（含 id、channel_id、author）。
 * @param {unknown} parsedJson
 */
export function extractMessageFromPayload(parsedJson) {
  const fromGateway = extractMessageFromGatewayFrame(parsedJson);
  if (fromGateway) return fromGateway;
  if (!looksLikeDiscordMessage(parsedJson)) return null;
  const o = asRecord(parsedJson);
  const eventType = o?.edited_timestamp ? "MESSAGE_UPDATE" : "MESSAGE_CREATE";
  return normalizeDiscordMessage(parsedJson, eventType, "client_ws");
}

/**
 * 从 Discord REST 响应体提取消息（单条或数组）。
 * @param {unknown} bodyJson
 * @param {string} [requestUrl]
 */
export function extractMessagesFromRestBody(bodyJson, requestUrl = "") {
  /** @type {ReturnType<typeof normalizeDiscordMessage>[]} */
  const out = [];
  const urlChannelId = parseChannelIdFromMessagesUrl(requestUrl);

  const pushOne = (item) => {
    if (!looksLikeDiscordMessage(item)) return;
    const row = normalizeDiscordMessage(item, "MESSAGE_CREATE", "rest_api");
    if (!row) return;
    if (!row.channelId && urlChannelId) row.channelId = urlChannelId;
    out.push(row);
  };

  if (Array.isArray(bodyJson)) {
    for (const item of bodyJson) pushOne(item);
  } else if (bodyJson && typeof bodyJson === "object") {
    const o = /** @type {Record<string, unknown>} */ (bodyJson);
    if (looksLikeDiscordMessage(o)) {
      pushOne(o);
    }
    if (Array.isArray(o.messages)) {
      for (const item of o.messages) pushOne(item);
    }
  }

  return out;
}

/** @param {string} url */
export function parseChannelIdFromMessagesUrl(url) {
  const m = String(url ?? "").match(/\/channels\/(\d+)\/messages(?:\?|$)/i);
  return m ? m[1] : "";
}

/** 仅匹配 GET /channels/{id}/messages?… 列表，排除 /messages/{msgId}/ack 等 */
export function isChannelMessagesUrl(url) {
  return /\/channels\/\d+\/messages(?:\?|$)/i.test(String(url ?? ""));
}

/** @param {string} url */
export function isChannelDetailUrl(url) {
  const u = String(url ?? "");
  return /\/channels\/\d+(?:\?|$|\/$)/i.test(u) && !/\/messages/i.test(u);
}

/**
 * 从 Discord 网页 URL 解析 guild / channel（`/channels/{guildId}/{channelId}`）。
 * @param {string} url
 * @returns {{ guildId: string, channelId: string } | null}
 */
export function parseGuildChannelFromDiscordUrl(url) {
  try {
    const u = new URL(String(url ?? ""), "https://discord.com");
    const m = u.pathname.match(/\/channels\/([^/]+)\/([^/?#]+)/);
    if (!m) return null;
    const guildId = decodeURIComponent(m[1]);
    const channelId = decodeURIComponent(m[2]);
    if (!guildId || !channelId) return null;
    return { guildId, channelId };
  } catch {
    return null;
  }
}

/**
 * 解析频道消息 REST URL 查询参数（limit / before / after）。
 * @param {string} url
 * @returns {{ channelId: string, before?: string, after?: string, limit?: number }}
 */
export function parseChannelMessagesQuery(url) {
  const channelId = parseChannelIdFromMessagesUrl(url);
  try {
    const u = new URL(String(url ?? ""), "https://discord.com");
    const before = u.searchParams.get("before") || undefined;
    const after = u.searchParams.get("after") || undefined;
    const limitRaw = u.searchParams.get("limit");
    const limit = limitRaw != null && limitRaw !== "" ? Number(limitRaw) : undefined;
    return {
      channelId,
      before,
      after,
      limit: Number.isFinite(limit) ? limit : undefined,
    };
  } catch {
    return { channelId };
  }
}

/** @param {string} url */
export function parseChannelIdFromChannelUrl(url) {
  const u = String(url ?? "");
  if (/\/messages/i.test(u)) return "";
  const m = u.match(/\/channels\/(\d+)(?:\?|$|\/)/i);
  return m ? m[1] : "";
}

/** @param {string} url */
export function isDiscordApiUrl(url) {
  const u = String(url ?? "").toLowerCase();
  return u.includes("discord.com/api") || u.includes("discordapp.com/api");
}

/** Discord 已读 ack、science 埋点等中间请求，无需日志/入库 */
export function isDiscordNoiseApiUrl(url) {
  const u = String(url ?? "").toLowerCase();
  if (!isDiscordApiUrl(u)) return false;
  return (
    /\/messages\/\d+\/ack(?:\?|$)/i.test(u) ||
    /\/science(?:\?|$|\/)/i.test(u) ||
    /\/channels\/\d+\/typing(?:\?|$)/i.test(u) ||
    /\/channels\/\d+\/messages\/\d+\/ack/i.test(u) ||
    /\/users\/@me\/settings/i.test(u) ||
    /\/users\/@me\/affinities/i.test(u) ||
    /\/users\/@me\/billing/i.test(u)
  );
}

/** @param {string} url */
export function isDiscordGatewayUrl(url) {
  const u = String(url ?? "").toLowerCase();
  return u.includes("gateway.discord.gg") || u.includes("/?v=") && u.includes("gateway");
}
