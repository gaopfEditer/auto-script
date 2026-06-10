/**
 * Discord 频道消息 → Telegram：实时或 2 分钟静默后批量转发。
 */
import { config } from "./config.js";
import {
  isTelegramPushChannel,
  isTelegramRealtimeChannel,
  telegramPushChannelLabel,
  getTelegramRealtimeChannelIds,
} from "./discord-telegram-push-config.js";
import { createDiscordSignalTelegramPush } from "./discord-signal-telegram.js";

/** @typedef {{
 *   messageId?: string;
 *   channelId?: string;
 *   channelName?: string;
 *   authorUsername?: string;
 *   authorGlobalName?: string;
 *   content?: string;
 *   createdAtMs?: number;
 * }} DiscordMessageRow */

const TELEGRAM_TEXT_MAX = 4000;

/**
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 */
export function createDiscordTelegramMessagePush(log) {
  const telegram = createDiscordSignalTelegramPush(log);
  const debounceMs = Math.max(5_000, Number(config.telegramPushDebounceMs) || 120_000);

  /** @type {Map<string, { items: DiscordMessageRow[], timer: ReturnType<typeof setTimeout> | null }>} */
  const buffers = new Map();

  /**
   * @param {DiscordMessageRow} row
   * @returns {string}
   */
  function formatLine(row) {
    const ch = telegramPushChannelLabel(String(row.channelId ?? ""), String(row.channelName ?? ""));
    const author =
      String(row.authorGlobalName ?? "").trim() ||
      String(row.authorUsername ?? "").trim() ||
      "未知";
    const body = String(row.content ?? "").trim();
    return `【${ch}】\n${author}\n${body}`;
  }

  /**
   * @param {DiscordMessageRow[]} rows
   * @returns {string}
   */
  function formatBatch(rows) {
    const text = rows.map(formatLine).join("\n\n—\n\n");
    if (text.length <= TELEGRAM_TEXT_MAX) return text;
    return `${text.slice(0, TELEGRAM_TEXT_MAX - 24)}\n\n…(已截断)`;
  }

  /**
   * @param {string} channelId
   * @param {DiscordMessageRow[]} rows
   */
  async function sendBatch(channelId, rows) {
    if (!rows.length) return;
    const text = formatBatch(rows);
    try {
      const result = await telegram.send(text, {
        channelId,
        batch: rows.length,
        kind: "message_batch",
        skipChannelLabel: true,
      });
      if (result.skipped) {
        log.debug(`[telegram-push] 跳过 channel=${channelId} reason=${result.skipped}`);
        return;
      }
      log.info(`[telegram-push] 已推送 channel=${channelId} count=${rows.length}`);
    } catch (e) {
      log.warn(`[telegram-push] 推送失败 channel=${channelId}: ${/** @type {Error} */ (e).message}`);
    }
  }

  /** @param {string} channelId */
  async function flushChannel(channelId) {
    const buf = buffers.get(channelId);
    if (!buf) return;
    if (buf.timer) {
      clearTimeout(buf.timer);
      buf.timer = null;
    }
    const items = buf.items.splice(0);
    if (!items.length) return;
    await sendBatch(channelId, items);
  }

  /** @param {DiscordMessageRow} row */
  async function sendImmediate(row) {
    const channelId = String(row.channelId ?? "").trim();
    if (!channelId) return;
    await sendBatch(channelId, [row]);
  }

  /** @param {DiscordMessageRow} row */
  function enqueue(row) {
    if (!telegram.enabled) return;
    const channelId = String(row.channelId ?? "").trim();
    const content = String(row.content ?? "").trim();
    if (!channelId || !content || !isTelegramPushChannel(channelId)) return;

    if (isTelegramRealtimeChannel(channelId)) {
      void sendImmediate(row);
      return;
    }

    let buf = buffers.get(channelId);
    if (!buf) {
      buf = { items: [], timer: null };
      buffers.set(channelId, buf);
    }
    buf.items.push(row);
    if (buf.timer) clearTimeout(buf.timer);
    buf.timer = setTimeout(() => {
      void flushChannel(channelId);
    }, debounceMs);
    log.debug(
      `[telegram-push] 缓冲 channel=${channelId} pending=${buf.items.length} wait=${debounceMs}ms`
    );
  }

  async function flushAll() {
    const ids = [...buffers.keys()];
    for (const id of ids) {
      await flushChannel(id);
    }
  }

  if (telegram.enabled) {
    log.info(
      `[telegram-push] 已启用 debounce=${debounceMs}ms realtime=${[...getTelegramRealtimeChannelIds()].join(",") || "无"}`
    );
  }

  return {
    enqueue,
    flushAll,
    flushChannel,
    enabled: telegram.enabled,
    debounceMs,
    telegram,
  };
}
