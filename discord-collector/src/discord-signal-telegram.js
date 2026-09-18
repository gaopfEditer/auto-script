/**
 * Discord 信号卡片 → Telegram 推送。
 */
import { config } from "./config.js";
import {
  formatTelegramWithChannelLabel,
  stripTelegramAtUsernameMentions,
  isSpamMessage,
} from "./discord-telegram-push-config.js";
import { formatPipelineLog } from "./signal-pipeline-log.js";

/**
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 */
export function createDiscordSignalTelegramPush(log) {
  const chatId = config.telegramPushChatId;
  const sendUrl = config.telegramSendUrl;
  const enabled = Boolean(chatId && sendUrl);

  /**
   * @param {string} text
   * @param {{ channelId?: string, channelName?: string, skipChannelLabel?: boolean, cardId?: number, batch?: number, kind?: string }} [meta]
   */
  async function send(text, meta = {}) {
    if (!enabled) return { skipped: "telegram_disabled" };
    let body = meta.skipChannelLabel
      ? stripTelegramAtUsernameMentions(String(text ?? "").trim())
      : formatTelegramWithChannelLabel(text, meta.channelId, meta.channelName);
    body = stripTelegramAtUsernameMentions(body);
    // 过滤"引导私聊/转账"类垃圾消息
    if (isSpamMessage(body)) {
      log.info(
        formatPipelineLog("tg_http_skip", {
          cardId: meta.cardId ?? "?",
          channelId: meta.channelId ?? "?",
          chatId,
          reason: "spam",
        }),
      );
      return { skipped: "spam" };
    }
    if (!body) return { skipped: "empty" };

    log.info(
      formatPipelineLog("tg_http_post", {
        cardId: meta.cardId ?? "?",
        channelId: meta.channelId ?? "?",
        channelName: meta.channelName ?? "",
        chatId,
        detail: sendUrl,
      }),
    );
    log.info(`[telegram] content:\n${body}`);

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
      log.info(
        formatPipelineLog("tg_http_ok", {
          cardId: meta.cardId ?? "?",
          channelId: meta.channelId ?? "?",
          chatId,
        }),
      );
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
