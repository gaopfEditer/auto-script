/**
 * 白名单区间入场规则（已定口径）：
 * 解析出明确入场区间后，等标记价进入闭区间再市价；已在区内立即市价；
 * 已朝交易方向越过远端则跳过不追；单点入场不走本规则。
 */
import { isLongDirection, isShortDirection, resolveTradeDirection } from "./card-direction.js";
import { parseEntryRangeBounds, plannedEntryIsRange } from "./card-price-fetch.js";

/**
 * @param {unknown} executionJson
 * @param {Record<string, unknown> | null | undefined} parsed
 */
export function resolveEntryRaw(parsed, executionJson) {
  const ex =
    executionJson && typeof executionJson === "object"
      ? /** @type {Record<string, unknown>} */ (executionJson)
      : {};
  const planned =
    ex.planned && typeof ex.planned === "object"
      ? /** @type {Record<string, unknown>} */ (ex.planned)
      : {};
  const p = parsed && typeof parsed === "object" ? parsed : {};
  return String(planned.entryPrice ?? p.entry ?? ex.entry ?? "").trim();
}

/** @param {unknown} v */
export function entryHasRange(v) {
  return plannedEntryIsRange(v);
}

/**
 * @param {unknown} entryRaw
 * @param {unknown} direction
 * @param {number | null | undefined} markPrice
 * @returns {{
 *   action: "pass" | "enter_now" | "wait" | "skip_crossed" | "direction_unclear" | "mark_unavailable";
 *   range: { low: number, high: number } | null;
 *   mark: number | null;
 *   reason?: string;
 * }}
 */
export function classifyRangeEntry(entryRaw, direction, markPrice) {
  const range = parseEntryRangeBounds(entryRaw);
  if (!range) {
    return { action: "pass", range: null, mark: markPrice ?? null };
  }

  const side = resolveTradeDirection(direction);
  if (side !== "long" && side !== "short") {
    return {
      action: "direction_unclear",
      range,
      mark: markPrice ?? null,
      reason: "direction_unclear",
    };
  }

  const mark = Number(markPrice);
  if (!Number.isFinite(mark) || mark <= 0) {
    return { action: "mark_unavailable", range, mark: null, reason: "mark_unavailable" };
  }

  if (mark >= range.low && mark <= range.high) {
    return { action: "enter_now", range, mark };
  }

  const short = isShortDirection(direction) || side === "short";
  const long = isLongDirection(direction) || side === "long";

  if (short && mark < range.low) {
    return {
      action: "skip_crossed",
      range,
      mark,
      reason: "price_crossed_below_range",
    };
  }
  if (long && mark > range.high) {
    return {
      action: "skip_crossed",
      range,
      mark,
      reason: "price_crossed_above_range",
    };
  }

  return { action: "wait", range, mark, reason: "awaiting_range_entry" };
}

/** @param {string} exchange @param {number|string} cardId */
export function rangeEntryKey(exchange, cardId) {
  return `${String(exchange).trim().toLowerCase()}:${Number(cardId)}`;
}
