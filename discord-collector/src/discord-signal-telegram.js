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
async function sendViaBotApi(chatId, text, botToken, timeoutMs, log) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: controller.signal,
    });
    const raw = await r.text().catch(() => "");
    let parsed = null;
    try {
      parsed = raw ? JSON.parse(raw) : null;
    } catch {
      /* ignore */
    }
    if (!r.ok || !parsed?.ok) {
      throw new Error(`Bot API HTTP ${r.status}${raw ? `: ${raw.slice(0, 200)}` : ""}`);
    }
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

export function createDiscordSignalTelegramPush(log) {
  const chatId = config.telegramPushChatId;
  const sendUrl = config.telegramSendUrl;
  const botToken = config.telegramBotToken;
  const enabled = Boolean(chatId && (sendUrl || botToken));

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

    log.info(`[telegram] content:\n${body}`);

    const timeoutMs = config.telegramSendTimeoutMs;
    if (sendUrl) {
      log.info(
        formatPipelineLog("tg_http_post", {
          cardId: meta.cardId ?? "?",
          channelId: meta.channelId ?? "?",
          channelName: meta.channelName ?? "",
          chatId,
          detail: sendUrl,
        }),
      );
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
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
      } catch (e) {
        log.warn(
          `[telegram] HTTP 网关失败: ${/** @type {Error} */ (e).message}${
            botToken ? "，尝试 Bot API" : ""
          }`,
        );
        if (!botToken) throw e;
      } finally {
        clearTimeout(timer);
      }
    }

    if (botToken) {
      await sendViaBotApi(chatId, body, botToken, timeoutMs, log);
      log.info(
        formatPipelineLog("tg_http_ok", {
          cardId: meta.cardId ?? "?",
          channelId: meta.channelId ?? "?",
          chatId,
          detail: "bot_api",
        }),
      );
      return { ok: true };
    }

    throw new Error("未配置 TELEGRAM_SEND_URL 或 TELEGRAM_BOT_TOKEN");
  }

  if (enabled) {
    log.info(
      `Discord 信号 Telegram 推送已启用 chat=${chatId} transport=${sendUrl ? "gateway" : "bot"}${sendUrl && botToken ? "+bot_fallback" : ""}`,
    );
  }

  return { send, enabled, chatId, sendUrl };
}
