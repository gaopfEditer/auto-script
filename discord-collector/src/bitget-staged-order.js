/**
 * 分阶段 Bitget 下单：市价开仓 → 4.3% 初始止损 → TP/SL 更新 → 分批止盈 / 反手。
 */
import {
  STAGED_INITIAL_SL_PCT,
  STAGED_TP_PARTIAL_RATIOS,
  calcInitialStopLoss,
  resolveStagedEntryPrice,
} from "./discord-signal-staged-trade.js";
import { parseEntryPriceForOrder, resolveOrderLeverage, resolveBitgetOrderSize, directionToSide, parseBitgetContractMeta, formatOrderSize } from "./bitget-order-from-signal.js";
import { normalizeSymbol } from "./card-fields.js";
import { normalizeExecution } from "./discord-signal-execution.js";

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {unknown} resp */
function unwrapBitgetRows(resp) {
  if (!resp || typeof resp !== "object") return [];
  const data = /** @type {Record<string, unknown>} */ (resp).data;
  if (Array.isArray(data)) return data;
  if (data && typeof data === "object") {
    const o = /** @type {Record<string, unknown>} */ (data);
    if (Array.isArray(o.list)) return o.list;
    if (Array.isArray(o.entrustedList)) return o.entrustedList;
    if ("symbol" in o) return [o];
  }
  return [];
}

/**
 * 查询是否已有该币种仓位或挂单（用于开仓成功校验 / 重试前防重复）。
 * @param {ReturnType<typeof import("./bitget-api.js").createBitgetClient>} client
 * @param {{ symbol: string; productType: string; holdSide: string; marginCoin?: string }} p
 */
export async function hasBitgetSymbolExposure(client, p) {
  const symbol = String(p.symbol).toUpperCase();
  const wantSide = String(p.holdSide ?? "").toLowerCase();
  const sideAlts = new Set(
    wantSide === "long" || wantSide === "buy"
      ? ["long", "buy"]
      : wantSide === "short" || wantSide === "sell"
        ? ["short", "sell"]
        : []
  );

  try {
    const posResp = await client.getSinglePosition({
      symbol,
      productType: p.productType,
      marginCoin: p.marginCoin ?? "USDT",
    });
    for (const row of unwrapBitgetRows(posResp)) {
      if (!row || typeof row !== "object") continue;
      const r = /** @type {Record<string, unknown>} */ (row);
      if (String(r.symbol ?? "").toUpperCase() !== symbol) continue;
      const total = Number(r.total ?? r.available ?? r.locked ?? 0);
      if (!(total > 0)) continue;
      if (!sideAlts.size) return true;
      const hs = String(r.holdSide ?? "").toLowerCase();
      if (!hs || sideAlts.has(hs)) return true;
    }
  } catch {
    /* 持仓查询失败时再看挂单 */
  }

  try {
    const pendingResp = await client.getOrdersPending({
      productType: p.productType,
      symbol,
    });
    for (const row of unwrapBitgetRows(pendingResp)) {
      if (!row || typeof row !== "object") continue;
      const r = /** @type {Record<string, unknown>} */ (row);
      if (String(r.symbol ?? "").toUpperCase() === symbol) return true;
    }
  } catch {
    /* ignore */
  }

  return false;
}

const BITGET_OPEN_MAX_ATTEMPTS = 3;

/** @param {number} price */
function priceStr(price) {
  if (!Number.isFinite(price) || price <= 0) return "";
  const s = String(price);
  if (s.includes(".")) return s.replace(/\.?0+$/, "") || s;
  return s;
}

/** @param {number} marketPrice @param {number} sl @param {"long"|"short"} holdSide */
function isValidStopLoss(marketPrice, sl, holdSide) {
  if (!Number.isFinite(marketPrice) || !Number.isFinite(sl) || marketPrice <= 0 || sl <= 0) return false;
  if (holdSide === "long") return sl < marketPrice;
  return sl > marketPrice;
}

/** @param {ReturnType<typeof import("./bitget-api.js").createBitgetClient>} client @param {string} symbol @param {string} productType */
async function fetchContractMeta(client, symbol, productType) {
  try {
    const contract = await client.getMixContract({ symbol, productType });
    return parseBitgetContractMeta(contract);
  } catch {
    return parseBitgetContractMeta(null);
  }
}

/**
 * @param {ReturnType<typeof import("./bitget-api.js").createBitgetClient>} client
 * @param {Record<string, unknown>} prev
 * @param {string} symbol
 * @param {string} productType
 */
async function resolveStoredContractMeta(client, prev, symbol, productType) {
  const volumePlace = Number(prev.volumePlace);
  if (Number.isFinite(volumePlace) && volumePlace > 0) {
    return {
      minTradeNum: 0,
      minTradeUsdt: 0,
      volumePlace,
      sizeMultiplier: Number(prev.sizeMultiplier) || 0,
    };
  }
  return fetchContractMeta(client, symbol, productType);
}

/**
 * @param {string} totalSize
 * @param {string[]} takeProfits
 * @param {number[]} ratios
 * @param {ReturnType<typeof parseBitgetContractMeta>} contractMeta
 */
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
    if (isLast) {
      tpSizeStr = formatOrderSize(remaining, contractMeta, { mode: "floor" });
    } else {
      tpSizeStr = formatOrderSize(total * ratios[i], contractMeta, { mode: "floor" });
      const tpNum = Number(tpSizeStr);
      if (tpNum > 0) remaining = Math.max(0, remaining - tpNum);
    }
    if (!tpSizeStr) continue;
    plans.push({
      level: i + 1,
      price: takeProfits[i],
      size: tpSizeStr,
      ratio: isLast ? 1 : ratios[i],
    });
  }
  return plans;
}

/** @param {ReturnType<typeof import("./bitget-api.js").createBitgetClient>} client @param {string} symbol @param {string} productType */
async function fetchMarkPrice(client, symbol, productType) {
  const ticker = await client.getMixTicker({ symbol, productType });
  const p = Number(ticker?.markPrice ?? ticker?.lastPr ?? 0);
  return Number.isFinite(p) && p > 0 ? p : null;
}

/**
 * @param {ReturnType<typeof import("./bitget-api.js").createBitgetClient>} client
 * @param {{
 *   parsed: Record<string, unknown>;
 *   channelTrade: Record<string, unknown>;
 *   cardId: number;
 *   dryRun: boolean;
 * }} input
 */
export async function executeStagedMarketOpen(client, input) {
  const parsed = input.parsed;
  const channelTrade = input.channelTrade;
  const symbol = normalizeSymbol(parsed.symbol);
  const direction = String(parsed.direction ?? "").trim();
  const side = directionToSide(direction);
  if (!symbol || !side) return { ok: false, reason: "invalid_symbol_or_direction" };

  const productType = String(channelTrade.productType ?? "USDT-FUTURES");
  const marginCoin = "USDT";
  const leverage = resolveOrderLeverage(symbol);
  const initialSlPct = Number(channelTrade.initialSlPct ?? STAGED_INITIAL_SL_PCT);

  const refPrice = input.dryRun
    ? parseEntryPriceForOrder(String(parsed.entry ?? ""), direction) ??
      (await fetchMarkPrice(client, symbol, productType))
    : await fetchMarkPrice(client, symbol, productType);
  if (!refPrice || refPrice <= 0) {
    return { ok: false, reason: "no_market_price" };
  }

  const contractMeta = input.dryRun ? parseBitgetContractMeta(null) : await fetchContractMeta(client, symbol, productType);

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
    return {
      ok: false,
      reason: "invalid_initial_sl",
      error: `止损 ${initialSl} 相对市价 ${fillPrice} 方向无效（${holdSide}）`,
    };
  }

  /** @type {Record<string, unknown>} */
  const record = {
    status: input.dryRun ? "dry_run" : "open_placed",
    phase: "open",
    staged: true,
    symbol,
    side,
    holdSide,
    size,
    fillPrice,
    leverage,
    initialSlPct,
    initialSlPrice: initialSl,
    marginMode: channelTrade.marginMode ?? "crossed",
    productType,
    volumePlace: contractMeta.volumePlace,
    sizeMultiplier: contractMeta.sizeMultiplier,
    at: new Date().toISOString(),
  };

  if (input.dryRun) {
    record.slPlan = { planType: "loss_plan", triggerPrice: initialSl, size };
    return { ok: true, record, dryRun: true };
  }

  try {
    await client.ensureLeverage({
      symbol,
      productType,
      marginCoin,
      leverage,
      holdSide,
      marginMode: String(channelTrade.marginMode ?? "crossed"),
    });
  } catch (e) {
    return { ok: false, reason: "set_leverage_failed", error: String(/** @type {Error} */ (e).message ?? e) };
  }

  const marginMode = String(channelTrade.marginMode ?? "crossed");
  /** @type {string[]} */
  const attemptErrors = [];
  let placed = false;

  for (let attempt = 1; attempt <= BITGET_OPEN_MAX_ATTEMPTS; attempt++) {
    // 重试前先查仓位/挂单，避免重复开仓
    if (attempt > 1) {
      try {
        if (
          await hasBitgetSymbolExposure(client, {
            symbol,
            productType,
            holdSide,
            marginCoin,
          })
        ) {
          placed = true;
          record.openRecoveredFromQuery = true;
          record.openAttempts = attempt - 1;
          break;
        }
      } catch {
        /* continue to place */
      }
      await sleep(400 * attempt);
    }

    const openBase = {
      symbol,
      productType,
      marginMode,
      marginCoin,
      size,
      side,
      tradeSide: "open",
      orderType: "market",
      clientOid: `dc-open-${input.cardId}-${Date.now()}-${attempt}`,
    };

    try {
      let openResp;
      let openPresetSlError = "";
      try {
        openResp = await client.placeOrder({
          ...openBase,
          presetStopLossPrice: initialSl ? priceStr(initialSl) : undefined,
        });
        if (initialSl) {
          record.presetStopLossPrice = priceStr(initialSl);
          record.slOrderId = "preset_on_open";
        }
      } catch (openErr) {
        openPresetSlError = String(/** @type {Error} */ (openErr).message ?? openErr);
        openResp = await client.placeOrder(openBase);
        if (openPresetSlError) record.openPresetSlError = openPresetSlError;

        if (initialSl) {
          try {
            const markAfter = (await fetchMarkPrice(client, symbol, productType)) ?? fillPrice;
            const slPrice = calcInitialStopLoss(markAfter, direction, initialSlPct);
            if (!slPrice || !isValidStopLoss(markAfter, slPrice, holdSide)) {
              record.slError = `fallback SL invalid: ${slPrice} vs ${markAfter}`;
            } else {
              const slResp = await client.withHoldSideFallback(
                (hs) =>
                  client.placeTpslOrder({
                    symbol,
                    productType,
                    marginCoin,
                    planType: "loss_plan",
                    triggerPrice: priceStr(slPrice),
                    holdSide: hs,
                    size,
                    clientOid: `dc-sl-init-${input.cardId}-${Date.now()}-${attempt}`,
                  }),
                holdSide
              );
              const slData =
                slResp && typeof slResp === "object" && "data" in slResp
                  ? /** @type {Record<string, unknown>} */ (slResp.data)
                  : {};
              record.slOrderId = slData.orderId ?? slData.planId ?? null;
              record.slResponse = slResp;
              record.initialSlPrice = slPrice;
              record.presetStopLossPrice = priceStr(slPrice);
            }
          } catch (e) {
            record.slError = String(/** @type {Error} */ (e).message ?? e);
          }
        }
      }

      const openData =
        openResp && typeof openResp === "object" && "data" in openResp
          ? /** @type {Record<string, unknown>} */ (openResp.data)
          : {};
      record.openOrderId = openData.orderId ?? null;
      record.openResponse = openResp;
      record.openAttempts = attempt;

      // 等撮合落地后再查仓位/挂单
      await sleep(500 * attempt);
      const exposed = await hasBitgetSymbolExposure(client, {
        symbol,
        productType,
        holdSide,
        marginCoin,
      });
      if (exposed) {
        placed = true;
        break;
      }

      const miss = `attempt ${attempt}: api ok but no position/pending for ${symbol}`;
      attemptErrors.push(miss);
      record.verifyMiss = miss;
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message ?? e);
      attemptErrors.push(`attempt ${attempt}: ${msg}`);
      record.lastOpenError = msg;
    }
  }

  if (!placed) {
    return {
      ok: false,
      reason: "open_failed",
      error: attemptErrors.join(" | ") || "open failed after retries",
      attempts: BITGET_OPEN_MAX_ATTEMPTS,
    };
  }

  if (attemptErrors.length) record.openRetryErrors = attemptErrors;
  return { ok: true, record };
}

/**
 * @param {ReturnType<typeof import("./bitget-api.js").createBitgetClient>} client
 * @param {{
 *   prevOrder: Record<string, unknown>;
 *   parsed: Record<string, unknown>;
 *   channelTrade: Record<string, unknown>;
 *   cardId: number;
 *   dryRun: boolean;
 * }} input
 */
export async function executeStagedTpslUpdate(client, input) {
  const prev = input.prevOrder;
  const parsed = input.parsed;
  const ex = normalizeExecution(null, parsed);
  const stopLossRaw = String(ex.planned.stopLossPrice ?? parsed.stopLoss ?? "").replace(/[^\d.]/g, "");
  const takeProfits = (
    ex.planned.takeProfitPrices.length
      ? ex.planned.takeProfitPrices
      : Array.isArray(parsed.takeProfits)
        ? parsed.takeProfits
        : []
  )
    .map((p) => String(p).replace(/[^\d.]/g, ""))
    .filter(Boolean);
  if (!stopLossRaw || !takeProfits.length) return { ok: false, reason: "missing_tpsl" };

  const symbol = String(prev.symbol ?? normalizeSymbol(parsed.symbol));
  const holdSide = String(prev.holdSide ?? (prev.side === "buy" ? "long" : "short"));
  const rawSize = String(prev.size ?? "");
  const productType = String(prev.productType ?? input.channelTrade.productType ?? "USDT-FUTURES");
  const marginCoin = "USDT";
  const ratios = /** @type {number[]} */ (input.channelTrade.tpPartialRatios ?? STAGED_TP_PARTIAL_RATIOS);

  const contractMeta = input.dryRun
    ? parseBitgetContractMeta(prev)
    : await resolveStoredContractMeta(client, prev, symbol, productType);
  const size = formatOrderSize(rawSize, contractMeta, { mode: "floor" }) || rawSize;

  /** @type {Record<string, unknown>} */
  const record = {
    ...prev,
    status: input.dryRun ? "dry_run" : "tpsl_set",
    phase: "full",
    stopLossPrice: stopLossRaw,
    takeProfits,
    tpPartialRatios: ratios,
    updatedAt: new Date().toISOString(),
  };

  /** @type {Array<Record<string, unknown>>} */
  const tpPlans = buildTpPlans(size, takeProfits, ratios, contractMeta);
  record.tpPlans = tpPlans;
  record.volumePlace = contractMeta.volumePlace;
  record.sizeMultiplier = contractMeta.sizeMultiplier;

  if (input.dryRun) {
    record.slPlan = { planType: "pos_loss", triggerPrice: stopLossRaw, size };
    return { ok: true, record, dryRun: true };
  }

  try {
    const slResp = await client.withHoldSideFallback(
      (hs) =>
        client.placePosTpsl({
          symbol,
          productType,
          marginCoin,
          holdSide: hs,
          stopLossTriggerPrice: stopLossRaw,
          stopLossClientOid: `dc-sl-upd-${input.cardId}-${Date.now()}`,
        }),
      holdSide
    );
    record.slOrderId = slResp?.data?.orderId ?? record.slOrderId;
    record.slUpdateResponse = slResp;
    record.slPlan = { planType: "pos_loss", triggerPrice: stopLossRaw };
  } catch (e) {
    record.slUpdateError = String(/** @type {Error} */ (e).message ?? e);
    try {
      const slResp = await client.withHoldSideFallback(
        (hs) =>
          client.placeTpslOrder({
            symbol,
            productType,
            marginCoin,
            planType: "loss_plan",
            triggerPrice: stopLossRaw,
            holdSide: hs,
            size,
            clientOid: `dc-sl-upd-${input.cardId}-${Date.now()}`,
          }),
        holdSide
      );
      record.slOrderId = slResp?.data?.orderId ?? slResp?.data?.planId ?? record.slOrderId;
      record.slUpdateResponse = slResp;
      record.slUpdateError = undefined;
    } catch (e2) {
      record.slUpdateError = String(/** @type {Error} */ (e2).message ?? e2);
    }
  }

  /** @type {Array<Record<string, unknown>>} */
  const tpResults = [];
  for (const tp of tpPlans) {
    try {
      const resp = await client.withHoldSideFallback(
        (hs) =>
          client.placeTpslOrder({
            symbol,
            productType,
            marginCoin,
            planType: "profit_plan",
            triggerPrice: String(tp.price),
            holdSide: hs,
            size: String(tp.size),
            clientOid: `dc-tp${tp.level}-${input.cardId}-${Date.now()}`,
          }),
        holdSide
      );
      tpResults.push({ ...tp, orderId: resp?.data?.orderId ?? resp?.data?.planId, response: resp });
    } catch (e) {
      tpResults.push({ ...tp, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  }
  record.tpResults = tpResults;

  const tpFailed = tpResults.filter((r) => r.error).length;
  if (record.slUpdateError || tpFailed > 0) {
    record.status = "tpsl_partial";
    record.tpslErrors = {
      sl: record.slUpdateError ?? null,
      tpFailed,
      tpTotal: tpResults.length,
    };
  }

  return { ok: true, record };
}

/**
 * @param {ReturnType<typeof import("./bitget-api.js").createBitgetClient>} client
 * @param {{
 *   prevOrder: Record<string, unknown>;
 *   parsed: Record<string, unknown>;
 *   channelTrade: Record<string, unknown>;
 *   cardId: number;
 *   dryRun: boolean;
 * }} input
 */
export async function executeStagedReverse(client, input) {
  const prev = input.prevOrder;
  const parsed = input.parsed;
  const symbol = normalizeSymbol(parsed.symbol ?? prev.symbol);
  const productType = String(prev.productType ?? input.channelTrade.productType ?? "USDT-FUTURES");
  const prevHoldSide = String(prev.holdSide ?? (prev.side === "buy" ? "long" : "short"));

  /** @type {Record<string, unknown>} */
  const record = {
    status: input.dryRun ? "dry_run" : "reversing",
    staged: true,
    reverse: true,
    prevCardSide: prev.side,
    prevHoldSide,
    symbol,
    at: new Date().toISOString(),
  };

  if (input.dryRun) {
    record.closePlan = { holdSide: prevHoldSide };
    const openResult = await executeStagedMarketOpen(client, {
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
    const closeResp = await client.closePositions({
      symbol,
      productType,
      holdSide: /** @type {"long"|"short"} */ (prevHoldSide),
    });
    record.closeResponse = closeResp;
  } catch (e) {
    record.closeError = String(/** @type {Error} */ (e).message ?? e);
  }

  const openResult = await executeStagedMarketOpen(client, {
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
 * TP1 触达后：把止损改到开仓价（保本），防止大力回踩超额止损。
 * @param {ReturnType<typeof import("./bitget-api.js").createBitgetClient>} client
 * @param {{
 *   prevOrder: Record<string, unknown>;
 *   parsed?: Record<string, unknown> | null;
 *   cardId: number;
 *   dryRun?: boolean;
 * }} input
 */
export async function executeBitgetMoveSlToEntry(client, input) {
  const prev = input.prevOrder;
  if (prev.breakevenArmed === true || prev.slMovedToEntry === true) {
    return { ok: true, skipped: true, reason: "already_armed", record: prev };
  }

  const symbol = String(prev.symbol ?? "").toUpperCase();
  const holdSide = String(prev.holdSide ?? (prev.side === "buy" ? "long" : "short"));
  const productType = String(prev.productType ?? "USDT-FUTURES");
  const marginCoin = "USDT";
  const entry = resolveStagedEntryPrice(prev, input.parsed ?? null);
  if (!symbol || !entry) {
    return { ok: false, reason: "missing_entry", record: prev };
  }

  const entryStr = priceStr(entry);
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
    record.status = prev.status === "dry_run" ? "dry_run" : record.status;
    record.breakevenDryRun = true;
    return { ok: true, record, dryRun: true };
  }

  // 校验相对现价方向仍有效（已回撤穿开仓价则无法挂保本 SL）
  try {
    const mark = (await fetchMarkPrice(client, symbol, productType)) ?? entry;
    const hs = /** @type {"long"|"short"} */ (holdSide === "short" || holdSide === "sell" ? "short" : "long");
    if (!isValidStopLoss(mark, entry, hs)) {
      record.breakevenArmed = false;
      record.slMovedToEntry = false;
      record.breakevenError = `entry SL ${entry} invalid vs mark ${mark}`;
      return { ok: false, reason: "sl_invalid_vs_mark", record, error: record.breakevenError };
    }
  } catch {
    /* 查价失败仍尝试挂单 */
  }

  try {
    const slResp = await client.withHoldSideFallback(
      (hs) =>
        client.placePosTpsl({
          symbol,
          productType,
          marginCoin,
          holdSide: hs,
          stopLossTriggerPrice: entryStr,
          stopLossClientOid: `dc-sl-be-${input.cardId}-${Date.now()}`,
        }),
      holdSide
    );
    record.breakevenSlResponse = slResp;
    record.slOrderId = slResp?.data?.orderId ?? record.slOrderId;
    record.slPlan = { planType: "pos_loss", triggerPrice: entryStr, reason: "tp1_breakeven" };
    return { ok: true, record };
  } catch (e) {
    const err1 = String(/** @type {Error} */ (e).message ?? e);
    try {
      const size = String(prev.size ?? "");
      const slResp = await client.withHoldSideFallback(
        (hs) =>
          client.placeTpslOrder({
            symbol,
            productType,
            marginCoin,
            planType: "loss_plan",
            triggerPrice: entryStr,
            holdSide: hs,
            size: size || "0",
            clientOid: `dc-sl-be-${input.cardId}-${Date.now()}`,
          }),
        holdSide
      );
      record.breakevenSlResponse = slResp;
      record.slOrderId = slResp?.data?.orderId ?? slResp?.data?.planId ?? record.slOrderId;
      record.slPlan = { planType: "loss_plan", triggerPrice: entryStr, reason: "tp1_breakeven" };
      record.breakevenFallback = true;
      return { ok: true, record };
    } catch (e2) {
      record.breakevenArmed = false;
      record.slMovedToEntry = false;
      record.breakevenError = `${err1} | ${String(/** @type {Error} */ (e2).message ?? e2)}`;
      return { ok: false, reason: "move_sl_failed", record, error: record.breakevenError };
    }
  }
}
