/**
 * 分阶段 WEEX 下单：市价开仓 → 4.3% 初始止损 → TP/SL 更新 → 分批止盈 / 反手。
 */
import {
  STAGED_INITIAL_SL_PCT,
  STAGED_TP_PARTIAL_RATIOS,
  calcInitialStopLoss,
  resolveStagedEntryPrice,
} from "./discord-signal-staged-trade.js";
import {
  parseEntryPriceForOrder,
  resolveOrderLeverage,
  resolveBitgetOrderSize,
  directionToSide,
  formatOrderSize,
} from "./bitget-order-from-signal.js";
import { formatWeexPrice, parseWeexContractMeta } from "./weex-api.js";
import { normalizeSymbol } from "./card-fields.js";
import { normalizeExecution } from "./discord-signal-execution.js";

/** @param {number} marketPrice @param {number} sl @param {"long"|"short"} holdSide */
function isValidStopLoss(marketPrice, sl, holdSide) {
  if (!Number.isFinite(marketPrice) || !Number.isFinite(sl) || marketPrice <= 0 || sl <= 0) return false;
  if (holdSide === "long") return sl < marketPrice;
  return sl > marketPrice;
}

/** @param {ReturnType<typeof import("./weex-api.js").createWeexClient>} client @param {string} symbol */
async function fetchMarkPrice(client, symbol) {
  const ticker = await client.getTicker24h({ symbol });
  const p = Number(ticker?.markPrice ?? ticker?.lastPrice ?? 0);
  return Number.isFinite(p) && p > 0 ? p : null;
}

/** @param {ReturnType<typeof import("./weex-api.js").createWeexClient>} client @param {string} symbol */
async function fetchContractMeta(client, symbol) {
  try {
    return parseWeexContractMeta(await client.getContractInfo({ symbol }));
  } catch {
    return parseWeexContractMeta(null);
  }
}

/** @param {string} totalSize @param {string[]} takeProfits @param {number[]} ratios @param {ReturnType<typeof parseWeexContractMeta>} contractMeta */
function buildTpPlans(totalSize, takeProfits, ratios, contractMeta) {
  const total = Number(totalSize);
  if (!Number.isFinite(total) || total <= 0) return [];
  /** @type {Array<Record<string, unknown>>} */
  const plans = [];
  let remaining = total;
  const levels = Math.min(takeProfits.length, ratios.length);
  for (let i = 0; i < levels; i++) {
    const isLast = i === levels - 1;
    let tpSizeStr;
    if (isLast) tpSizeStr = formatOrderSize(remaining, contractMeta, { mode: "floor" });
    else {
      tpSizeStr = formatOrderSize(total * ratios[i], contractMeta, { mode: "floor" });
      const tpNum = Number(tpSizeStr);
      if (tpNum > 0) remaining = Math.max(0, remaining - tpNum);
    }
    if (!tpSizeStr) continue;
    plans.push({ level: i + 1, price: takeProfits[i], size: tpSizeStr, ratio: isLast ? 1 : ratios[i] });
  }
  return plans;
}

/**
 * @param {ReturnType<typeof import("./weex-api.js").createWeexClient>} client
 * @param {{ parsed: Record<string, unknown>; channelTrade: Record<string, unknown>; cardId: number; dryRun: boolean }} input
 */
export async function executeWeexStagedMarketOpen(client, input) {
  const parsed = input.parsed;
  const channelTrade = input.channelTrade;
  const symbol = normalizeSymbol(parsed.symbol);
  const direction = String(parsed.direction ?? "").trim();
  const side = directionToSide(direction);
  if (!symbol || !side) return { ok: false, reason: "invalid_symbol_or_direction" };

  const initialSlPct = Number(channelTrade.initialSlPct ?? STAGED_INITIAL_SL_PCT);

  const refPrice = input.dryRun
    ? parseEntryPriceForOrder(String(parsed.entry ?? ""), direction) ?? (await fetchMarkPrice(client, symbol))
    : await fetchMarkPrice(client, symbol);
  if (!refPrice || refPrice <= 0) return { ok: false, reason: "no_market_price" };

  const contractMeta = input.dryRun ? parseWeexContractMeta(null) : await fetchContractMeta(client, symbol);
  let leverage = resolveOrderLeverage(symbol);
  if (contractMeta.maxLeverage > 0 && leverage > contractMeta.maxLeverage) {
    leverage = contractMeta.maxLeverage;
  }
  const sizeResult = resolveBitgetOrderSize(Number(channelTrade.orderSizeUsdt ?? 50), refPrice, contractMeta, {
    dryRun: input.dryRun,
    leverage,
  });
  if (!sizeResult.ok) return { ok: false, reason: sizeResult.error ?? "size_too_small" };
  const size = sizeResult.size;

  const holdSide = side === "buy" ? "long" : "short";
  const fillPrice = refPrice;
  const initialSl = calcInitialStopLoss(fillPrice, direction, initialSlPct);
  if (initialSl && !isValidStopLoss(fillPrice, initialSl, holdSide)) {
    return { ok: false, reason: "invalid_initial_sl", error: `止损 ${initialSl} 相对市价 ${fillPrice} 无效` };
  }

  /** @type {Record<string, unknown>} */
  const record = {
    status: input.dryRun ? "dry_run" : "open_placed",
    phase: "open",
    staged: true,
    exchange: "weex",
    symbol,
    side,
    holdSide,
    size,
    fillPrice,
    leverage,
    initialSlPct,
    initialSlPrice: initialSl,
    marginMode: channelTrade.marginMode ?? "crossed",
    volumePlace: contractMeta.volumePlace,
    sizeMultiplier: contractMeta.sizeMultiplier,
    pricePrecision: contractMeta.pricePrecision,
    priceStep: contractMeta.priceStep,
    at: new Date().toISOString(),
  };

  if (input.dryRun) return { ok: true, record, dryRun: true };

  try {
    const levResult = await client.ensureLeverage({
      symbol,
      leverage,
      holdSide,
      marginMode: String(channelTrade.marginMode ?? "crossed"),
    });
    if (levResult?.leverage > 0) record.leverage = levResult.leverage;
    if (levResult?.marginType === "CROSSED") record.marginMode = "crossed";
    else if (levResult?.marginType === "ISOLATED") record.marginMode = "isolated";
  } catch (e) {
    return { ok: false, reason: "set_leverage_failed", error: String(/** @type {Error} */ (e).message ?? e) };
  }

  try {
    const slPrice = formatWeexPrice(initialSl, contractMeta);
    const openResp = await client.placeMarketOrder({
      symbol,
      side,
      holdSide,
      size,
      clientOid: `wx-open-${input.cardId}-${Date.now()}`,
      slTriggerPrice: slPrice || undefined,
    });
    record.openOrderId = openResp?.orderId ?? null;
    record.openResponse = openResp;
    if (slPrice) {
      record.presetStopLossPrice = slPrice;
      record.initialSlPrice = Number(slPrice);
    }
  } catch (e) {
    return { ok: false, reason: "open_failed", error: String(/** @type {Error} */ (e).message ?? e) };
  }

  return { ok: true, record };
}

/**
 * @param {ReturnType<typeof import("./weex-api.js").createWeexClient>} client
 * @param {{ prevOrder: Record<string, unknown>; parsed: Record<string, unknown>; channelTrade: Record<string, unknown>; cardId: number; dryRun: boolean }} input
 */
export async function executeWeexStagedTpslUpdate(client, input) {
  const prev = input.prevOrder;
  const parsed = input.parsed;
  const ex = normalizeExecution(null, parsed);
  const stopLossRaw = String(ex.planned.stopLossPrice ?? parsed.stopLoss ?? "").replace(/[^\d.]/g, "");
  const takeProfits = (
    ex.planned.takeProfitPrices.length ? ex.planned.takeProfitPrices : Array.isArray(parsed.takeProfits) ? parsed.takeProfits : []
  )
    .map((p) => String(p).replace(/[^\d.]/g, ""))
    .filter(Boolean);
  if (!stopLossRaw || !takeProfits.length) return { ok: false, reason: "missing_tpsl" };

  const symbol = String(prev.symbol ?? normalizeSymbol(parsed.symbol));
  const holdSide = /** @type {"long"|"short"} */ (String(prev.holdSide ?? (prev.side === "buy" ? "long" : "short")));
  const rawSize = String(prev.size ?? "");
  const ratios = /** @type {number[]} */ (input.channelTrade.tpPartialRatios ?? STAGED_TP_PARTIAL_RATIOS);

  const volumePlace = Number(prev.volumePlace);
  const contractMeta =
    Number.isFinite(volumePlace) && volumePlace > 0
      ? {
          minTradeNum: 0,
          minTradeUsdt: 0,
          volumePlace,
          sizeMultiplier: Number(prev.sizeMultiplier) || 0,
          pricePrecision: Number(prev.pricePrecision) || 2,
          priceStep: Number(prev.priceStep) || 0.01,
        }
      : input.dryRun
        ? parseWeexContractMeta(prev)
        : await fetchContractMeta(client, symbol);
  const size = formatOrderSize(rawSize, contractMeta, { mode: "floor" }) || rawSize;
  if (!size) return { ok: false, reason: "invalid_position_size" };

  /** @type {Record<string, unknown>} */
  const record = {
    ...prev,
    exchange: "weex",
    status: input.dryRun ? "dry_run" : "tpsl_set",
    phase: "full",
    stopLossPrice: stopLossRaw,
    takeProfits,
    tpPartialRatios: ratios,
    updatedAt: new Date().toISOString(),
  };

  const tpPlans = buildTpPlans(size, takeProfits, ratios, contractMeta);
  record.tpPlans = tpPlans;
  record.volumePlace = contractMeta.volumePlace;

  if (input.dryRun) return { ok: true, record, dryRun: true };

  const slPrice = formatWeexPrice(stopLossRaw, contractMeta);
  if (!slPrice) return { ok: false, reason: "invalid_sl_price" };

  try {
    const slResp = await client.placeTpSlOrder({
      symbol,
      holdSide,
      planType: "STOP_LOSS",
      triggerPrice: slPrice,
      quantity: size,
      clientOid: `wx-sl-${input.cardId}-${Date.now()}`,
    });
    record.slOrderId = slResp?.orderId ?? record.slOrderId;
    record.slUpdateResponse = slResp;
  } catch (e) {
    record.slUpdateError = String(/** @type {Error} */ (e).message ?? e);
  }

  /** @type {Array<Record<string, unknown>>} */
  const tpResults = [];
  for (const tp of tpPlans) {
    try {
      const tpPrice = formatWeexPrice(tp.price, contractMeta);
      if (!tpPrice) {
        tpResults.push({ ...tp, error: "invalid_tp_price" });
        continue;
      }
      const resp = await client.placeTpSlOrder({
        symbol,
        holdSide,
        planType: "TAKE_PROFIT",
        triggerPrice: tpPrice,
        quantity: String(tp.size),
        clientOid: `wx-tp${tp.level}-${input.cardId}-${Date.now()}`,
      });
      tpResults.push({ ...tp, orderId: resp?.orderId, response: resp });
    } catch (e) {
      tpResults.push({ ...tp, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  }
  record.tpResults = tpResults;

  const tpFailed = tpResults.filter((r) => r.error).length;
  if (record.slUpdateError || tpFailed > 0) {
    record.status = "tpsl_partial";
    record.tpslErrors = { sl: record.slUpdateError ?? null, tpFailed, tpTotal: tpResults.length };
  }

  return { ok: true, record };
}

/**
 * @param {ReturnType<typeof import("./weex-api.js").createWeexClient>} client
 * @param {{ prevOrder: Record<string, unknown>; parsed: Record<string, unknown>; channelTrade: Record<string, unknown>; cardId: number; dryRun: boolean }} input
 */
export async function executeWeexStagedReverse(client, input) {
  const prev = input.prevOrder;
  const parsed = input.parsed;
  const symbol = normalizeSymbol(parsed.symbol ?? prev.symbol);

  /** @type {Record<string, unknown>} */
  const record = {
    status: input.dryRun ? "dry_run" : "reversing",
    staged: true,
    exchange: "weex",
    reverse: true,
    symbol,
    at: new Date().toISOString(),
  };

  if (input.dryRun) {
    const openResult = await executeWeexStagedMarketOpen(client, {
      parsed,
      channelTrade: input.channelTrade,
      cardId: input.cardId,
      dryRun: true,
    });
    record.openPlan = openResult.record;
    record.status = "dry_run";
    return { ok: true, record, dryRun: true };
  }

  try {
    record.closeResponse = await client.closePositions({ symbol });
  } catch (e) {
    record.closeError = String(/** @type {Error} */ (e).message ?? e);
  }

  const openResult = await executeWeexStagedMarketOpen(client, {
    parsed,
    channelTrade: input.channelTrade,
    cardId: input.cardId,
    dryRun: false,
  });
  if (!openResult.ok) {
    record.status = "reverse_failed";
    record.error = openResult.reason;
    return { ok: false, record, reason: openResult.reason };
  }

  record.status = "reversed";
  record.open = openResult.record;
  return { ok: true, record };
}

/**
 * TP1 触达后：把止损改到开仓价（保本）。
 * @param {ReturnType<typeof import("./weex-api.js").createWeexClient>} client
 * @param {{
 *   prevOrder: Record<string, unknown>;
 *   parsed?: Record<string, unknown> | null;
 *   cardId: number;
 *   dryRun?: boolean;
 * }} input
 */
export async function executeWeexMoveSlToEntry(client, input) {
  const prev = input.prevOrder;
  if (prev.breakevenArmed === true || prev.slMovedToEntry === true) {
    return { ok: true, skipped: true, reason: "already_armed", record: prev };
  }

  const symbol = String(prev.symbol ?? "").toUpperCase();
  const holdSide = /** @type {"long"|"short"} */ (
    String(prev.holdSide ?? (prev.side === "buy" ? "long" : "short"))
  );
  const entry = resolveStagedEntryPrice(prev, input.parsed ?? null);
  if (!symbol || !entry) {
    return { ok: false, reason: "missing_entry", record: prev };
  }

  const volumePlace = Number(prev.volumePlace);
  const contractMeta =
    Number.isFinite(volumePlace) && volumePlace > 0
      ? {
          minTradeNum: 0,
          minTradeUsdt: 0,
          volumePlace,
          sizeMultiplier: Number(prev.sizeMultiplier) || 0,
          pricePrecision: Number(prev.pricePrecision) || 2,
          priceStep: Number(prev.priceStep) || 0.01,
        }
      : await fetchContractMeta(client, symbol);

  const entryStr = formatWeexPrice(entry, contractMeta);
  if (!entryStr) return { ok: false, reason: "invalid_entry_price", record: prev };

  // TP1 分批后剩余仓：用总仓 − 已挂 TP1 数量；失败则用原仓
  let remainingSize = String(prev.size ?? "");
  const tpPlans = Array.isArray(prev.tpPlans) ? prev.tpPlans : [];
  if (tpPlans.length && remainingSize) {
    const total = Number(remainingSize);
    const tp1Size = Number(/** @type {Record<string, unknown>} */ (tpPlans[0]).size ?? 0);
    if (Number.isFinite(total) && total > 0 && Number.isFinite(tp1Size) && tp1Size > 0) {
      const rem = formatOrderSize(Math.max(0, total - tp1Size), contractMeta, { mode: "floor" });
      if (rem) remainingSize = rem;
    }
  }

  /** @type {Record<string, unknown>} */
  const record = {
    ...prev,
    stopLossPrice: entryStr,
    breakevenArmed: true,
    slMovedToEntry: true,
    breakevenAt: new Date().toISOString(),
    breakevenEntryPrice: entry,
  };

  if (input.dryRun || String(prev.status) === "dry_run") {
    record.breakevenDryRun = true;
    return { ok: true, record, dryRun: true };
  }

  try {
    const mark = (await fetchMarkPrice(client, symbol)) ?? entry;
    if (!isValidStopLoss(mark, Number(entryStr), holdSide)) {
      record.breakevenArmed = false;
      record.slMovedToEntry = false;
      record.breakevenError = `entry SL ${entryStr} invalid vs mark ${mark}`;
      return { ok: false, reason: "sl_invalid_vs_mark", record, error: record.breakevenError };
    }
  } catch {
    /* continue */
  }

  try {
    const slResp = await client.placeTpSlOrder({
      symbol,
      holdSide,
      planType: "STOP_LOSS",
      triggerPrice: entryStr,
      quantity: remainingSize || "0",
      clientOid: `wx-sl-be-${input.cardId}-${Date.now()}`,
    });
    record.breakevenSlResponse = slResp;
    record.slOrderId = slResp?.orderId ?? record.slOrderId;
    record.slPlan = { planType: "STOP_LOSS", triggerPrice: entryStr, reason: "tp1_breakeven" };
    return { ok: true, record };
  } catch (e) {
    record.breakevenArmed = false;
    record.slMovedToEntry = false;
    record.breakevenError = String(/** @type {Error} */ (e).message ?? e);
    return { ok: false, reason: "move_sl_failed", record, error: record.breakevenError };
  }
}
