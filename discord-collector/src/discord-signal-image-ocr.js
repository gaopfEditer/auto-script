/**
 * 信号频道图片 OCR：下载 → OCR → 晒单/开仓判定 → 指纹去重。
 */
import { config } from "./config.js";
import { extractAttachmentsForClient } from "./discord-message-format.js";
import { resolveSignalContentFromRow } from "./discord-reply-content.js";
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
 * 去掉图片 URL 后还剩下的正文。只剩附件地址不算「配文」。
 * @param {Record<string, unknown>} row
 * @param {Array<{ url: string }>} [images]
 */
export function pangmaoAccompanyingText(row, images = pickImageAttachmentsFromRow(row)) {
  const content = resolveSignalContentFromRow(row);
  if (!content) return "";
  const urls = new Set(images.map((img) => String(img.url ?? "").trim()).filter(Boolean));
  const kept = content
    .split(/\s+/)
    .map((tok) => tok.trim())
    .filter((tok) => tok && !urls.has(tok));
  return kept.join(" ").trim();
}

/**
 * 胖猫图片消息形态。只有 single_image 走 PaddleOCR。
 * @param {Record<string, unknown>} row
 * @returns {"single_image"|"image_with_text"|"album"|"album_with_text"|"text"|"empty"}
 */
export function classifyPangmaoImagePost(row) {
  const images = pickImageAttachmentsFromRow(row);
  const text = pangmaoAccompanyingText(row, images);
  if (images.length > 1) return text ? "album_with_text" : "album";
  if (images.length === 1) return text ? "image_with_text" : "single_image";
  return text ? "text" : "empty";
}

/**
 * @typedef {{
 *   skipped?: string;
 *   content?: string;
 *   parsed?: Record<string, unknown>;
 *   ocrText?: string;
 *   profitRatePct?: number | null;
 *   fingerprint?: string;
 * }} OcrSignalResolveResult
 */

/**
 * @param {Record<string, unknown>} row
 * @param {{
 *   log?: { info: Function; warn: Function; debug?: Function };
 *   ocrImage?: typeof ocrDiscordImageUrl;
 *   yieldThreshold?: number;
 * }} [opts]
 * @returns {Promise<OcrSignalResolveResult | null>} null = 不走 OCR（无图、配文、相册，或非 OCR 频道）
 */
export async function resolveSignalFromRowWithOcr(row, opts = {}) {
  const channelId = String(row.channelId ?? row.channel_id ?? "").trim();
  if (!isDiscordSignalOcrChannel(channelId)) return null;

  const kind = classifyPangmaoImagePost(row);
  if (kind !== "single_image") {
    if (kind === "album" || kind === "album_with_text" || kind === "image_with_text") {
      opts.log?.debug?.(
        `胖猫图片不走 OCR kind=${kind} channel=${channelId} message=${row.messageId ?? row.message_id ?? "?"}`,
      );
    }
    return null;
  }

  const images = pickImageAttachmentsFromRow(row);
  const first = images[0];
  const messageId = String(row.messageId ?? row.message_id ?? "").trim();
  const ocrImage = opts.ocrImage ?? ocrDiscordImageUrl;

  opts.log?.info?.(
    `胖猫单图 OCR 开始 channel=${channelId} message=${messageId || "?"}`,
  );

  /** @type {import("./discord-signal-ocr-client.js").OcrResponse} */
  let ocr;
  try {
    ocr = await ocrImage(first.url, {
      filename: first.filename,
      contentType: first.contentType,
      log: opts.log,
    });
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message ?? e);
    opts.log?.warn?.(
      `PaddleOCR 调用异常，跳过本条（监听继续）channel=${channelId} message=${messageId || "?"}: ${msg}`,
    );
    return { skipped: "ocr_failed" };
  }

  const ocrText = normalizeOcrText(
    String(ocr.text ?? "") ||
      (Array.isArray(ocr.lines)
        ? ocr.lines.map((l) => String(l?.text ?? "")).join("\n")
        : ""),
  );

  if (!ocrText) {
    opts.log?.warn?.(
      `PaddleOCR 不可达或无文本，跳过本条（监听继续）channel=${channelId} message=${messageId || "?"} error=${ocr.error || "empty"}`,
    );
    return { skipped: "ocr_failed" };
  }

  const threshold = opts.yieldThreshold ?? config.discordSignalOcrOpenMaxProfitPct;
  const decision = classifyOcrPoster(ocrText, threshold);
  const { profitRatePct, parsed, reason } = decision;

  if (reason === "missing_yield") {
    opts.log?.info?.(
      `胖猫单图 OCR 未解析到收益率，不出卡 channel=${channelId} message=${messageId || "?"}`,
    );
    return { skipped: "ocr_missing_yield", ocrText, profitRatePct };
  }
  if (reason === "missing_fields") {
    opts.log?.info?.(
      `胖猫单图 OCR 未解析到币种或方向，不出卡 channel=${channelId} message=${messageId || "?"} yield=${profitRatePct}`,
    );
    return { skipped: "ocr_missing_fields", ocrText, profitRatePct };
  }
  if (reason === "yield_gate" || !parsed) {
    opts.log?.info?.(
      `胖猫单图 OCR 收益率未过门槛，不出卡 channel=${channelId} message=${messageId || "?"} yield=${profitRatePct ?? "?"}% threshold<${threshold}`,
    );
    return { skipped: "ocr_yield_gate", ocrText, profitRatePct };
  }

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
  const content = textBody ? `${textBody}\n--- OCR ---\n${ocrText}` : ocrText;

  return {
    content,
    parsed: enriched,
    ocrText,
    profitRatePct,
    fingerprint: fp || undefined,
  };
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
