/**
 * 非 Discord 卡片 → 可跳转的原帖/源站 URL（币安广场、X、Telegram 等）。
 */
import {
  resolveAuthorLabelFromParsed,
  resolveSourcePlatform,
} from "./card-archive-service.js";

const HTTP_IN_TEXT = /https?:\/\/[^\s<>"')]+/gi;
const BINANCE_POST_IN_URL = /binance\.com\/.*\/square\/post\/\d+/i;
const X_STATUS_IN_URL = /(?:x\.com|twitter\.com)\//i;
const TG_IN_URL = /t\.me\//i;

/** @param {string} url */
function trimUrlTail(url) {
  return String(url ?? "")
    .trim()
    .replace(/[.,;)\]]+$/, "")
    .split("#")[0];
}

/** @param {string} note */
function firstPostUrlInNote(note) {
  const n = String(note ?? "").trim();
  if (!n) return null;
  const parts = n.split(/\s*·\s*/);
  for (const part of parts) {
    const hits = part.match(HTTP_IN_TEXT);
    if (!hits) continue;
    for (const raw of hits) {
      const u = trimUrlTail(raw);
      if (/127\.0\.0\.1|localhost|:3851\//i.test(u)) continue;
      if (BINANCE_POST_IN_URL.test(u) || X_STATUS_IN_URL.test(u) || TG_IN_URL.test(u)) return u;
    }
  }
  const all = n.match(HTTP_IN_TEXT);
  if (!all) return null;
  for (const raw of all) {
    const u = trimUrlTail(raw);
    if (/127\.0\.0\.1|localhost|:3851\//i.test(u)) continue;
    if (BINANCE_POST_IN_URL.test(u) || X_STATUS_IN_URL.test(u) || TG_IN_URL.test(u)) return u;
  }
  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} card
 * @returns {string|null}
 */
function urlFromParsed(card) {
  const parsed =
    card?.parsedJson && typeof card.parsedJson === "object"
      ? /** @type {Record<string, unknown>} */ (card.parsedJson)
      : {};
  for (const key of ["url", "shareUrl", "webLink", "postUrl", "href", "sourceUrl", "tweetUrl"]) {
    const u = trimUrlTail(String(parsed[key] ?? ""));
    if (/^https?:\/\//i.test(u)) return u;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} card
 * @returns {string|null}
 */
function binancePostUrl(card) {
  const fromNote = firstPostUrlInNote(String(card.note ?? ""));
  if (fromNote && BINANCE_POST_IN_URL.test(fromNote)) return fromNote;

  const fromParsed = urlFromParsed(card);
  if (fromParsed && BINANCE_POST_IN_URL.test(fromParsed)) return fromParsed;

  const messageId = String(card.messageId ?? "").trim();
  if (messageId.startsWith("binance-")) {
    const id = messageId.slice("binance-".length);
    if (/^\d+$/.test(id)) return `https://www.binance.com/zh-CN/square/post/${id}`;
  }

  const sourceRef = String(card.sourceRef ?? "").trim();
  if (/^\d+$/.test(sourceRef)) {
    return `https://www.binance.com/zh-CN/square/post/${sourceRef}`;
  }
  return null;
}

/**
 * @param {Record<string, unknown>} card
 * @returns {string|null}
 */
function xPostUrl(card) {
  const fromNote = firstPostUrlInNote(String(card.note ?? ""));
  if (fromNote && X_STATUS_IN_URL.test(fromNote)) return fromNote;

  const fromParsed = urlFromParsed(card);
  if (fromParsed && X_STATUS_IN_URL.test(fromParsed)) return fromParsed;

  const messageId = String(card.messageId ?? "").trim();
  const sourceRef = String(card.sourceRef ?? "").trim();
  let tweetId = "";
  if (messageId.startsWith("x-")) tweetId = messageId.slice(2);
  else if (/^\d+$/.test(sourceRef)) tweetId = sourceRef;

  if (!tweetId) return null;

  const handle = resolveAuthorLabelFromParsed(card.parsedJson);
  if (handle && !/\s/.test(handle)) {
    return `https://x.com/${handle.replace(/^@/, "")}/status/${tweetId}`;
  }
  return `https://x.com/i/status/${tweetId}`;
}

/**
 * @param {string} chatId
 * @returns {string}
 */
function telegramChatPath(chatId) {
  const s = String(chatId ?? "").trim();
  if (s.startsWith("-100")) return s.slice(4);
  return s.replace(/^-/, "");
}

/**
 * @param {Record<string, unknown>} card
 * @returns {string|null}
 */
function telegramPostUrl(card) {
  const fromNote = firstPostUrlInNote(String(card.note ?? ""));
  if (fromNote && TG_IN_URL.test(fromNote)) return fromNote;

  const parsed =
    card.parsedJson && typeof card.parsedJson === "object"
      ? /** @type {Record<string, unknown>} */ (card.parsedJson)
      : {};
  const username = String(parsed.telegramUsername ?? parsed.chatUsername ?? "")
    .trim()
    .replace(/^@/, "");

  const sourceRef = String(card.sourceRef ?? "").trim();
  const tgRef = sourceRef.match(/^tg:(-?\d+):([\d,]+)/i);
  if (tgRef) {
    const chatId = tgRef[1];
    const msgId = tgRef[2].split(",")[0];
    if (username) return `https://t.me/${username}/${msgId}`;
    return `https://t.me/c/${telegramChatPath(chatId)}/${msgId}`;
  }

  const msgOnly = sourceRef.match(/^(\d+)$/);
  const channelId = String(card.channelId ?? "").trim();
  if (msgOnly && /^-?\d+$/.test(channelId)) {
    if (username) return `https://t.me/${username}/${msgOnly[1]}`;
    return `https://t.me/c/${telegramChatPath(channelId)}/${msgOnly[1]}`;
  }

  return null;
}

/**
 * @param {Record<string, unknown> | null | undefined} card
 * @returns {string|null}
 */
export function resolveCardSourcePostUrl(card) {
  if (!card || typeof card !== "object") return null;

  const platform = resolveSourcePlatform(card.sourceType);
  const messageId = String(card.messageId ?? "").trim();

  const fromNote = firstPostUrlInNote(String(card.note ?? ""));
  if (fromNote) return fromNote;

  const fromParsed = urlFromParsed(card);
  if (fromParsed) return fromParsed;

  if (platform === "binance" || messageId.startsWith("binance-")) {
    return binancePostUrl(card);
  }
  if (platform === "x" || messageId.startsWith("x-")) {
    return xPostUrl(card);
  }
  if (platform === "telegram") {
    return telegramPostUrl(card);
  }

  return null;
}