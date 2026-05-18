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
