/**
 * 信号频道消息 → 卡片服务（Gateway / REST / kolvip 共用）。
 */
import { resolveSignalContentFromRow } from "./discord-reply-content.js";
import { isSignalChannel } from "./discord-signal-config.js";
import { shouldTelegramPushSignalChannelComment } from "./discord-telegram-push-config.js";
import { resolveSignalFromRowWithOcr } from "./discord-signal-image-ocr.js";
import { isDiscordSignalOcrChannel } from "./discord-signal-ocr-config.js";
import { shouldBypassDiscordSignalChannel } from "./kolvip-cdp-config.js";

/**
 * @typedef {{
 *   signalCards: ReturnType<typeof import("./discord-signal-card-service.js").createDiscordSignalCardService>,
 *   store: ReturnType<typeof import("./store.js").openStore>,
 *   log: ReturnType<typeof import("./logger.js").createLogger>,
 *   telegramPush?: ReturnType<typeof import("./discord-telegram-message-push.js").createDiscordTelegramMessagePush> | null,
 *   respectKolvipBypass?: boolean,
 * }} SignalPipelineDeps
 */

/**
 * @param {Record<string, unknown>[]} rows
 * @param {SignalPipelineDeps} deps
 */
export async function runSignalCardPipelineForRows(rows, deps) {
  const { signalCards, store, log, telegramPush, respectKolvipBypass = true } = deps;
  if (!signalCards || !rows.length) return;
  await signalCards.ensureHydrated();
  for (const r of rows) {
    const cid = String(r.channelId ?? r.channel_id ?? "").trim();
    if (!cid) continue;
    if (respectKolvipBypass && shouldBypassDiscordSignalChannel(cid)) {
      log.debug(
        `信号卡片旁路 Discord 建卡（巨鲸临时源已接管）channel=${cid} message=${r.messageId ?? "?"}`
      );
      continue;
    }

    let content = resolveSignalContentFromRow(r);
    /** @type {string | undefined} */
    let ocrFingerprint;
    /** @type {Record<string, unknown> | undefined} */
    let ocrPreParsed;

    if (isSignalChannel(cid) && isDiscordSignalOcrChannel(cid)) {
      const ocrResolved = await resolveSignalFromRowWithOcr(r, { log });
      if (ocrResolved?.skipped === "ocr_show_off" || ocrResolved?.skipped === "ocr_fingerprint_dedup") {
        continue;
      }
      if (ocrResolved?.skipped === "ocr_failed" && !content) {
        log.debug(
          `信号卡片 OCR 失败且无正文 channel=${cid} message=${r.messageId}`,
        );
        continue;
      }
      if (ocrResolved?.content) {
        content = ocrResolved.content;
        ocrPreParsed = ocrResolved.parsed;
        ocrFingerprint = ocrResolved.fingerprint;
      }
    }

    if (!content) {
      if (isSignalChannel(cid)) {
        log.debug(
          `信号卡片跳过空正文 channel=${cid} message=${r.messageId}（若仅图片需 OCR/人工）`
        );
      }
      continue;
    }
    if (!isSignalChannel(cid)) continue;
    if (signalCards.dedup.isDuplicate(cid, content)) {
      const mid = String(r.messageId ?? r.message_id ?? "").trim();
      let allowRetry = false;
      if (mid && store.getSignalCardByMessageId) {
        const existing = await store.getSignalCardByMessageId(mid);
        if (!existing) allowRetry = true;
      }
      if (!allowRetry) {
        log.debug(`信号卡片跳过重复 channel=${cid} preview=${content.slice(0, 80)}`);
        continue;
      }
      log.info(
        `信号正文曾处理但未建卡，重试 channel=${cid} message=${mid} preview=${content.slice(0, 60)}`
      );
    }
    const src = String(r.source ?? "");
    log.info(
      `信号卡片处理 channel=${cid} message=${r.messageId} source=${src || "unknown"} preview=${content.slice(0, 60)}`
    );
    /** @type {{ skipped?: string, card?: Record<string, unknown>, merged?: unknown } | undefined} */
    let cardResult;
    try {
      cardResult = await signalCards.onMessage(r, {
        skipDedup: true,
        contentOverride: content,
        preParsed: ocrPreParsed,
        ocrFingerprint,
      });
    } catch (e) {
      log.warn(`signal card: ${/** @type {Error} */ (e).message}`);
      continue;
    }
    const skipped = String(cardResult?.skipped ?? "");
    if (cardResult?.card || cardResult?.merged || skipped !== "parse_failed") {
      await signalCards.dedup.remember(cid, content);
    }

    if (
      telegramPush?.enabled &&
      src === "gateway_ws" &&
      cardResult?.skipped === "parse_failed" &&
      shouldTelegramPushSignalChannelComment(cid, content)
    ) {
      telegramPush.enqueue(r);
      log.info(
        `大镖客 commentary → Telegram channel=${cid} message=${r.messageId ?? "?"}`
      );
    }
  }
}
