/**
 * 巨鲸 API 消息正文：补齐 API 币种字段，供解析与 Show 共用。
 */
import { formatMessageTextForDisplay } from "./message-text-format.js";

/** @param {unknown} raw */
export function kolvipCoinFromApiRaw(raw) {
  if (!raw || typeof raw !== "object") return "";
  const o = /** @type {Record<string, unknown>} */ (raw);
  const coin = String(o.coin ?? o.symbol ?? o.pair ?? o.currency ?? "").trim();
  if (!coin) return "";
  return coin.replace(/\/USDT$/i, "").replace(/^\$/, "").split("/")[0].toUpperCase();
}

/**
 * @param {string} text 已 format 的正文
 * @param {string} [coin]
 */
export function prependKolvipCoinToMessageText(text, coin) {
  const body = String(text ?? "").trim();
  const sym = String(coin ?? "").trim().toUpperCase();
  if (!sym || !body) return body;
  if (new RegExp(`(?:币种|coin)\\s*[:：]\\s*#?${sym}\\b`, "i").test(body)) return body;
  if (new RegExp(`\\b#?${sym}\\b`, "i").test(body.slice(0, 120))) return body;
  return `币种：${sym}\n${body}`;
}

/**
 * @param {unknown} raw API / WS data
 * @param {{ preserveLines?: boolean }} [opts]
 */
export function kolvipMessageTextFromApiRaw(raw, opts = { preserveLines: true }) {
  const text = formatMessageTextForDisplay(
    raw && typeof raw === "object" ? (/** @type {Record<string, unknown>} */ (raw).text ?? "") : raw,
    { preserveLines: opts.preserveLines !== false }
  );
  const coin = kolvipCoinFromApiRaw(raw);
  return prependKolvipCoinToMessageText(text, coin);
}