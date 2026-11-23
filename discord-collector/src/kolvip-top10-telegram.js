/**
 * kolvip Show 胜率榜前 10 频道 → 信号卡片镜像 TG 群。
 */
import { config } from "./config.js";
import { createDiscordSignalTelegramPush } from "./discord-signal-telegram.js";
import { getKolvipMappedDiscordChannelIds } from "./kolvip-cdp-config.js";
import { parseKolvipScanVirtualChannelId } from "./kolvip-scan-config.js";
import {
  getKolvipTop10TelegramChannelIds,
  isKolvipTop10TelegramCardChannel,
} from "./discord-telegram-push-config.js";
import {
  markTelegramCardPushSent,
  shouldSkipTelegramCardPushDuplicate,
} from "./telegram-card-push-dedup.js";

/**
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 */
export function createKolvipTop10CardTelegramPush(log) {
  const chatId = config.kolvipTop10TelegramChatId;
  if (!chatId) return null;
  return createDiscordSignalTelegramPush(log, { chatId, label: "kolvip-top10-cards" });
}

/**
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {ReturnType<typeof createDiscordSignalTelegramPush> | null} sender
 * @param {string} channelId
 * @param {string} bodyText
 * @param {Record<string, unknown>} [meta]
 */
/** @returns {Promise<boolean>} 是否已发送 */
export async function mirrorKolvipTop10SignalCardTelegram(log, sender, channelId, bodyText, meta = {}) {
  if (!sender?.enabled) return false;
  const cid = String(channelId ?? "").trim();
  if (!cid || !isKolvipTop10TelegramCardChannel(cid)) return false;
  const text = String(bodyText ?? "").trim();
  if (!text) return false;
  try {
    const res = await sender.send(text, { ...meta, channelId: cid, kind: "kolvip_top10_card" });
    if (!res?.ok) return false;
    log.info(`[kolvip-top10-tg] 卡片镜像 channel=${cid} card=${meta.cardId ?? "?"}`);
    return true;
  } catch (e) {
    log.warn(`[kolvip-top10-tg] 推送失败 channel=${cid}: ${/** @type {Error} */ (e).message}`);
    throw e;
  }
}

/**
 * 主交易群未推时（巨鲸 scan / skipTelegram）仍向 top10 镜像群发卡。
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {ReturnType<typeof createDiscordSignalTelegramPush> | null} sender
 * @param {{
 *   text?: string,
 *   channelId?: string,
 *   channelName?: string,
 *   cardId?: string | number,
 *   messageId?: string,
 *   symbol?: string,
 * }} input
 */
/**
 * 巨鲸来源信号卡应只进 KOLVIP_TOP10_TELEGRAM_CHAT_ID，不进 TELEGRAM_PUSH 主群。
 * @param {string} channelId
 * @param {{ kolvipIngest?: boolean }} [opts]
 */
export function isKolvipSignalCardTelegramRoute(channelId, opts = {}) {
  const id = String(channelId ?? "").trim();
  if (!id) return false;
  if (opts.kolvipIngest) return true;
  if (parseKolvipScanVirtualChannelId(id)) return true;
  if (isKolvipTop10TelegramCardChannel(id)) return true;
  if (getKolvipMappedDiscordChannelIds().has(id)) return true;
  return false;
}

/**
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {ReturnType<typeof createDiscordSignalTelegramPush> | null} sender
 * @param {Parameters<typeof sendKolvipTop10CardMirrorOnly>[2]} input
 * @param {{ requireTop10Channel?: boolean }} [opts]
 */
export async function sendKolvipSignalCardTelegramOnly(log, sender, input, opts = {}) {
  if (!sender?.enabled) return { skipped: "kolvip_top10_disabled" };
  const channelId = String(input.channelId ?? "").trim();
  const bodyText = String(input.text ?? "").trim();
  if (!bodyText) return { skipped: "empty" };
  const requireTop10 = opts.requireTop10Channel === true;
  if (requireTop10 && !isKolvipTop10TelegramCardChannel(channelId)) {
    return { skipped: "not_top10_channel" };
  }
  if (
    !requireTop10 &&
    !isKolvipTop10TelegramCardChannel(channelId) &&
    !isKolvipSignalCardTelegramRoute(channelId, { kolvipIngest: true })
  ) {
    return { skipped: "not_kolvip_channel" };
  }
  const dedupInput = {
    channelId,
    symbol: String(input.symbol ?? "").trim(),
    bodyText,
    cardId: input.cardId ?? null,
    messageRef: String(input.messageId ?? "").trim(),
  };
  if (shouldSkipTelegramCardPushDuplicate(dedupInput)) {
    return { skipped: "duplicate_message" };
  }
  try {
    const sent = await sender.send(bodyText, {
      channelId,
      channelName: input.channelName,
      cardId: input.cardId,
      kind: "kolvip_signal_card",
    });
    if (!sent?.ok) {
      const reason = String(sent?.skipped ?? "send_failed");
      log.warn(`[kolvip-top10-tg] 未发送 channel=${channelId} card=${input.cardId ?? "?"} reason=${reason}`);
      return { skipped: reason };
    }
    markTelegramCardPushSent(dedupInput);
    log.info(`[kolvip-top10-tg] 巨鲸信号卡 channel=${channelId} card=${input.cardId ?? "?"} chat=${config.kolvipTop10TelegramChatId}`);
    return { ok: true, kolvipOnly: true };
  } catch (e) {
    const errMsg = String(/** @type {Error} */ (e).message ?? e);
    log.warn(`[kolvip-top10-tg] 巨鲸专群推送失败 channel=${channelId}: ${errMsg}`);
    return { error: errMsg };
  }
}

export async function sendKolvipTop10CardMirrorOnly(log, sender, input) {
  if (!sender?.enabled) return { skipped: "kolvip_top10_disabled" };
  const channelId = String(input.channelId ?? "").trim();
  const bodyText = String(input.text ?? "").trim();
  if (!bodyText) return { skipped: "empty" };
  if (!isKolvipTop10TelegramCardChannel(channelId)) return { skipped: "not_top10_channel" };

  const dedupInput = {
    channelId,
    symbol: String(input.symbol ?? "").trim(),
    bodyText,
    cardId: input.cardId ?? null,
    messageRef: String(input.messageId ?? "").trim(),
  };
  if (shouldSkipTelegramCardPushDuplicate(dedupInput)) {
    return { skipped: "duplicate_message" };
  }

  try {
    const sent = await mirrorKolvipTop10SignalCardTelegram(log, sender, channelId, bodyText, {
      channelId,
      channelName: input.channelName,
      cardId: input.cardId,
    });
    if (!sent) return { skipped: "not_top10_channel" };
    markTelegramCardPushSent(dedupInput);
    return { ok: true, mirrorOnly: true };
  } catch (e) {
    const errMsg = String(/** @type {Error} */ (e).message ?? e);
    log.warn(`[kolvip-top10-tg] 独立镜像失败 channel=${channelId}: ${errMsg}`);
    return { error: errMsg };
  }
}

export { getKolvipTop10TelegramChannelIds, isKolvipTop10TelegramCardChannel };