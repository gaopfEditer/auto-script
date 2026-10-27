/**
 * Telegram 卡片推送去重（同卡 / 同正文 / 高相似正文）。
 */
import crypto from "node:crypto";

const WINDOW_MS = Math.max(
  60_000,
  Number(process.env.TELEGRAM_CARD_PUSH_DEDUP_MS ?? 30 * 60_000),
);

/** 同频道+币种：正文行集合 Jaccard ≥ 该值视为重复（默认 0.8） */
const SIMILAR_RATIO = Math.min(
  1,
  Math.max(0.5, Number(process.env.TELEGRAM_CARD_PUSH_SIMILAR_RATIO ?? 0.8)),
);

/** @type {Map<string, number>} */
const recentByKey = new Map();

/**
 * @type {Map<string, { ts: number, body: string, tpsl: Set<string> }[]>}
 * key: ch:{channelId}:sym:{symbol}
 */
const recentSimilarByScope = new Map();

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

/** @param {string} body */
function inferSymbolFromBody(body) {
  const s = String(body ?? "");
  const hash = s.match(/#([A-Za-z0-9]{2,16})\b/);
  if (hash) return hash[1].toUpperCase();
  return "";
}

/** @param {string} text */
function extractTpslNumbers(text) {
  /** @type {Set<string>} */
  const nums = new Set();
  const s = String(text ?? "");
  for (const line of s.split(/\n/)) {
    if (!/止盈|止损|止損|TP|SL|take[\s-]*profit|stop[\s-]*loss|目标价|目标位/i.test(line)) {
      continue;
    }
    for (const m of line.matchAll(/(\d+(?:\.\d+)?)/g)) {
      nums.add(m[1]);
    }
  }
  return nums;
}

/** @param {string} text */
function stripChannelHeaderForCompare(text) {
  let s = String(text ?? "").trim();
  if (!s) return "";
  s = s.replace(/\n*【追溯】[^\n]*(?:\n|$)/g, "").trim();
  const m = s.match(/^【[^】]+】\s*\n?([\s\S]*)$/);
  if (m) s = m[1].trim();
  return s;
}

/** @param {string} line */
function normalizeCompareLine(line) {
  let s = String(line ?? "").trim();
  if (!s) return "";
  try {
    s = s.replace(/\p{Extended_Pictographic}/gu, "");
  } catch {
    s = s.replace(/[\u{1F300}-\u{1FAFF}]/gu, "");
  }
  return s
    .toLowerCase()
    .replace(/[ \t]+/g, " ")
    .replace(/[，,。．·•｜|]/g, " ")
    .trim();
}

/** @param {string} text */
function normalizeForSimilarity(text) {
  const s = stripChannelHeaderForCompare(text);
  if (!s) return "";
  const lines = s
    .split(/\n/)
    .map((l) => normalizeCompareLine(l))
    .filter(Boolean);
  return [...new Set(lines)].sort().join("\n");
}

/** @param {string} line */
function simplifyCompareLine(line) {
  return String(line ?? "")
    .replace(/止損/g, "止损")
    .replace(/參/g, "参")
    .replace(/對/g, "对")
    .replace(/與/g, "与");
}

/**
 * 行级 Jaccard + 较小集合覆盖率（max），适合多行喊单重复。
 * @param {string} a
 * @param {string} b
 */
export function telegramPushBodySimilarity(a, b) {
  const na = normalizeForSimilarity(a);
  const nb = normalizeForSimilarity(b);
  if (!na || !nb) return 0;
  if (na === nb) return 1;
  const linesA = new Set(
    na.split("\n").filter(Boolean).map((l) => simplifyCompareLine(l)),
  );
  const linesB = new Set(
    nb.split("\n").filter(Boolean).map((l) => simplifyCompareLine(l)),
  );
  if (!linesA.size || !linesB.size) return 0;
  let inter = 0;
  for (const line of linesA) {
    if (linesB.has(line)) inter += 1;
  }
  const union = linesA.size + linesB.size - inter;
  const jaccard = union > 0 ? inter / union : 0;
  const minSize = Math.min(linesA.size, linesB.size);
  const overlapMin = minSize > 0 ? inter / minSize : 0;
  return Math.max(jaccard, overlapMin);
}

/**
 * 同币种且止盈/止损数值集合一致 → 视为同一信号复读（除非有新 TP/SL 数字）。
 * @param {string} prevBody
 * @param {string} nextBody
 */
export function isSameTpslSignalRepeat(prevBody, nextBody) {
  const symA =
    inferSymbolFromBody(prevBody) || inferSymbolFromBody(stripChannelHeaderForCompare(prevBody));
  const symB =
    inferSymbolFromBody(nextBody) || inferSymbolFromBody(stripChannelHeaderForCompare(nextBody));
  if (!symA || symA !== symB) return false;
  if (hasNewTpslNumbersInPush(prevBody, nextBody)) return false;
  const prev = extractTpslNumbers(prevBody);
  const next = extractTpslNumbers(nextBody);
  if (!prev.size && !next.size) return false;
  if (prev.size !== next.size) return false;
  for (const n of prev) {
    if (!next.has(n)) return false;
  }
  return true;
}

/**
 * 新消息是否带来「新的」止盈/止损数值（仅文案相似度放行条件）。
 * @param {string} prevBody
 * @param {string} nextBody
 */
export function hasNewTpslNumbersInPush(prevBody, nextBody) {
  const prev = extractTpslNumbers(prevBody);
  const next = extractTpslNumbers(nextBody);
  if (!next.size) return false;
  for (const n of next) {
    if (!prev.has(n)) return true;
  }
  return false;
}

/** @param {string} channelId @param {string} symbol */
function similarScopeKey(channelId, symbol) {
  const ch = String(channelId ?? "").trim() || "_";
  const sym = String(symbol ?? "").trim().toUpperCase() || "_";
  return `ch:${ch}:sym:${sym}`;
}

function pruneSimilarScope(key, now) {
  const list = recentSimilarByScope.get(key);
  if (!list?.length) return;
  const kept = list.filter((e) => now - e.ts <= WINDOW_MS);
  if (kept.length) recentSimilarByScope.set(key, kept);
  else recentSimilarByScope.delete(key);
}

/**
 * @param {{ channelId?: string, symbol?: string, bodyText: string }} input
 */
function shouldSkipSimilarTelegramPush(input) {
  const channelId = String(input.channelId ?? "").trim();
  const body = String(input.bodyText ?? "").trim();
  if (!channelId || !body) return false;

  const symbol =
    String(input.symbol ?? "").trim().toUpperCase() || inferSymbolFromBody(body);
  const scope = similarScopeKey(channelId, symbol);
  const now = Date.now();
  pruneSimilarScope(scope, now);
  const list = recentSimilarByScope.get(scope) ?? [];

  for (const entry of list) {
    if (isSameTpslSignalRepeat(entry.body, body)) return true;
    const ratio = telegramPushBodySimilarity(entry.body, body);
    if (ratio < SIMILAR_RATIO) continue;
    if (hasNewTpslNumbersInPush(entry.body, body)) continue;
    return true;
  }
  return false;
}

function rememberSimilarPush(input) {
  const channelId = String(input.channelId ?? "").trim();
  const body = String(input.bodyText ?? "").trim();
  if (!channelId || !body) return;
  const symbol =
    String(input.symbol ?? "").trim().toUpperCase() || inferSymbolFromBody(body);
  const scope = similarScopeKey(channelId, symbol);
  const now = Date.now();
  pruneSimilarScope(scope, now);
  const list = recentSimilarByScope.get(scope) ?? [];
  list.push({ ts: now, body, tpsl: extractTpslNumbers(body) });
  while (list.length > 12) list.shift();
  recentSimilarByScope.set(scope, list);
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
  if (shouldSkipSimilarTelegramPush(input)) return true;
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
  rememberSimilarPush(input);
  if (recentByKey.size > 800) {
    for (const [k, t] of recentByKey) {
      if (now - t > WINDOW_MS) recentByKey.delete(k);
    }
  }
}
