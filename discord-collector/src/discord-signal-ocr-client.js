/**
 * 本机 OCR 服务客户端：GET /health，POST /ocr（multipart），POST /ocr/base64。
 */
import { config } from "./config.js";

/**
 * @typedef {{
 *   success?: boolean;
 *   text?: string;
 *   lines?: Array<{ text?: string; confidence?: number; box?: unknown }>;
 *   error?: string;
 * }} OcrResponse
 */

/** @param {string} [baseUrl] */
export async function checkOcrHealth(baseUrl = config.discordSignalOcrBaseUrl) {
  const root = String(baseUrl ?? "").trim().replace(/\/$/, "");
  if (!root) return { ok: false, error: "empty base url" };
  try {
    const res = await fetch(`${root}/health`, {
      signal: AbortSignal.timeout(config.discordSignalOcrTimeoutMs),
    });
    if (!res.ok) return { ok: false, error: `HTTP ${res.status}` };
    return { ok: true };
  } catch (e) {
    return { ok: false, error: String(/** @type {Error} */ (e).message ?? e) };
  }
}

/**
 * @param {Buffer | Uint8Array} buffer
 * @param {{ filename?: string; mimeType?: string; baseUrl?: string }} [opts]
 * @returns {Promise<OcrResponse>}
 */
export async function ocrImageBuffer(buffer, opts = {}) {
  const root = String(opts.baseUrl ?? config.discordSignalOcrBaseUrl).trim().replace(/\/$/, "");
  const filename = opts.filename || "discord-image.jpg";
  const mimeType = opts.mimeType || "image/jpeg";
  const timeout = config.discordSignalOcrTimeoutMs;

  /** @type {OcrResponse} */
  let lastErr = { success: false, error: "ocr failed" };

  try {
    const form = new FormData();
    form.append("file", new Blob([buffer], { type: mimeType }), filename);
    const res = await fetch(`${root}/ocr`, {
      method: "POST",
      body: form,
      signal: AbortSignal.timeout(timeout),
    });
    const data = /** @type {OcrResponse} */ (await res.json().catch(() => ({})));
    if (res.ok && data.success !== false) return data;
    lastErr = { success: false, error: data.error || `HTTP ${res.status}` };
  } catch (e) {
    lastErr = { success: false, error: String(/** @type {Error} */ (e).message ?? e) };
  }

  try {
    const b64 = Buffer.from(buffer).toString("base64");
    const res = await fetch(`${root}/ocr/base64`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ image_base64: b64 }),
      signal: AbortSignal.timeout(timeout),
    });
    const data = /** @type {OcrResponse} */ (await res.json().catch(() => ({})));
    if (res.ok && data.success !== false) return data;
    lastErr = { success: false, error: data.error || lastErr.error || `HTTP ${res.status}` };
  } catch (e) {
    lastErr = {
      success: false,
      error: lastErr.error || String(/** @type {Error} */ (e).message ?? e),
    };
  }

  return lastErr;
}

/**
 * 从 Discord CDN 拉取图片并 OCR（仅第一张）。
 * @param {string} url
 * @param {{ filename?: string; contentType?: string; log?: { warn: Function } }} [opts]
 */
export async function ocrDiscordImageUrl(url, opts = {}) {
  const pick = String(url ?? "").trim();
  if (!pick) return { success: false, error: "empty url" };

  let buffer;
  try {
    const res = await fetch(pick, {
      headers: {
        Accept: "image/*,*/*;q=0.8",
        Referer: "https://discord.com/",
        "User-Agent":
          "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(Math.max(config.discordSignalOcrTimeoutMs, 20_000)),
    });
    if (!res.ok) {
      opts.log?.warn?.(`OCR 图片下载失败 HTTP ${res.status} url=${pick.slice(0, 80)}`);
      return { success: false, error: `download HTTP ${res.status}` };
    }
    buffer = Buffer.from(await res.arrayBuffer());
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message ?? e);
    opts.log?.warn?.(`OCR 图片下载异常 url=${pick.slice(0, 80)}: ${msg}`);
    return { success: false, error: msg };
  }

  const ct = opts.contentType || "image/jpeg";
  const fn = opts.filename || "discord.jpg";
  const ocr = await ocrImageBuffer(buffer, { filename: fn, mimeType: ct });
  if (ocr.success === false && !ocr.text) {
    opts.log?.warn?.(`OCR 服务失败: ${ocr.error || "unknown"} url=${pick.slice(0, 80)}`);
  }
  return ocr;
}
