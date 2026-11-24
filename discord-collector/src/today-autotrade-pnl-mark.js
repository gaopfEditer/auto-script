/**
 * 今日盈亏页：持仓中按现价浮盈浮亏（只读，不写库、不触发下单）。
 */
import { forceCloseEvalCardAtMark } from "./card-eval-pending-settle.js";
import {
  isProgressTerminal,
  parseProgressJson,
} from "./card-level-progress.js";
import { alignPnlWithOutcome, calcLeveragePnl, fetchFuturesPrice } from "./card-price-fetch.js";
import {
  resolveMarkEntryPriceForDisplay,
  resolveTodayPnlMarkContext,
} from "./today-autotrade-pnl-display.js";

/** @param {string} code */
export function markOpenUserMessage(code) {
  switch (code) {
    case "closed":
      return "已结算";
    case "no_symbol":
      return "无币种";
    case "no_entry":
      return "无入场价";
    case "price_invalid":
      return "现价无效";
    case "price_fetch_failed":
      return "现价获取失败";
    default:
      return code || "失败";
  }
}

/** @param {Record<string, unknown>} card */
export function resolveMarkEntryPrice(card) {
  return resolveMarkEntryPriceForDisplay(card);
}

/**
 * 已入场：复用评估强制现价逻辑；未入场：计划入场价 × 现价。
 * @param {ReturnType<typeof import("./card-archive-service.js").archiveCardToClient>} card
 */
export async function computeTodayPnlOpenMark(card) {
  if (isProgressTerminal(card.progress)) {
    return { ok: false, skip: true, reason: "closed" };
  }
  const sym = String(card.symbol ?? "").trim();
  if (!sym) {
    return { ok: false, error: "no_symbol", markError: markOpenUserMessage("no_symbol") };
  }

  const prog = parseProgressJson(card.progress);
  if (prog?.entryHitAt) {
    const markResult = await forceCloseEvalCardAtMark(card);
    if (markResult && markResult.pnlPct != null) {
      return {
        ok: true,
        pnlPct: Number(markResult.pnlPct),
        markPrice: markResult.settlementPrice ?? null,
        mode: "eval_force_mark",
      };
    }
    return {
      ok: false,
      error: "price_fetch_failed",
      markError: markOpenUserMessage("price_fetch_failed"),
    };
  }

  const entry = resolveMarkEntryPrice(card);
  if (entry == null || !Number.isFinite(entry) || entry <= 0) {
    return { ok: false, error: "no_entry", markError: markOpenUserMessage("no_entry") };
  }

  const { isShort, leverage: lev } = resolveTodayPnlMarkContext(card);

  try {
    const tick = await fetchFuturesPrice(sym);
    const px = Number(tick?.price);
    if (!Number.isFinite(px) || px <= 0) {
      return { ok: false, error: "price_invalid", markError: markOpenUserMessage("price_invalid") };
    }
    const pnl = calcLeveragePnl(entry, px, isShort, lev);
    const raw = pnl ? Math.round(pnl.pnlPctOnMargin * 100) / 100 : 0;
    const outcome = raw >= 0 ? "take_profit" : "stop_loss";
    const rounded = alignPnlWithOutcome(outcome, raw);
    return {
      ok: true,
      pnlPct: rounded,
      markPrice: px,
      entryPrice: entry,
      leverage: lev,
      mode: "planned_entry_mark",
    };
  } catch (e) {
    return {
      ok: false,
      error: "price_fetch_failed",
      markError: markOpenUserMessage("price_fetch_failed"),
      detail: String(/** @type {Error} */ (e).message ?? e),
    };
  }
}