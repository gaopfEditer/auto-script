/**
 * 信号卡片 → Bitget 合约下单计划。
 */
import { normalizeSymbol } from "./card-fields.js";
import { isShortDirection, resolveTradeDirection } from "./card-direction.js";
import { normalizeExecution } from "./discord-signal-execution.js";
import { detectSymbolTier } from "./card-backtest-policy.js";
import { config } from "./config.js";

/**
 * @typedef {{
 *   symbol: string;
 *   side: "buy" | "sell";
 *   tradeSide: "open";
 *   orderType: "limit" | "market";
 *   price: number | null;
 *   size: string;
 *   leverage: number;
 *   marginMode: "isolated" | "crossed";
 *   marginCoin: string;
 *   productType: string;
 *   takeProfitPrice: string | null;
 *   stopLossPrice: string | null;
 *   clientOid: string;
 *   direction: string;
 *   entryRaw: string;
 *   orderSizeUsdt: number;
 * }} BitgetOrderPlan
 */

/** @param {unknown} symbol */
export function resolveBitgetLeverage(symbol) {
  return detectSymbolTier(symbol) === "major" ? config.bitgetMajorLeverage : config.bitgetAltcoinLeverage;
}

/**
 * 信号/分阶段下单杠杆：仅按币种 tier（BTC/ETH=主流，其它=山寨），不读 channel 占位 30。
 * @param {unknown} symbol
 */
export function resolveOrderLeverage(symbol) {
  return resolveBitgetLeverage(symbol);
}

/** @param {unknown} raw @param {number} fallback */
export function parseLeverageFromSignal(raw, fallback) {
  const s = String(raw ?? "").trim();
  if (!s) return fallback;
  const m = s.match(/(\d+)\s*[xX倍]/);
  if (m) return Number(m[1]);
  const n = Number(s.replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** @param {string} entryRaw @param {string} direction */
export function parseEntryPriceForOrder(entryRaw, direction) {
  const s = String(entryRaw ?? "").trim();
  if (!s) return null;
  const range = s.match(/([\d.]+)\s*[-~–—]\s*([\d.]+)/);
  if (range) {
    const low = Number(range[1]);
    const high = Number(range[2]);
    if (!Number.isFinite(low) || !Number.isFinite(high)) return null;
    const isShort = isShortDirection(direction);
    return isShort ? Math.max(low, high) : Math.min(low, high);
  }
  const m = s.match(/([\d.]+)/);
  if (!m) return null;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** @param {number} size @param {number} [volumePlace] */
function formatSizeString(size, volumePlace = 8) {
  if (!Number.isFinite(size) || size <= 0) return "";
  const fixed = size.toFixed(Math.min(8, Math.max(0, volumePlace)));
  return fixed.replace(/\.?0+$/, "") || fixed;
}

/** @param {number} amount USDT 金额，严格两位小数 */
export function roundUsdt2(amount) {
  if (!Number.isFinite(amount)) return amount;
  return Math.round(amount * 100 + Number.EPSILON) / 100;
}

/**
 * @param {Record<string, unknown> | null | undefined} raw
 * @returns {{ minTradeNum: number; minTradeUsdt: number; volumePlace: number; sizeMultiplier: number }}
 */
export function parseBitgetContractMeta(raw) {
  if (!raw || typeof raw !== "object") {
    return { minTradeNum: 0, minTradeUsdt: 0, volumePlace: 8, sizeMultiplier: 0 };
  }
  return {
    minTradeNum: Number(raw.minTradeNum ?? 0) || 0,
    minTradeUsdt: Number(raw.minTradeUSDT ?? raw.minTradeUsdt ?? 0) || 0,
    volumePlace: Number(raw.volumePlace ?? 8) || 8,
    sizeMultiplier: Number(raw.sizeMultiplier ?? 0) || 0,
  };
}

/** @param {number} size @param {number} step @param {number} volumePlace */
function alignSizeToStep(size, step, volumePlace) {
  if (!step || step <= 0) return size;
  const aligned = Math.ceil(size / step - 1e-12) * step;
  return Number(aligned.toFixed(volumePlace));
}

/** @param {number} size @param {number} step @param {number} volumePlace */
function floorSizeToStep(size, step, volumePlace) {
  if (!step || step <= 0) return Number(size.toFixed(volumePlace));
  const aligned = Math.floor(size / step + 1e-12) * step;
  return Number(aligned.toFixed(volumePlace));
}

/**
 * 按合约精度格式化下单数量（TP/SL 分批必须用 floor，避免超出仓位）。
 * @param {unknown} sizeInput
 * @param {ReturnType<typeof parseBitgetContractMeta>} [contract]
 * @param {{ mode?: "ceil" | "floor" | "round" }} [opts]
 */
export function formatOrderSize(sizeInput, contract, opts = {}) {
  const meta = contract ?? parseBitgetContractMeta(null);
  const volumePlace = meta.volumePlace ?? 3;
  const mode = opts.mode ?? "round";
  let n = Number(sizeInput);
  if (!Number.isFinite(n) || n <= 0) return "";

  if (meta.sizeMultiplier) {
    n = mode === "ceil" ? alignSizeToStep(n, meta.sizeMultiplier, volumePlace) : floorSizeToStep(n, meta.sizeMultiplier, volumePlace);
  } else if (mode === "floor") {
    n = Math.floor(n * 10 ** volumePlace + 1e-12) / 10 ** volumePlace;
  } else if (mode === "ceil") {
    n = Math.ceil(n * 10 ** volumePlace - 1e-12) / 10 ** volumePlace;
  } else {
    n = Number(n.toFixed(volumePlace));
  }
  if (n <= 0) return "";
  return formatSizeString(n, volumePlace);
}

/** @param {number} usdtNotional @param {number} price @param {ReturnType<typeof parseBitgetContractMeta>} [contract] */
export function calcBaseSize(usdtNotional, price, contract) {
  if (!Number.isFinite(usdtNotional) || usdtNotional <= 0 || !Number.isFinite(price) || price <= 0) {
    return "";
  }
  const raw = usdtNotional / price;
  const volumePlace = contract?.volumePlace ?? (raw < 0.0001 ? 8 : raw < 0.01 ? 6 : raw < 1 ? 4 : 2);
  let size = Number(raw.toFixed(volumePlace));
  if (size <= 0) {
    for (let p = volumePlace + 1; p <= 8; p++) {
      size = Number(raw.toFixed(p));
      if (size > 0) break;
    }
  }
  if (size <= 0) return "";
  if (contract?.sizeMultiplier) {
    size = alignSizeToStep(size, contract.sizeMultiplier, volumePlace);
  }
  return formatSizeString(size, volumePlace);
}

/**
 * @param {number} marginUsdt 保证金 (USDT)，与 Bitget App「金额」一致
 * @param {number} price
 * @param {ReturnType<typeof parseBitgetContractMeta>} [contract]
 * @param {{ dryRun?: boolean; leverage?: number }} [opts]
 */
export function resolveBitgetOrderSize(marginUsdt, price, contract, opts = {}) {
  const meta = contract ?? parseBitgetContractMeta(null);
  const leverage = Number(opts.leverage) > 0 ? Number(opts.leverage) : 1;
  const positionNotionalUsdt = roundUsdt2(marginUsdt * leverage);
  const sizeStr = calcBaseSize(positionNotionalUsdt, price, meta);
  if (!sizeStr) {
    return {
      ok: false,
      error: "size_too_small",
      hint: `保证金 ${marginUsdt} USDT × ${leverage}x = 名义 ${positionNotionalUsdt.toFixed(2)} USDT，相对价格 ${price} 仍过小`,
      marginUsdt,
      leverage,
      positionNotionalUsdt,
    };
  }
  const size = Number(sizeStr);
  const notionalUsdt = roundUsdt2(size * price);
  const belowMinNum = meta.minTradeNum > 0 && size < meta.minTradeNum;
  const belowMinUsdt = meta.minTradeUsdt > 0 && positionNotionalUsdt < meta.minTradeUsdt;

  if ((belowMinNum || belowMinUsdt) && !opts.dryRun) {
    const minHint = meta.minTradeUsdt > 0 ? `${meta.minTradeUsdt} USDT` : `${meta.minTradeNum} 张`;
    return {
      ok: false,
      error: "below_min_notional",
      hint: `Bitget 最小名义约 ${minHint}（当前 ${positionNotionalUsdt.toFixed(2)} USDT = ${marginUsdt} × ${leverage}x）`,
      minTradeUsdt: meta.minTradeUsdt,
      minTradeNum: meta.minTradeNum,
      size: sizeStr,
      notionalUsdt,
      marginUsdt,
      leverage,
      positionNotionalUsdt,
    };
  }

  return {
    ok: true,
    size: sizeStr,
    notionalUsdt,
    marginUsdt,
    leverage,
    positionNotionalUsdt,
    belowMinUsdt,
    belowMinNum,
    minTradeUsdt: meta.minTradeUsdt,
    minTradeNum: meta.minTradeNum,
  };
}

/** @param {string} direction */
export function directionToSide(direction) {
  if (isShortDirection(direction)) return "sell";
  if (resolveTradeDirection(direction) === "long") return "buy";
  return null;
}

/**
 * @param {{
 *   parsed: Record<string, unknown>;
 *   executionJson?: unknown;
 *   channelTrade: { leverage: number; orderSizeUsdt: number; orderType: "limit" | "market"; marginMode: "isolated" | "crossed"; productType: string };
 *   cardId: number;
 * }} input
 * @returns {{ ok: true; plan: BitgetOrderPlan } | { ok: false; reason: string }}
 */
export function buildBitgetOrderPlan(input) {
  const parsed = input.parsed ?? {};
  const ex = normalizeExecution(input.executionJson, parsed);
  const symbol = normalizeSymbol(ex.symbol || parsed.symbol || parsed.asset);
  const direction = String(ex.direction || parsed.direction || "").trim();

  if (!symbol) return { ok: false, reason: "missing_symbol" };
  if (!direction || /待确认|观望|unknown/i.test(direction)) {
    return { ok: false, reason: "direction_unclear" };
  }

  const side = directionToSide(direction);
  if (!side) return { ok: false, reason: "direction_unsupported" };

  const entryRaw = String(ex.planned?.entryPrice ?? parsed.entry ?? "").trim();
  const price = input.channelTrade.orderType === "market" ? null : parseEntryPriceForOrder(entryRaw, direction);
  if (input.channelTrade.orderType === "limit" && price == null) {
    return { ok: false, reason: "entry_price_invalid" };
  }

  const refPrice = price ?? parseEntryPriceForOrder(entryRaw, direction);
  if (refPrice == null || refPrice <= 0) return { ok: false, reason: "price_reference_invalid" };

  const leverage = resolveOrderLeverage(symbol);

  const sizeResult = resolveBitgetOrderSize(input.channelTrade.orderSizeUsdt, refPrice, undefined, {
    dryRun: false,
    leverage,
  });
  if (!sizeResult.ok) return { ok: false, reason: sizeResult.error ?? "size_too_small" };
  const size = sizeResult.size;

  const tps = ex.planned?.takeProfitPrices ?? [];
  const tp = tps.length ? String(tps[0]).replace(/[^\d.]/g, "") : null;
  const slRaw = String(ex.planned?.stopLossPrice ?? parsed.stopLoss ?? parsed.stop_loss ?? "").trim();
  const sl = slRaw ? slRaw.replace(/[^\d.]/g, "") : null;

  /** @type {BitgetOrderPlan} */
  const plan = {
    symbol,
    side,
    tradeSide: "open",
    orderType: input.channelTrade.orderType,
    price,
    size,
    leverage,
    marginMode: input.channelTrade.marginMode,
    marginCoin: "USDT",
    productType: input.channelTrade.productType,
    takeProfitPrice: tp || null,
    stopLossPrice: sl || null,
    clientOid: `dc-${input.cardId}-${Date.now()}`,
    direction,
    entryRaw,
    orderSizeUsdt: input.channelTrade.orderSizeUsdt,
  };

  return { ok: true, plan };
}
