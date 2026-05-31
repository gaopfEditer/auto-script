/**
 * 消息日志 / UI 展示：debug 全量 vs 精简。
 */
import { isDebugMode, stringifyForLog } from "./discord-debug.js";
import { isDiscordNoiseApiUrl } from "./discord-gateway.js";
import { isBlockedWsPayload } from "./ws-noise-filter.js";

/**
 * @param {{
 *   guildId?: string;
 *   guildName?: string | null;
 *   channelId?: string;
 *   channelName?: string | null;
 *   authorUsername?: string | null;
 *   authorGlobalName?: string | null;
 *   authorId?: string;
 *   content?: string;
 *   source?: string;
 *   eventType?: string;
 *   rawJson?: unknown;
 * }} row
 */
export function formatMessageCompact(row) {
  const guild = row.guildName
    ? `${row.guildName} (${row.guildId || "?"})`
    : row.guildId
      ? `guild:${row.guildId}`
      : "DM/未知服务器";
  const channel = row.channelName
    ? `#${row.channelName} (${row.channelId || "?"})`
    : row.channelId
      ? `#${row.channelId}`
      : "#?";
  const author =
    row.authorGlobalName || row.authorUsername || row.authorId || "?";
  const text = String(row.content ?? "").replace(/\s+/g, " ").trim();
  const preview = text.length > 120 ? `${text.slice(0, 120)}…` : text || "（无文本）";
  return `[discord] ${guild} / ${channel} | @${author} | ${preview} [${row.source ?? "?"} ${row.eventType ?? ""}]`.trim();
}

/**
 * @param {string} kind ws | api
 * @param {unknown} payload
 * @param {{ url?: string, method?: string }} [meta]
 */
export function formatTrafficDebugLine(kind, payload, meta = {}) {
  if (kind === "api") {
    const method = meta.method ?? "?";
    const url = meta.url ?? "";
    return `[discord-api] ${method} ${url} ${stringifyForLog(payload)}`;
  }
  return `[discord-ws] ${stringifyForLog(payload)}`;
}

/** @param {unknown} payload @param {{ url?: string, method?: string }} [meta] */
export function logTraffic(log, kind, payload, meta = {}) {
  if (!isDebugMode()) return;
  if (kind === "api" && isDiscordNoiseApiUrl(meta.url ?? "")) return;
  if (kind === "ws" && isBlockedWsPayload(payload)) return;
  log.info(formatTrafficDebugLine(kind, payload, meta));
}

/** @param {ReturnType<import('./logger.js').createLogger>} log @param {Parameters<typeof formatMessageCompact>[0]} row */
export function logMessageIngest(log, row) {
  if (String(row.source ?? "") === "gateway_ws") return;
  if (isDebugMode()) {
    log.info(formatTrafficDebugLine("ws", row.rawJson ?? row));
  } else {
    log.info(formatMessageCompact(row));
  }
}

/** @param {unknown} v */
function asRecord(v) {
  return v != null && typeof v === "object" && !Array.isArray(v)
    ? /** @type {Record<string, unknown>} */ (v)
    : null;
}

/** @param {unknown} rawJson */
function extractEmbedImages(rawJson) {
  const raw = asRecord(rawJson);
  if (!raw || !Array.isArray(raw.embeds)) return [];

  /** @type {Array<{ url: string, filename: string, contentType: string }>} */
  const out = [];
  const seen = new Set();
  for (const embed of raw.embeds) {
    const e = asRecord(embed);
    if (!e) continue;
    for (const img of [asRecord(e.image), asRecord(e.thumbnail)]) {
      if (!img) continue;
      const url = String(img.url ?? "").trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({ url, filename: "", contentType: "image/*" });
    }
  }
  return out;
}

/** @param {unknown} rawJson */
export function extractAttachmentsForClient(rawJson) {
  if (rawJson == null || typeof rawJson !== "object" || Array.isArray(rawJson)) {
    return extractEmbedImages(rawJson);
  }
  const attachments = /** @type {Record<string, unknown>} */ (rawJson).attachments;
  /** @type {Array<{ url: string, proxyUrl?: string, filename: string, contentType: string, width?: number, height?: number }>} */
  const out = [];
  if (Array.isArray(attachments)) {
    for (const item of attachments) {
      const a = asRecord(item);
      if (!a) continue;
      const url = String(a.url ?? "").trim();
      const proxyUrl = String(a.proxy_url ?? a.proxyUrl ?? "").trim();
      const pick = url || proxyUrl;
      if (!pick) continue;
      out.push({
        url: pick,
        proxyUrl: proxyUrl || undefined,
        filename: String(a.filename ?? "").trim(),
        contentType: String(a.content_type ?? a.contentType ?? "").trim(),
        width: typeof a.width === "number" ? a.width : undefined,
        height: typeof a.height === "number" ? a.height : undefined,
      });
    }
  }
  return out.length ? out : extractEmbedImages(rawJson);
}

/**
 * 消息列表预览（含纯附件消息）。
 * @param {{ content?: string, rawJson?: unknown, attachments?: unknown[] }} row
 */
export function messageContentPreview(row) {
  const text = String(row.content ?? "").replace(/\s+/g, " ").trim();
  if (text) return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  const attachments = Array.isArray(row.attachments)
    ? row.attachments
    : extractAttachmentsForClient(row.rawJson);
  if (attachments.length) {
    const first = attachments[0];
    const fn =
      first != null && typeof first === "object" && !Array.isArray(first)
        ? String(/** @type {Record<string, unknown>} */ (first).filename ?? "").trim()
        : "";
    const ct =
      first != null && typeof first === "object" && !Array.isArray(first)
        ? String(/** @type {Record<string, unknown>} */ (first).contentType ?? "").toLowerCase()
        : "";
    if (ct.startsWith("image/") || /\.(png|jpe?g|gif|webp)$/i.test(fn)) return "（图片）";
    return fn ? `[附件] ${fn}` : "（附件）";
  }
  return "（无文本）";
}

/**
 * WS/前端推送：保留 attachments，不携带 rawJson（避免 debug 下 payload 过大导致推送失败）。
 * @param {Record<string, unknown>} row
 */
export function messageRowToClientForPush(row) {
  const client = messageRowToClient(row);
  client.rawJson = undefined;
  return client;
}

/**
 * DB/API 行 → 前端 camelCase
 * @param {Record<string, unknown>} row
 */
export function messageRowToClient(row) {
  const rawJson = row.raw_json ?? row.rawJson ?? null;
  const attachments = Array.isArray(row.attachments)
    ? row.attachments
    : extractAttachmentsForClient(rawJson);
  return {
    messageId: row.message_id ?? row.messageId,
    guildId: row.guild_id ?? row.guildId ?? "",
    guildName: row.guild_name ?? row.guildName ?? null,
    channelId: row.channel_id ?? row.channelId ?? "",
    channelName: row.channel_name ?? row.channelName ?? null,
    authorId: row.author_id ?? row.authorId ?? "",
    authorUsername: row.author_username ?? row.authorUsername ?? null,
    authorGlobalName: row.author_global_name ?? row.authorGlobalName ?? null,
    authorAvatar: row.author_avatar ?? row.authorAvatar ?? null,
    content: row.content ?? "",
    eventType: row.event_type ?? row.eventType ?? "",
    source: row.source ?? "",
    createdAtMs: row.created_at_ms ?? row.createdAtMs ?? 0,
    receivedAt: row.received_at ?? row.receivedAt ?? null,
    attachments,
    rawJson,
  };
}
