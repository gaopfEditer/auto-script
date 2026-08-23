/**
 * 同频道 + 同作者 + 同币种、30 分钟内 → 合并为一张卡片（时间取最新，止盈止损取最全）。
 */
import { normalizeSymbol } from "./card-fields.js";
import {
  executionFromParsed,
  normalizeExecution,
  normalizePriceList,
  hasEvaluatedYield,
} from "./discord-signal-execution.js";
import { extractNumericValues } from "./discord-signal-numeric-dedup.js";
import { cardRowParsed, isOppositeDirection } from "./discord-signal-staged-trade.js";

export const SIGNAL_CARD_MERGE_WINDOW_MS = 30 * 60 * 1000;

/** @param {unknown} note */
export function extractSpeakerFromNote(note) {
  const m = String(note ?? "").match(/发言人[:：]\s*([^·]+)/);
  return m ? String(m[1]).trim() : "";
}

/**
 * 卡片作者键（Discord authorId / Telegram 发言人 / 解析字段）。
 * @param {Record<string, unknown>} [opts]
 */
export function resolveAuthorKey(opts = {}) {
  const parsed =
    opts.parsedJson && typeof opts.parsedJson === "object" && !Array.isArray(opts.parsedJson)
      ? /** @type {Record<string, unknown>} */ (opts.parsedJson)
      : {};
  const fromParsed = String(
    parsed.authorKey ?? parsed.authorId ?? parsed.authorUsername ?? parsed.sender ?? ""
  ).trim();
  const fromMsg = String(
    opts.authorId ?? opts.authorUsername ?? opts.authorGlobalName ?? opts.sender ?? ""
  ).trim();
  const fromNote = extractSpeakerFromNote(opts.note);
  const key = fromParsed || fromMsg || fromNote;
  return key.toLowerCase();
}

/** @param {string} a @param {string} b */
export function authorKeysMatch(a, b) {
  const ka = String(a ?? "").trim().toLowerCase();
  const kb = String(b ?? "").trim().toLowerCase();
  if (!ka || !kb) return false;
  return ka === kb;
}

/** @param {unknown} row */
export function parseCardTimeMs(row) {
  const r = row && typeof row === "object" ? /** @type {Record<string, unknown>} */ (row) : {};
  const msgMs = Number(r.message_created_at_ms ?? r.messageCreatedAtMs ?? 0);
  if (Number.isFinite(msgMs) && msgMs > 0) return msgMs;
  const sa = r.signal_at ?? r.signalAt;
  if (sa) {
    const d = new Date(String(sa));
    if (!Number.isNaN(d.getTime())) return d.getTime();
  }
  const ca = r.created_at ?? r.createdAt;
  if (ca) {
    const d = new Date(String(ca));
    if (!Number.isNaN(d.getTime())) return d.getTime();
  }
  return 0;
}

/** @param {string} s */
function fieldRichness(s) {
  const text = String(s ?? "").trim();
  if (!text) return 0;
  return extractNumericValues({ planned: { entryPrice: text, stopLossPrice: text, takeProfitPrices: [text] } }).length;
}

/** @param {string} a @param {string} b */
function preferFullestField(a, b) {
  const sa = String(a ?? "").trim();
  const sb = String(b ?? "").trim();
  if (!sa) return sb;
  if (!sb) return sa;
  const ra = fieldRichness(sa);
  const rb = fieldRichness(sb);
  if (rb > ra) return sb;
  if (ra > rb) return sa;
  return sb.length >= sa.length ? sb : sa;
}

/** @param {unknown} a @param {unknown} b */
function mergeTakeProfitLists(a, b) {
  /** @type {string[]} */
  const out = [];
  const seen = new Set();
  for (const raw of [...normalizePriceList(a), ...normalizePriceList(b)]) {
    const key = raw.replace(/\s+/g, "").toLowerCase();
    if (!key || seen.has(key)) continue;
    seen.add(key);
    out.push(raw);
  }
  return out;
}

/**
 * 合并 parsed：止盈取并集，止损/入场取信息更全的一条。
 * @param {Record<string, unknown>} prevParsed
 * @param {Record<string, unknown>} nextParsed
 */
export function mergeSignalParsed(prevParsed, nextParsed) {
  const prevTps = prevParsed.takeProfits ?? prevParsed.targets;
  const nextTps = nextParsed.takeProfits ?? nextParsed.targets;
  const takeProfits = mergeTakeProfitLists(prevTps, nextTps);
  const stopLoss = preferFullestField(prevParsed.stopLoss ?? prevParsed.stop_loss, nextParsed.stopLoss ?? nextParsed.stop_loss);
  const entry = preferFullestField(
    prevParsed.entry ?? prevParsed.entryPrice,
    nextParsed.entry ?? nextParsed.entryPrice
  );
  const symbol = preferFullestField(prevParsed.symbol ?? prevParsed.asset, nextParsed.symbol ?? nextParsed.asset);
  const direction = preferFullestField(prevParsed.direction, nextParsed.direction);
  const title = preferFullestField(prevParsed.title, nextParsed.title);

  return {
    ...prevParsed,
    ...nextParsed,
    symbol,
    asset: preferFullestField(nextParsed.asset, prevParsed.asset) || symbol,
    direction,
    entry,
    entryPrice: entry,
    title: title || (symbol ? `${symbol} ${direction}`.trim() : ""),
    takeProfits,
    targets: takeProfits,
    stopLoss,
    stop_loss: stopLoss,
    authorKey: resolveAuthorKey({ parsedJson: { ...prevParsed, ...nextParsed } }),
    authorId: preferFullestField(prevParsed.authorId, nextParsed.authorId),
    authorUsername: preferFullestField(prevParsed.authorUsername, nextParsed.authorUsername),
    mergedFromSignals: true,
  };
}

/** @param {unknown} prevEx @param {unknown} nextEx */
export function mergeExecutionJson(prevEx, nextEx) {
  const prev = normalizeExecution(prevEx);
  const next = normalizeExecution(nextEx);
  const planned = {
    entryPrice: preferFullestField(prev.planned.entryPrice, next.planned.entryPrice),
    stopLossPrice: preferFullestField(prev.planned.stopLossPrice, next.planned.stopLossPrice),
    takeProfitPrices: mergeTakeProfitLists(prev.planned.takeProfitPrices, next.planned.takeProfitPrices),
  };
  const symbol = normalizeSymbol(next.symbol || prev.symbol);
  const direction = preferFullestField(prev.direction, next.direction);
  return {
    ...prev,
    ...next,
    symbol: symbol.replace(/USDT$/, ""),
    direction,
    planned,
    actual: prev.actual,
    outcome: prev.outcome === "pending" ? next.outcome ?? prev.outcome : prev.outcome,
    outcomeNote: preferFullestField(prev.outcomeNote, next.outcomeNote),
  };
}

/** @param {string} prev @param {string} next */
export function mergeRawContent(prev, next) {
  const a = String(prev ?? "").trim();
  const b = String(next ?? "").trim();
  if (!a) return b;
  if (!b) return a;
  if (a === b || a.includes(b) || b.includes(a)) return a.length >= b.length ? a : b;
  return `${a}\n---\n${b}`;
}

/** @param {unknown} row */
export function canMergeIntoCard(row) {
  const ex = normalizeExecution(row?.execution_json ?? row?.executionJson, cardRowParsed(row));
  if (hasEvaluatedYield(ex)) return false;
  const outcome = String(ex.outcome ?? "pending").trim();
  if (outcome && outcome !== "pending") return false;
  const status = String(row?.status ?? "active").trim();
  if (status && status !== "active") return false;
  return true;
}

/**
 * @param {unknown} prevRow
 * @param {unknown} nextRow
 * @param {number} [windowMs]
 */
export function isWithinMergeWindow(prevRow, nextSignalAtMs, windowMs = SIGNAL_CARD_MERGE_WINDOW_MS) {
  const prevMs = parseCardTimeMs(prevRow);
  const newMs = Number(nextSignalAtMs);
  if (!Number.isFinite(newMs) || newMs <= 0 || !prevMs) return false;
  const gap = newMs - prevMs;
  return gap >= 0 && gap <= windowMs;
}

/**
 * @param {unknown} prevRow
 * @param {Record<string, unknown>} incoming
 */
export function directionsAllowMerge(prevRow, incoming) {
  const prevParsed = cardRowParsed(prevRow) ?? {};
  const prevDir = String(prevParsed.direction ?? "").trim();
  const nextDir = String(incoming.parsedJson?.direction ?? incoming.direction ?? "").trim();
  if (!prevDir || !nextDir) return true;
  return !isOppositeDirection(prevDir, nextDir);
}

/**
 * @param {{
 *   prevRow: Record<string, unknown>,
 *   parsedJson: Record<string, unknown>,
 *   executionJson?: unknown,
 *   rawContent?: string,
 *   signalAt?: string | null,
 *   authorKey?: string,
 * }} input
 */
export function buildSignalCardMergePatch(input) {
  const prevRow = input.prevRow;
  const prevParsed = cardRowParsed(prevRow) ?? {};
  const authorKey = input.authorKey || resolveAuthorKey({ parsedJson: input.parsedJson });
  const mergedParsed = mergeSignalParsed(prevParsed, {
    ...input.parsedJson,
    ...(authorKey ? { authorKey } : {}),
  });
  const mergedExecution = input.executionJson
    ? mergeExecutionJson(
        prevRow.execution_json ?? prevRow.executionJson,
        input.executionJson
      )
    : executionFromParsed(mergedParsed);
  const mergedRaw = mergeRawContent(
    String(prevRow.raw_content ?? prevRow.rawContent ?? ""),
    String(input.rawContent ?? "")
  );
  const signalAt = input.signalAt || new Date().toISOString();

  return {
    parsedJson: mergedParsed,
    executionJson: mergedExecution,
    rawContent: mergedRaw,
    signalAt,
    symbol:
      normalizeSymbol(mergedExecution.symbol || mergedParsed.symbol) ||
      String(prevRow.symbol ?? "").trim(),
  };
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore> extends Promise<infer S> ? S : never} store
 * @param {{
 *   channelId: string,
 *   symbol: string,
 *   authorKey: string,
 *   direction?: string,
 *   signalAtMs?: number,
 *   withinMs?: number,
 * }} opts
 */
export async function findMergeTargetCard(store, opts) {
  const ch = String(opts.channelId ?? "").trim();
  const sym = normalizeSymbol(opts.symbol);
  const authorKey = String(opts.authorKey ?? "").trim().toLowerCase();
  if (!ch || !sym || !authorKey) return null;
  if (!store.listRecentSignalCardsBySymbolChannel) return null;

  const signalAtMs = Number(opts.signalAtMs);
  const newMs = Number.isFinite(signalAtMs) && signalAtMs > 0 ? signalAtMs : Date.now();
  const withinMs = Number(opts.withinMs) > 0 ? Number(opts.withinMs) : SIGNAL_CARD_MERGE_WINDOW_MS;
  const fromMs = newMs - withinMs;

  const rows = await store.listRecentSignalCardsBySymbolChannel({
    channelId: ch,
    symbol: sym,
    fromMs,
    limit: 15,
  });

  for (const row of rows) {
    if (!canMergeIntoCard(row)) continue;
    if (!isWithinMergeWindow(row, newMs, withinMs)) continue;
    const prevKey = resolveAuthorKey({
      parsedJson: cardRowParsed(row),
      note: row.note,
    });
    if (!authorKeysMatch(prevKey, authorKey)) continue;
    if (!directionsAllowMerge(row, { parsedJson: { direction: opts.direction }, direction: opts.direction })) {
      continue;
    }
    return row;
  }
  return null;
}
