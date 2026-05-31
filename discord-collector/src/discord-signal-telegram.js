/**
 * Discord 信号卡片 → Telegram 推送。
 */
import { config } from "./config.js";

/**
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 */
export function createDiscordSignalTelegramPush(log) {
  const chatId = config.telegramPushChatId;
  const sendUrl = config.telegramSendUrl;
  const enabled = Boolean(chatId && sendUrl);

  /**
   * @param {string} text
   * @param {{ channelId?: string, cardId?: number }} [meta]
   */
  async function send(text, meta = {}) {
    if (!enabled) return { skipped: "telegram_disabled" };
    const body = String(text ?? "").trim();
    if (!body) return { skipped: "empty" };

    log.info(`[telegram] POST ${sendUrl} chat=${chatId} channel=${meta.channelId ?? "?"}`);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), config.telegramSendTimeoutMs);
    try {
      const r = await fetch(sendUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: body }),
        signal: controller.signal,
      });
      const resp = await r.text().catch(() => "");
      if (!r.ok) {
        throw new Error(`HTTP ${r.status}${resp ? `: ${resp.slice(0, 200)}` : ""}`);
      }
      return { ok: true };
    } finally {
      clearTimeout(timer);
    }
  }

  if (enabled) {
    log.info(`Discord 信号 Telegram 推送已启用 chat=${chatId}`);
  }

  return { send, enabled, chatId, sendUrl };
}
