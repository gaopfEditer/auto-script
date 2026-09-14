/**
 * Telegram 卡片推送去重（同卡 / 同正文）。
 */
import crypto from "node:crypto";

const WINDOW_MS = Math.max(
  60_000,
  Number(process.env.TELEGRAM_CARD_PUSH_DEDUP_MS ?? 30 * 60_000),
);

/** @type {Map<string, number>} */
const recentByKey = new Map();

/** 头部含这些标记时跳过去重（测试用，默认【周一今日测试】） */
export function telegramPushBypassMarkers() {
  return String(process.env.TELEGRAM_PUSH_BYPASS_MARKERS ?? "【周一今日测试】")
    .split(/[,，|]/)
    .map((s) => s.trim())
    .filter(Boolean);
}

/** @param {...unknown} texts */
export function isTelegramPushBypassMessage(...texts) {
  const markers = telegramPushBypassMarkers();
  if (!markers.length) return false;
  for (const raw of texts) {
    const s = String(raw ?? "");
    if (!s.trim()) continue;
    if (markers.some((m) => s.includes(m))) return true;
  }
  return false;
}

/** @param {string} text */
export function normalizeTelegramPushBody(text) {
  let s = String(text ?? "").trim();
  if (!s) return "";
  s = s.replace(/\n*【追溯】[^\n]*(?:\n|$)/g, "").trim();
  const m = s.match(/^【[^】]+】\s*\n?([\s\S]*)$/);
  if (m) s = m[1].trim();
  return s.replace(/\s+/g, " ").trim();
}

/**
 * @param {Record<string, unknown> | null | undefined} card
 * @param {string} [overrideRef]
 */
export function resolveTelegramMessageRef(card, overrideRef) {
  const fromOverride = String(overrideRef ?? "").trim();
  if (fromOverride) return fromOverride;
  if (!card || typeof card !== "object") return "";
  const ref = String(card.sourceRef ?? card.source_ref ?? "").trim();
  if (ref) return ref;
  return String(card.messageId ?? card.message_id ?? "").trim();
}

/**
 * @param {{ channelId?: string, symbol?: string, bodyText?: string, cardId?: number | null, messageRef?: string, sourceRef?: string }} input
 */
export function buildTelegramPushDedupKey(input) {
  const channelId = String(input.channelId ?? "").trim();
  const msgRef = String(input.messageRef ?? input.sourceRef ?? "").trim();
  if (channelId && msgRef) {
    return `ch:${channelId}:ref:${msgRef}`;
  }
  const symbol = String(input.symbol ?? "").trim().toUpperCase();
  const body = normalizeTelegramPushBody(String(input.bodyText ?? ""));
  const hash = crypto.createHash("sha256").update(body).digest("hex").slice(0, 24);
  if (input.cardId != null && String(input.cardId).trim()) {
    return `id:${input.cardId}:${hash}`;
  }
  return `ch:${channelId}:${symbol}:${hash}`;
}

/**
 * @param {{ channelId?: string, symbol?: string, bodyText: string, cardId?: number | null }} input
 */
export function shouldSkipTelegramCardPushDuplicate(input) {
  if (isTelegramPushBypassMessage(input.bodyText)) return false;
  const key = buildTelegramPushDedupKey(input);
  const now = Date.now();
  const prev = recentByKey.get(key);
  if (prev != null && now - prev < WINDOW_MS) return true;
  return false;
}

/**
 * @param {{ channelId?: string, symbol?: string, bodyText: string, cardId?: number | null }} input
 */
export function markTelegramCardPushSent(input) {
  if (isTelegramPushBypassMessage(input.bodyText)) return;
  const key = buildTelegramPushDedupKey(input);
  const now = Date.now();
  recentByKey.set(key, now);
  if (recentByKey.size > 800) {
    for (const [k, t] of recentByKey) {
      if (now - t > WINDOW_MS) recentByKey.delete(k);
    }
  }
}
