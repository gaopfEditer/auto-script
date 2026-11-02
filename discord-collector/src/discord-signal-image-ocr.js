/**
 * 信号频道图片 OCR：下载 → OCR → 晒单/开仓判定 → 指纹去重。
 */
import { config } from "./config.js";
import { extractAttachmentsForClient } from "./discord-message-format.js";
import { isDiscordSignalOcrChannel } from "./discord-signal-ocr-config.js";
import { ocrDiscordImageUrl } from "./discord-signal-ocr-client.js";
import {
  buildOcrSignalFingerprint,
  classifyOcrPoster,
  normalizeOcrText,
} from "./discord-signal-ocr-parser.js";
import { createOcrSignalFingerprintDedup } from "./discord-signal-ocr-dedup.js";
import { normalizeSignalText } from "./discord-signal-dedup.js";

const ocrDedup = createOcrSignalFingerprintDedup();

/** @param {unknown} att */
function isImageAttachment(att) {
  const a = att != null && typeof att === "object" && !Array.isArray(att) ? att : null;
  if (!a) return false;
  const ct = String(a.contentType ?? a.content_type ?? "").toLowerCase();
  const fn = String(a.filename ?? "").toLowerCase();
  if (ct.startsWith("image/")) return true;
  return /\.(png|jpe?g|gif|webp|bmp)$/i.test(fn);
}

/**
 * @param {Record<string, unknown>} row
 * @returns {Array<{ url: string; filename: string; contentType: string }>}
 */
export function pickImageAttachmentsFromRow(row) {
  const rawJson = row.rawJson ?? row.raw_json;
  const attachments = Array.isArray(row.attachments)
    ? row.attachments
    : extractAttachmentsForClient(rawJson);
  /** @type {Array<{ url: string; filename: string; contentType: string }>} */
  const out = [];
  for (const item of attachments) {
    if (!isImageAttachment(item)) continue;
    const a = /** @type {Record<string, unknown>} */ (item);
    const url = String(a.url ?? a.proxyUrl ?? a.proxy_url ?? "").trim();
    if (!url) continue;
    out.push({
      url,
      filename: String(a.filename ?? "image.jpg").trim() || "image.jpg",
      contentType: String(a.contentType ?? a.content_type ?? "image/jpeg").trim() || "image/jpeg",
    });
  }
  return out;
}

/**
 * @typedef {{
 *   skipped?: string;
 *   content?: string;
 *   parsed?: Record<string, unknown>;
 *   ocrText?: string;
 *   profitRatePct?: number | null;
 * }} OcrSignalResolveResult
 */

/**
 * @param {Record<string, unknown>} row
 * @param {{ log?: { info: Function; warn: Function; debug?: Function } }} [opts]
 * @returns {Promise<OcrSignalResolveResult | null>} null = 不需要 OCR
 */
export async function resolveSignalFromRowWithOcr(row, opts = {}) {
  const channelId = String(row.channelId ?? row.channel_id ?? "").trim();
  if (!isDiscordSignalOcrChannel(channelId)) return null;

  const images = pickImageAttachmentsFromRow(row);
  if (!images.length) return null;

  const first = images[0];
  const messageId = String(row.messageId ?? row.message_id ?? "").trim();

  opts.log?.info?.(
    `信号 OCR 开始 channel=${channelId} message=${messageId || "?"} images=${images.length}`,
  );

  const ocr = await ocrDiscordImageUrl(first.url, {
    filename: first.filename,
    contentType: first.contentType,
    log: opts.log,
  });

  const ocrText = normalizeOcrText(
    String(ocr.text ?? "") ||
      (Array.isArray(ocr.lines)
        ? ocr.lines.map((l) => String(l?.text ?? "")).join("\n")
        : ""),
  );

  if (!ocrText) {
    opts.log?.warn?.(
      `信号 OCR 无文本 channel=${channelId} message=${messageId || "?"} error=${ocr.error || "empty"}`,
    );
    return { skipped: "ocr_failed" };
  }

  const { profitRatePct, isShowOff, parsed } = classifyOcrPoster(
    ocrText,
    config.discordSignalOcrOpenMaxProfitPct,
  );

  if (isShowOff) {
    opts.log?.info?.(
      `信号 OCR 晒单跳过 channel=${channelId} message=${messageId || "?"} profit=${profitRatePct ?? "?"}%`,
    );
    return { skipped: "ocr_show_off", ocrText, profitRatePct };
  }

  if (parsed) {
    const fp = buildOcrSignalFingerprint(parsed);
    if (fp && ocrDedup.isDuplicate(channelId, fp)) {
      opts.log?.info?.(
        `信号 OCR 指纹去重 channel=${channelId} message=${messageId || "?"} fp=${fp}`,
      );
      return { skipped: "ocr_fingerprint_dedup", ocrText, profitRatePct };
    }

    const enriched = {
      ...parsed,
      profitRatePct: profitRatePct ?? undefined,
      ocrText: ocrText.slice(0, 4000),
    };

    const textBody = normalizeSignalText(String(row.content ?? ""));
    const content = textBody
      ? `${textBody}\n--- OCR ---\n${ocrText}`
      : ocrText;

    return {
      content,
      parsed: enriched,
      ocrText,
      profitRatePct,
      /** @type {string | undefined} */
      fingerprint: fp || undefined,
    };
  }

  // 无明确盈利率或无法结构化：把 OCR 文本当作正文走常规 parser
  const textBody = normalizeSignalText(String(row.content ?? ""));
  const content = textBody ? `${textBody}\n${ocrText}` : ocrText;
  opts.log?.debug?.(
    `信号 OCR 回退文本解析 channel=${channelId} message=${messageId || "?"} profit=${profitRatePct ?? "n/a"}`,
  );
  return { content, ocrText, profitRatePct };
}

/** @param {string} channelId @param {string} fingerprint */
export function rememberOcrSignalFingerprint(channelId, fingerprint) {
  if (!fingerprint) return;
  ocrDedup.remember(channelId, fingerprint);
}

/** 单测重置指纹去重 */
export function resetOcrSignalDedupForTests() {
  if (typeof ocrDedup.clearForTests === "function") ocrDedup.clearForTests();
}
