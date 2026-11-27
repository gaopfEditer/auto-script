/**
 * 信号频道消息 → 卡片服务（Gateway / REST / kolvip 共用）。
 */
import { resolveSignalContentFromRow } from "./discord-reply-content.js";
import { getSignalChannelConfig, isSignalChannel } from "./discord-signal-config.js";
import { shouldTelegramPushSignalChannelComment } from "./discord-telegram-push-config.js";
import { resolveSignalFromRowWithOcr } from "./discord-signal-image-ocr.js";
import { isDiscordSignalOcrChannel } from "./discord-signal-ocr-config.js";
import { shouldBypassDiscordSignalChannel } from "./kolvip-cdp-config.js";
import {
  isKolvipIngestSource,
  upgradeKolvipSignalCardSourceFromRow,
} from "./discord-signal-card-source.js";
import { buildPangmaoPriorityDisplayCard } from "./discord-signal-parsers.js";
import {
  buildPangmaoPriorityEnqueueBody,
  enqueuePriorityCard,
} from "./priority-queue-client.js";
import { appendKolvipPipelineAudit, auditCardId } from "./kolvip-pipeline-audit-log.js";
import { isAutoTradeChannel } from "./trade-platform-toggles.js";

/** 单图 OCR 已判定不出卡：不要再把 OCR 文本交给正文 parser。 */
const OCR_TERMINAL_SKIPS = new Set([
  "ocr_show_off",
  "ocr_yield_gate",
  "ocr_fingerprint_dedup",
  "ocr_missing_yield",
  "ocr_missing_fields",
]);

/**
 * @typedef {{
 *   signalCards: ReturnType<typeof import("./discord-signal-card-service.js").createDiscordSignalCardService>,
 *   store: ReturnType<typeof import("./store.js").openStore>,
 *   log: ReturnType<typeof import("./logger.js").createLogger>,
 *   telegramPush?: ReturnType<typeof import("./discord-telegram-message-push.js").createDiscordTelegramMessagePush> | null,
 *   respectKolvipBypass?: boolean,
 *   skipTelegram?: boolean,
 *   skipKolvipTop10Mirror?: boolean,
 *   kolvipIngest?: boolean,
 *   skipOllamaFallback?: boolean,
 *   ocrImage?: import("./discord-signal-ocr-client.js").ocrDiscordImageUrl,
 *   enqueuePriority?: typeof enqueuePriorityCard,
 * }} SignalPipelineDeps
 */

/** @param {Record<string, unknown>} r */
function rowAttachmentCount(r) {
  const raw = r.rawJson ?? r.raw_json;
  if (!raw || typeof raw !== "object") return 0;
  const att = /** @type {{ attachments?: unknown[] }} */ (raw).attachments;
  return Array.isArray(att) ? att.length : 0;
}

/** 仅 OCR 白名单频道（非 kolvip 全量带图）；与 discord-signal-ocr-config 一致。 */
export function isSignalIngestOcrEligible(channelId) {
  const cid = String(channelId ?? "").trim();
  return cid.length > 0 && isSignalChannel(cid) && isDiscordSignalOcrChannel(cid);
}

/**
 * @param {Record<string, unknown>[]} rows
 * @param {SignalPipelineDeps} deps
 * @returns {Promise<{ rows: number, created: number, sourceUpgraded: number, skipCounts: Record<string, number> }>}
 */
export async function runSignalCardPipelineForRows(rows, deps) {
  const {
    signalCards,
    store,
    log,
    telegramPush,
    respectKolvipBypass = true,
    skipTelegram = false,
    skipKolvipTop10Mirror = false,
    kolvipIngest: kolvipIngestFlag = false,
    skipOllamaFallback = false,
    ocrImage,
    enqueuePriority = enqueuePriorityCard,
  } = deps;
  /** @type {Record<string, number>} */
  const skipCounts = {};
  const bump = (/** @type {string} */ k) => {
    skipCounts[k] = (skipCounts[k] || 0) + 1;
  };
  let created = 0;
  let sourceUpgraded = 0;

  if (!signalCards || !rows.length) {
    return { rows: rows.length, created: 0, sourceUpgraded: 0, skipCounts };
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
    const ocrEligible = isSignalIngestOcrEligible(cid);

    if (ocrEligible) {
      const ocrResolved = await resolveSignalFromRowWithOcr(r, { log, ocrImage });
      if (ocrResolved?.skipped && OCR_TERMINAL_SKIPS.has(String(ocrResolved.skipped))) {
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
      if (isKolvipIngestSource(src) && mid && store.getSignalCardByMessageId) {
        const existing = await store.getSignalCardByMessageId(mid);
        if (existing) {
          const up = await upgradeKolvipSignalCardSourceFromRow(store, r, log);
          if (up.upgraded) {
            sourceUpgraded += 1;
            bump("source_upgraded");
            continue;
          }
        }
      }
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
        kolvipIngest: kolvipIngestFlag || src.startsWith("kolvip"),
        skipKolvipTop10Mirror: skipKolvipTop10Mirror,
        skipAiFallback: skipOllamaFallback || Boolean(ocrPreParsed),
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
    } else if (skipped === "source_upgraded") {
      sourceUpgraded += 1;
      bump("source_upgraded");
    } else if (skipped) {
      log.info(
        `信号 ingest 未建卡 channel=${cid} message=${r.messageId} reason=${skipped} source=${src || "-"}`
      );
      bump(skipped);
    } else {
      bump("unknown");
    }
    if (isKolvipIngestSource(src) || isAutoTradeChannel(cid)) {
      const cardObj =
        cardResult?.card && typeof cardResult.card === "object"
          ? /** @type {Record<string, unknown>} */ (cardResult.card)
          : null;
      appendKolvipPipelineAudit(cardObj || cardResult?.merged ? "card_create" : "ingest", {
        channelId: cid,
        channelName: String(r.channelName ?? r.channel_name ?? ""),
        messageId: String(r.messageId ?? r.message_id ?? ""),
        source: src || "unknown",
        cardId: auditCardId(cardObj?.id),
        symbol: String(cardObj?.symbol ?? ""),
        direction: String(
          (cardObj?.execution && typeof cardObj.execution === "object"
            ? /** @type {Record<string, unknown>} */ (cardObj.execution).direction
            : "") ?? "",
        ),
        result: cardObj ? "created" : cardResult?.merged ? "merged" : skipped || "unknown",
        reason: skipped || undefined,
      });
    }
    if (cardResult?.card || cardResult?.merged || skipped !== "parse_failed") {
      await signalCards.dedup.remember(cid, content);
    }

    const parserKind = getSignalChannelConfig(cid)?.parser;
    let priorityCard = cardResult?.card ?? null;
    // 有交易意图但建卡失败（解析返回 null）时仍推展示卡。单图 OCR 的门槛跳过不走这里。
    if (!priorityCard && parserKind === "pangmao" && skipped === "parse_failed" && !ocrPreParsed) {
      priorityCard = buildPangmaoPriorityDisplayCard(content, {
        messageId: String(r.messageId ?? r.message_id ?? ""),
        channelId: cid,
      });
    }

    const enqueueBody = buildPangmaoPriorityEnqueueBody({
      parser: parserKind,
      card: priorityCard,
      skipped,
      via: ocrPreParsed?.ocrPoster ? "ocr" : "text",
      yieldPct: ocrPreParsed?.profitRatePct,
    });
    if (enqueueBody) {
      // 不 await：队列超时或不可达不能挡住已经发出的信号卡。
      void Promise.resolve(enqueuePriority(enqueueBody, { log })).catch((e) => {
        log.warn(
          `胖猫优先队列入队异常（出卡不受影响）: ${/** @type {Error} */ (e).message ?? e}`,
        );
      });
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
      `巨鲸 ingest 批次汇总 rows=${rows.length} created=${created} sourceUpgraded=${sourceUpgraded} skips=${JSON.stringify(skipCounts)}`
    );
  }

  return { rows: rows.length, created, sourceUpgraded, skipCounts };
}
