import { resolveKolvipAssetUrl } from "./kolvip-cdp-config.js";

/** @param {unknown} im */
function imageUrlFromApiMedia(im) {
  if (!im) return "";
  if (typeof im === "string") return im.trim();
  if (typeof im === "object") {
    const o = /** @type {{ url?: string, full?: string, data_full?: string }} */ (im);
    return String(o.url ?? o.full ?? o.data_full ?? "").trim();
  }
  return "";
}

/**
 * files[] 里只收图片。images[] 由字段名保证是图。
 * @param {unknown} im
 * @param {string} url
 */
function looksLikeImageMedia(im, url) {
  if (im && typeof im === "object") {
    const o = /** @type {{ type?: string, content_type?: string, mime?: string, kind?: string }} */ (im);
    const ct = String(o.type ?? o.content_type ?? o.mime ?? o.kind ?? "").toLowerCase();
    if (ct.startsWith("image/") || ct === "image") return true;
    if (ct && !ct.startsWith("image/")) return false;
  }
  const pathOnly = String(url).split("?")[0].toLowerCase();
  if (/\.(png|jpe?g|gif|webp|bmp|heic)$/.test(pathOnly)) return true;
  if (/\.(pdf|zip|mp4|mov|m4v|txt|json|csv|mp3|ogg|wav)$/.test(pathOnly)) return false;
  return true;
}

/**
 * 保留全部图片 URL。images 非空时不用 files，避免同一张图的附件副本被当成相册。
 * @param {Record<string, unknown>} raw
 * @returns {string[]}
 */
export function kolvipImageUrlsFromRaw(raw) {
  const images = Array.isArray(raw.images) ? raw.images : [];
  const files = Array.isArray(raw.files) ? raw.files : [];
  /** @type {unknown[]} */
  const list = images.length
    ? images
    : files.filter((f) => looksLikeImageMedia(f, imageUrlFromApiMedia(f)));
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const im of list) {
    const abs = resolveKolvipAssetUrl(imageUrlFromApiMedia(im));
    if (!abs || seen.has(abs)) continue;
    seen.add(abs);
    out.push(abs);
  }
  return out;
}

/**
 * @param {Record<string, unknown>} raw
 * @returns {import('./kolvip-cdp-message.js').KolvipDomMessage}
 */
export function kolvipApiRawToDomMessage(raw) {
  const dataId = String(raw.id ?? "").trim();
  const imageUrls = kolvipImageUrlsFromRaw(raw);
  const timeMs = Number(raw.time);
  const timeTitle = Number.isFinite(timeMs) ? new Date(timeMs).toISOString() : "";
  return {
    dataId,
    text: String(raw.text ?? "").trim(),
    author: String(raw.author ?? "").trim(),
    timeText: "",
    timeTitle,
    imageUrl: imageUrls[0] || "",
    imageUrls,
  };
}
