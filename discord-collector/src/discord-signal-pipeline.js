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
 *   skipTelegram?: boolean,
 * }} SignalPipelineDeps
 */

/** @param {Record<string, unknown>} r */
function rowAttachmentCount(r) {
  const raw = r.rawJson ?? r.raw_json;
  if (!raw || typeof raw !== "object") return 0;
  const att = /** @type {{ attachments?: unknown[] }} */ (raw).attachments;
  return Array.isArray(att) ? att.length : 0;
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {SignalPipelineDeps} deps
 * @returns {Promise<{ rows: number, created: number, skipCounts: Record<string, number> }>}
 */
export async function runSignalCardPipelineForRows(rows, deps) {
  const { signalCards, store, log, telegramPush, respectKolvipBypass = true, skipTelegram = false } =
    deps;
  /** @type {Record<string, number>} */
  const skipCounts = {};
  const bump = (/** @type {string} */ k) => {
    skipCounts[k] = (skipCounts[k] || 0) + 1;
  };
  let created = 0;

  if (!signalCards || !rows.length) {
    return { rows: rows.length, created: 0, skipCounts };
  }
  await signalCards.ensureHydrated();
  let kolvipBatch = false;

  for (const r of rows) {
    const cid = String(r.channelId ?? r.channel_id ?? "").trim();
    if (!cid) {
      bump("no_channel");
      continue;
    }
    const src = String(r.source ?? "").trim();
    if (src.startsWith("kolvip")) kolvipBatch = true;

    if (respectKolvipBypass && shouldBypassDiscordSignalChannel(cid)) {
      bump("bypass_discord");
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
    const attN = rowAttachmentCount(r);
    const ocrEligible =
      isSignalChannel(cid) &&
      (isDiscordSignalOcrChannel(cid) || (src.startsWith("kolvip") && attN > 0));

    if (ocrEligible) {
      const ocrResolved = await resolveSignalFromRowWithOcr(r, { log });
      if (ocrResolved?.skipped === "ocr_show_off" || ocrResolved?.skipped === "ocr_fingerprint_dedup") {
        bump(String(ocrResolved.skipped));
        continue;
      }
      if (ocrResolved?.skipped === "ocr_failed" && !content) {
        log.info(
          `信号 ingest 跳过 OCR 失败且无正文 channel=${cid} message=${r.messageId} attachments=${attN} source=${src || "-"}`
        );
        bump("ocr_failed");
        continue;
      }
      if (ocrResolved?.content) {
        content = ocrResolved.content;
        ocrPreParsed = ocrResolved.parsed;
        ocrFingerprint = ocrResolved.fingerprint;
      }
    }

    if (!content) {
      if (isSignalChannel(cid) || src.startsWith("kolvip")) {
        log.info(
          `信号 ingest 跳过空正文 channel=${cid} message=${r.messageId} attachments=${attN} ocr=${ocrEligible ? "yes" : "no"} source=${src || "-"}`
        );
      }
      bump("empty_content");
      continue;
    }
    if (!isSignalChannel(cid)) {
      bump("not_signal_channel");
      continue;
    }
    if (signalCards.dedup.isDuplicate(cid, content)) {
      const mid = String(r.messageId ?? r.message_id ?? "").trim();
      let allowRetry = false;
      if (mid && store.getSignalCardByMessageId) {
        const existing = await store.getSignalCardByMessageId(mid);
        if (!existing) allowRetry = true;
      }
      if (!allowRetry) {
        log.info(
          `信号 ingest 跳过正文去重 channel=${cid} message=${mid || "?"} source=${src || "-"} preview=${content.slice(0, 60)}`
        );
        bump("duplicate_text");
        continue;
      }
      log.info(
        `信号正文曾处理但未建卡，重试 channel=${cid} message=${mid} preview=${content.slice(0, 60)}`
      );
    }
    log.info(
      `信号卡片处理 channel=${cid} message=${r.messageId} source=${src || "unknown"} preview=${content.slice(0, 60)}`
    );
    /** @type {{ skipped?: string, card?: Record<string, unknown>, merged?: unknown } | undefined} */
    let cardResult;
    try {
      cardResult = await signalCards.onMessage(r, {
        skipDedup: true,
        skipTelegram: skipTelegram,
        contentOverride: content,
        preParsed: ocrPreParsed,
        ocrFingerprint,
      });
    } catch (e) {
      log.warn(`signal card: ${/** @type {Error} */ (e).message}`);
      bump("on_message_error");
      continue;
    }
    const skipped = String(cardResult?.skipped ?? "");
    if (cardResult?.card || cardResult?.merged) {
      created += 1;
    } else if (skipped) {
      log.info(
        `信号 ingest 未建卡 channel=${cid} message=${r.messageId} reason=${skipped} source=${src || "-"}`
      );
      bump(skipped);
    } else {
      bump("unknown");
    }
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

  if (kolvipBatch) {
    log.info(
      `巨鲸 ingest 批次汇总 rows=${rows.length} created=${created} skips=${JSON.stringify(skipCounts)}`
    );
  }

  return { rows: rows.length, created, skipCounts };
}
