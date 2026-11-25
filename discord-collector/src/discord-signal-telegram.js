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
import { preferSingleLanguageSignalText } from "./message-text-format.js";
import { fetch as undiciFetch, ProxyAgent } from "undici";

/** @type {import("undici").Dispatcher | undefined} */
let telegramApiDispatcher;

/** @returns {import("undici").Dispatcher | undefined} */
function getTelegramApiDispatcher() {
  const proxy = String(config.telegramSendProxy ?? "").trim();
  if (!proxy) return undefined;
  if (!telegramApiDispatcher) telegramApiDispatcher = new ProxyAgent(proxy);
  return telegramApiDispatcher;
}

/** @param {unknown} err */
function formatTelegramFetchError(err) {
  const e = /** @type {{ message?: string, cause?: { code?: string, message?: string } }} */ (err);
  const msg = String(e?.message ?? err);
  const cause = e?.cause;
  if (!cause) return msg;
  const extra = [cause.code, cause.message].filter(Boolean).join(" ");
  return extra ? `${msg}: ${extra}` : msg;
}


/**
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 */
async function sendViaBotApi(chatId, text, botToken, timeoutMs, log) {
  const url = `https://api.telegram.org/bot${botToken}/sendMessage`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const dispatcher = getTelegramApiDispatcher();
    const r = await undiciFetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: controller.signal,
      ...(dispatcher ? { dispatcher } : {}),
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
  } catch (e) {
    const already = String(/** @type {Error} */ (e).message ?? e);
    if (already.startsWith("Bot API HTTP")) throw e;
    throw new Error(`Bot API ${formatTelegramFetchError(e)}`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {{ chatId?: string | number, label?: string }} [opts]
 */
export function createDiscordSignalTelegramPush(log, opts = {}) {
  const override = opts.chatId != null && String(opts.chatId).trim() !== "";
  const chatId = override ? opts.chatId : config.telegramPushChatId;
  const sendUrl = config.telegramSendUrl;
  const botToken = config.telegramBotToken;
  const enabled = Boolean(chatId && (sendUrl || botToken));
  const label = String(opts.label ?? "").trim();
  const kolvipTop10Chat =
    label === "kolvip-top10-cards" ||
    (config.kolvipTop10TelegramChatId != null &&
      String(config.kolvipTop10TelegramChatId) !== "" &&
      String(chatId) === String(config.kolvipTop10TelegramChatId));

  /**
   * @param {string} text
   * @param {{ channelId?: string, channelName?: string, skipChannelLabel?: boolean, cardId?: number, batch?: number, kind?: string }} [meta]
   */
  async function send(text, meta = {}) {
    if (!enabled) return { skipped: "telegram_disabled" };
    const deduped = preferSingleLanguageSignalText(String(text ?? "").trim(), "zh");
    let body = meta.skipChannelLabel
      ? stripTelegramAtUsernameMentions(deduped)
      : formatTelegramWithChannelLabel(deduped, meta.channelId, meta.channelName);
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
    /** 巨鲸 top10 专群：Bot 直发（网关常用另一 token，易 chat not found） */
    if (kolvipTop10Chat && botToken) {
      try {
        await sendViaBotApi(chatId, body, botToken, timeoutMs, log);
        log.info(
          formatPipelineLog("tg_http_ok", {
            cardId: meta.cardId ?? "?",
            channelId: meta.channelId ?? "?",
            chatId,
            detail: "bot_api_first",
          }),
        );
        return { ok: true };
      } catch (e) {
        log.warn(
          `[telegram] top10 群 Bot API 失败: ${/** @type {Error} */ (e).message}${
            sendUrl ? "，尝试 HTTP 网关" : ""
          }`,
        );
        if (!sendUrl) throw e;
      }
    }
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
          `[telegram] HTTP 网关失败: ${formatTelegramFetchError(e)}${
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
    const tag = label ? ` label=${label}` : "";
    log.info(
      `Discord 信号 Telegram 推送已启用 chat=${chatId}${tag} transport=${sendUrl ? "gateway" : "bot"}${sendUrl && botToken ? "+bot_fallback" : ""}${config.telegramSendProxy ? " bot_api_proxy=on" : ""}`,
    );
  }

  return { send, enabled, chatId, sendUrl };
}
