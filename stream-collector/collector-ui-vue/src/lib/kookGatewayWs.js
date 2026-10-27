/**
 * Kook 网关 WebSocket JSON（CDP 捕获的帧体）：如 `SYS_MSG` 内嵌 `desktop_notification`。
 */

/**
 * @param {unknown} raw
 * @returns {raw is Record<string, unknown>}
 */
function isObj(raw) {
  return raw != null && typeof raw === "object" && !Array.isArray(raw);
}

/**
 * 从单帧解析结果中提取「桌面通知」并转成与 REST 历史兼容的 KookHistMsg。
 * @param {unknown} frameRoot 解码后的 JSON（常见形态 `{ s, d, sn }`）
 * @returns {{ channelId: string; guildId: string; hist: import("./kookMessages.js").KookHistMsg } | null}
 */
export function tryExtractDesktopNotificationFromWsFrameJson(frameRoot) {
  if (!isObj(frameRoot)) return null;
  const root = /** @type {Record<string, unknown>} */ (frameRoot);
  const d = root.d;
  if (!isObj(d)) return null;
  const di = /** @type {Record<string, unknown>} */ (d);
  if (String(di.type ?? "") !== "SYS_MSG") return null;

  const contentStr = di.content;
  if (typeof contentStr !== "string" || !contentStr.trim()) return null;

  let inner;
  try {
    inner = JSON.parse(contentStr);
  } catch {
    return null;
  }
  if (!isObj(inner) || String(inner.type ?? "") !== "desktop_notification") return null;

  const body = inner.body;
  if (!isObj(body)) return null;
  const b = /** @type {Record<string, unknown>} */ (body);

  const extra = b.extra;
  if (!isObj(extra)) return null;
  const ex = /** @type {Record<string, unknown>} */ (extra);

  const channelId = String(ex.channel_id ?? "").trim();
  const guildId = String(ex.guild_id ?? "").trim();
  if (!channelId) return null;

  const title = String(b.title ?? "").trim();
  const bodyText = String(b.content ?? "").trim();
  const avatar = typeof b.avatar === "string" ? b.avatar.trim() : "";
  const authorId = ex.author_id != null ? String(ex.author_id).trim() : "";
  const msgId = ex.msg_id != null ? String(ex.msg_id).trim() : "";

  let displayName = title || "桌面通知";
  const paren = displayName.indexOf(" (");
  if (paren > 0) {
    const head = displayName.slice(0, paren).trim();
    if (head) displayName = head;
  }

  const msgTs = Number(di.msgTimestamp);
  const create_at = !Number.isNaN(msgTs) && msgTs > 0 ? msgTs : Date.now();

  const id = msgId || "ws-desktop-" + channelId + "-" + String(create_at);
  let content = "";
  if (title && bodyText) {
    content = title + "\n" + bodyText;
  } else {
    content = bodyText || title;
    if (!content) content = "无正文";
  }

  /** @type {import("./kookMessages.js").KookHistMsg} */
  const hist = {
    id,
    content,
    create_at,
    authorId,
    authorUsername: "",
    authorNickname: "",
    authorIdentifyNum: "",
    authorDisplayName: displayName,
    authorAvatar: avatar,
    bot: false,
    type: 255,
    raw: {
      _kookWsDesktopNotification: true,
      envelope: di,
      notification: inner,
    },
  };

  return { channelId, guildId, hist };
}

/**
 * @param {Record<string, unknown>} di
 * @returns {Record<string, unknown> | null}
 */
function parseChannelMsgInner(di) {
  const contentStr = di.content;
  if (typeof contentStr === "string" && contentStr.trim()) {
    try {
      const inner = JSON.parse(contentStr);
      return isObj(inner) ? /** @type {Record<string, unknown>} */ (inner) : null;
    } catch {
      return null;
    }
  }
  if (isObj(contentStr)) return /** @type {Record<string, unknown>} */ (contentStr);
  return null;
}

/**
 * @param {Record<string, unknown>} ex
 * @param {Record<string, unknown>} di
 */
function pickChannelIdFromEnvelope(ex, di) {
  for (const src of [ex, di]) {
    for (const k of ["channel_id", "channelId"]) {
      const v = src[k];
      if (v == null) continue;
      const s = String(v).trim();
      if (/^\d{8,}$/.test(s)) return s;
    }
  }
  for (const k of ["target_id", "targetId"]) {
    const v = di[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (/^\d{8,}$/.test(s)) return s;
  }
  return "";
}

/**
 * 从 CHANNEL_MSG 提取频道消息（content / extra 为嵌套 JSON 字符串）。
 * @param {unknown} frameRoot
 * @returns {{ channelId: string; guildId: string; hist: import("./kookMessages.js").KookHistMsg } | null}
 */
export function tryExtractChannelMsgFromWsFrameJson(frameRoot) {
  if (!isObj(frameRoot)) return null;
  const di = /** @type {Record<string, unknown>} */ (
    /** @type {Record<string, unknown>} */ (frameRoot).d
  );
  if (!isObj(di) || String(di.type ?? "") !== "CHANNEL_MSG") return null;

  const inner = parseChannelMsgInner(di);
  if (!inner) return null;

  let extraRaw = inner.extra;
  if (typeof extraRaw === "string" && extraRaw.trim()) {
    try {
      extraRaw = JSON.parse(extraRaw);
    } catch {
      extraRaw = {};
    }
  }
  const ex = isObj(extraRaw) ? /** @type {Record<string, unknown>} */ (extraRaw) : {};

  const guildId = String(ex.guild_id ?? "").trim();
  if (!guildId) return null;

  const channelId = pickChannelIdFromEnvelope(ex, di);
  const author = isObj(ex.author) ? /** @type {Record<string, unknown>} */ (ex.author) : {};
  const km = isObj(inner.kmarkdown) ? /** @type {Record<string, unknown>} */ (inner.kmarkdown) : {};

  let content = String(inner.content ?? "").trim();
  if (!content) content = String(km.raw_content ?? "").trim();
  if (!content) return null;

  const authorId = String(author.id ?? di.fromUserId ?? "").trim();
  const msgId = String(di.msgId ?? "").trim();
  const msgTs = Number(di.msgTimestamp);
  const create_at = !Number.isNaN(msgTs) && msgTs > 0 ? msgTs : Date.now();

  /** @type {import("./kookMessages.js").KookHistMsg} */
  const hist = {
    id: msgId || `ws-ch-${guildId}-${create_at}`,
    content,
    create_at,
    authorId,
    authorUsername: String(author.username ?? "").trim(),
    authorNickname: String(author.nickname ?? "").trim(),
    authorIdentifyNum: String(author.identify_num ?? author.identifyNum ?? "").trim(),
    authorDisplayName: String(author.nickname ?? author.username ?? "未知用户").trim() || "未知用户",
    authorAvatar: typeof author.avatar === "string" ? author.avatar.trim() : "",
    bot: Boolean(author.bot),
    type: Number(ex.type ?? inner.type ?? 1) || 1,
    raw: {
      _kookWsChannelMsg: true,
      envelope: di,
      parsed: inner,
    },
  };

  return { channelId, guildId, hist };
}

/**
 * 从普通网关帧（非 SYS_MSG 桌面通知路径）尝试取频道 id，用于未读 +1。
 * @param {unknown} frameRoot
 * @returns {string | null}
 */
export function tryExtractChannelIdFromGatewayFrame(frameRoot) {
  if (!isObj(frameRoot)) return null;
  const root = /** @type {Record<string, unknown>} */ (frameRoot);
  const d = root.d;
  if (!isObj(d)) return null;
  const di = /** @type {Record<string, unknown>} */ (d);

  if (String(di.type ?? "") === "SYS_MSG") return null;

  for (const k of ["channel_id", "channelId"]) {
    const v = di[k];
    if (v == null) continue;
    const s = String(v).trim();
    if (/^\d{8,}$/.test(s)) return s;
  }

  const extra = di.extra;
  if (isObj(extra)) {
    const ex = /** @type {Record<string, unknown>} */ (extra);
    for (const k of ["channel_id", "channelId"]) {
      const v = ex[k];
      if (v == null) continue;
      const s = String(v).trim();
      if (/^\d{8,}$/.test(s)) return s;
    }
  }

  const v2 = di.target_id;
  if (v2 != null) {
    const s2 = String(v2).trim();
    if (/^\d{8,}$/.test(s2) && (di.channel_type != null || di.channelType != null)) return s2;
  }

  return null;
}
