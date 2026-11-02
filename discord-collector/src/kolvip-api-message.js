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
 * @param {Record<string, unknown>} raw
 * @returns {import('./kolvip-cdp-message.js').KolvipDomMessage}
 */
export function kolvipApiRawToDomMessage(raw) {
  const dataId = String(raw.id ?? "").trim();
  const images = Array.isArray(raw.images) ? raw.images : [];
  const files = Array.isArray(raw.files) ? raw.files : [];
  let imageUrl = "";
  for (const im of images) {
    imageUrl = imageUrlFromApiMedia(im);
    if (imageUrl) break;
  }
  if (!imageUrl) {
    for (const f of files) {
      imageUrl = imageUrlFromApiMedia(f);
      if (imageUrl) break;
    }
  }
  const timeMs = Number(raw.time);
  const timeTitle = Number.isFinite(timeMs) ? new Date(timeMs).toISOString() : "";
  return {
    dataId,
    text: String(raw.text ?? "").trim(),
    author: String(raw.author ?? "").trim(),
    timeText: "",
    timeTitle,
    imageUrl: resolveKolvipAssetUrl(imageUrl),
  };
}
