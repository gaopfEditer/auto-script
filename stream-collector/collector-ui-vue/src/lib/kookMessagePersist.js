/**
 * 将 Show 页合并后的消息批量 POST 到 `/api/kook/messages`（服务端 INSERT IGNORE 去重）。
 */

/** @type {Map<string, Record<string, unknown>>} */
const pendingByMessageId = new Map();
let flushTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);

/**
 * @param {import("./kookMessages.js").KookHistMsg[]} messages
 * @param {{ guildId?: string, channelId: string }} ctx
 */
export function queueKookMessagesForPersist(messages, ctx) {
  const guildId = String(ctx.guildId ?? "").trim();
  const channelId = String(ctx.channelId ?? "").trim();
  if (!channelId) return;

  for (const m of messages) {
    const messageId = String(m.id ?? "").trim();
    if (!messageId) continue;
    const raw = m.raw;
    const wsDesktop =
      raw && typeof raw === "object" && /** @type {Record<string, unknown>} */ (raw)._kookWsDesktopNotification;
    pendingByMessageId.set(messageId, {
      messageId,
      guildId,
      channelId,
      authorId: String(m.authorId ?? "").trim(),
      createAtMs: Number(m.create_at) || 0,
      content: m.content ?? "",
      msgType: m.type ?? null,
      authorUsername: m.authorUsername || null,
      authorNickname: m.authorNickname || null,
      source: wsDesktop ? "ws_desktop" : "frontend",
      rawJson: raw && typeof raw === "object" ? raw : null,
    });
  }

  if (flushTimer) clearTimeout(flushTimer);
  flushTimer = setTimeout(() => {
    flushTimer = null;
    void flushKookMessagePersistQueue();
  }, 800);
}

async function flushKookMessagePersistQueue() {
  if (pendingByMessageId.size === 0) return;
  const messages = Array.from(pendingByMessageId.values());
  pendingByMessageId.clear();
  try {
    await fetch("/api/kook/messages", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ messages }),
    });
  } catch {
    for (const row of messages) {
      const id = String(row.messageId ?? "");
      if (id) pendingByMessageId.set(id, row);
    }
  }
}
