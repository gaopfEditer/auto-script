/**
 * Bitget 开仓 TP/SL 强制：预设价、校验、补挂与裸仓处置。
 */
import { isLongDirection, isShortDirection } from "./card-direction.js";
import { normalizeExecution } from "./discord-signal-execution.js";

const LIQUIDATION_DEFAULT_TP_SL_PCT = 5;
const LIQUIDATION_DEFAULT_TP_PCTS = [0.05, 0.08, 0.12];

/**
 * @param {number} entry
 * @param {boolean} isShort
 * @param {number[]} tps
 * @param {number | null} sl
 */
function applyDefaultTpSl(entry, isShort, tps, sl) {
  const slPct = LIQUIDATION_DEFAULT_TP_SL_PCT / 100;
  /** @type {number[]} */
  const outTps = [...tps];
  let outSl = sl;
  if (!outTps.length) {
    for (const pct of LIQUIDATION_DEFAULT_TP_PCTS) {
      outTps.push(isShort ? entry * (1 - pct) : entry * (1 + pct));
    }
  }
  if (outSl == null) {
    outSl = isShort ? entry * (1 + slPct) : entry * (1 - slPct);
  }
  return { tps: outTps, sl: outSl };
}

/** @param {number} fillPrice @param {string} direction @param {number} pct */
function calcInitialStopLoss(fillPrice, direction, pct) {
  if (!Number.isFinite(fillPrice) || fillPrice <= 0) return null;
  const ratio = pct / 100;
  if (isLongDirection(direction)) return Number((fillPrice * (1 - ratio)).toFixed(8));
  if (isShortDirection(direction)) return Number((fillPrice * (1 + ratio)).toFixed(8));
  return null;
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

/** @param {number} ms */
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/** @param {number} price */
export function priceStr(price) {
  if (!Number.isFinite(price) || price <= 0) return "";
  const s = String(price);
  if (s.includes(".")) return s.replace(/\.?0+$/, "") || s;
  return s;
}

/** @param {number} marketPrice @param {number} sl @param {"long"|"short"} holdSide */
export function isValidStopLoss(marketPrice, sl, holdSide) {
  if (!Number.isFinite(marketPrice) || !Number.isFinite(sl) || marketPrice <= 0 || sl <= 0) return false;
  if (holdSide === "long") return sl < marketPrice;
  return sl > marketPrice;
}

/** @param {number} marketPrice @param {number} tp @param {"long"|"short"} holdSide */
export function isValidTakeProfit(marketPrice, tp, holdSide) {
  if (!Number.isFinite(marketPrice) || !Number.isFinite(tp) || marketPrice <= 0 || tp <= 0) return false;
  if (holdSide === "long") return tp > marketPrice;
  return tp < marketPrice;
}

export function bitgetRequireTpslEnabled() {
  return !["0", "false", "no", "off"].includes(String(process.env.BITGET_REQUIRE_TPSL ?? "1").toLowerCase());
}

/** @returns {"close"|"alert"} */
export function bitgetNakedPositionAction() {
  const v = String(process.env.BITGET_NAKED_POSITION_ACTION ?? "close").toLowerCase();
  return v === "alert" ? "alert" : "close";
}

export function bitgetTpslVerifyWindowMs() {
  const sec = Number(process.env.BITGET_TPSL_VERIFY_SEC ?? 8);
  return Math.max(2, Math.min(60, Number.isFinite(sec) ? sec : 8)) * 1000;
}

export function bitgetTpslRepairRetries() {
  const n = Number(process.env.BITGET_TPSL_REPAIR_RETRIES ?? 3);
  return Math.max(1, Math.min(10, Number.isFinite(n) ? n : 3));
}

/** @typedef {"sl_breached"|"precision"|"transient"|"hold_side"|"unknown"} TpslRepairErrorCategory */

/**
 * @param {string} message
 * @param {"long"|"short"|string} holdSide
 * @returns {TpslRepairErrorCategory}
 */
export function classifyBitgetTpslRepairError(message, holdSide) {
  const m = String(message ?? "").toLowerCase();
  const side = String(holdSide ?? "").toLowerCase();

  if (
    /stop loss price of the long position should be less than/i.test(m) ||
    /stop loss price of the short position should be greater than/i.test(m) ||
    /stop loss.*should be less than the current price/i.test(m) ||
    /stop loss.*should be greater than the current price/i.test(m) ||
    /sl price.*invalid.*current/i.test(m) ||
    /already.*trigger/i.test(m)
  ) {
    return "sl_breached";
  }
  if (side === "long" && /stop loss.*greater than.*current|sl.*above.*mark/i.test(m)) {
    return "sl_breached";
  }
  if (side === "short" && /stop loss.*less than.*current|sl.*below.*mark/i.test(m)) {
    return "sl_breached";
  }

  if (/429|rate limit|too many requests|timeout|timed out|etimedout|econnreset|network|temporarily unavailable/i.test(m)) {
    return "transient";
  }
  if (/position.*not exist|no position|position does not exist|order.*not exist|not found position/i.test(m)) {
    return "transient";
  }

  if (/holdside|hold side|position side|posside|position mode|unilateral|hedge mode|one-way|two-way/i.test(m)) {
    return "hold_side";
  }

  if (
    /precision|priceplace|priceendstep|price step|tick size|minimum size|volume place|sizemultiplier|decimal|must be a multiple/i.test(
      m
    )
  ) {
    return "precision";
  }

  return "unknown";
}

/**
 * @param {Record<string, unknown> | null | undefined} raw
 * @param {ReturnType<typeof import("./bitget-order-from-signal.js").parseBitgetContractMeta>} [base]
 */
export function enrichBitgetContractMeta(raw, base) {
  const b = base ?? {};
  const o = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : {};
  return {
    minTradeNum: Number(o.minTradeNum ?? b.minTradeNum ?? 0) || 0,
    minTradeUsdt: Number(o.minTradeUSDT ?? o.minTradeUsdt ?? b.minTradeUsdt ?? 0) || 0,
    volumePlace: Number(o.volumePlace ?? b.volumePlace ?? 8) || 8,
    sizeMultiplier: Number(o.sizeMultiplier ?? b.sizeMultiplier ?? 0) || 0,
    pricePlace: Number(o.pricePlace ?? 2) || 2,
    priceEndStep: Number(o.priceEndStep ?? o.priceStep ?? 0) || 0,
  };
}

/**
 * @param {number} price
 * @param {{ pricePlace?: number; priceEndStep?: number }} meta
 */
export function roundBitgetTriggerPrice(price, meta) {
  if (!Number.isFinite(price) || price <= 0) return "";
  const place = meta.pricePlace ?? 2;
  const step = meta.priceEndStep ?? 0;
  let p = price;
  if (step > 0) {
    p = Math.round(p / step) * step;
  }
  p = Number(p.toFixed(Math.min(8, Math.max(0, place))));
  return priceStr(p);
}

/**
 * @param {ReturnType<typeof import("./bitget-api.js").createBitgetClient>} client
 * @param {{
 *   symbol: string;
 *   productType: string;
 *   fetchMark?: () => Promise<number | null>;
 * }} ctx
 */
async function fetchMarkForRepair(client, ctx) {
  if (ctx.fetchMark) {
    const m = await ctx.fetchMark();
    if (m != null && m > 0) return m;
  }
  try {
    const ticker = await client.getMixTicker({ symbol: ctx.symbol, productType: ctx.productType });
    const p = Number(ticker?.markPrice ?? ticker?.lastPr ?? 0);
    if (Number.isFinite(p) && p > 0) return p;
  } catch {
    /* ignore */
  }
  return 0;
}

/**
 * @param {{
 *   mark: number;
 *   holdSide: "long"|"short";
 *   direction: string;
 *   initialSlPct: number;
 *   parsed?: Record<string, unknown>;
 *   executionJson?: unknown;
 *   signalStopLossStr: string;
 *   signalTakeProfitStr: string;
 *   contractMeta?: ReturnType<typeof enrichBitgetContractMeta> | null;
 *   forcePrecisionRound?: boolean;
 *   sizeStr: string;
 * }} input
 */
export function resolveRepairTpslLevels(input) {
  const holdSide = input.holdSide;
  const mark = input.mark;

  let slNum = Number(String(input.signalStopLossStr).replace(/[^\d.]/g, ""));
  let tpNum = Number(String(input.signalTakeProfitStr).replace(/[^\d.]/g, ""));
  const useSignalSl = Number.isFinite(slNum) && slNum > 0 && isValidStopLoss(mark, slNum, holdSide);
  const useSignalTp = Number.isFinite(tpNum) && tpNum > 0 && isValidTakeProfit(mark, tpNum, holdSide);

  const resolved = resolveOpenTpslPrices({
    parsed: input.parsed ?? {},
    executionJson: input.executionJson,
    fillPrice: mark,
    direction: input.direction,
    initialSlPct: input.initialSlPct,
  });

  let stopLossStr = useSignalSl ? priceStr(slNum) : resolved.stopLossStr;
  let takeProfitStr = useSignalTp ? priceStr(tpNum) : resolved.takeProfitStr;

  if (input.forcePrecisionRound && input.contractMeta) {
    stopLossStr = roundBitgetTriggerPrice(Number(stopLossStr), input.contractMeta);
    takeProfitStr = roundBitgetTriggerPrice(Number(takeProfitStr), input.contractMeta);
  }

  return {
    stopLossStr,
    takeProfitStr,
    usedSignalSl: useSignalSl,
    usedSignalTp: useSignalTp,
    mark,
  };
}

/**
 * @param {ReturnType<typeof import("./bitget-api.js").createBitgetClient>} client
 * @param {{
 *   symbol: string;
 *   productType: string;
 *   marginCoin: string;
 *   holdSide: string;
 *   size: string;
 *   stopLossStr: string;
 *   takeProfitStr: string;
 *   cardId: number;
 *   direction?: string;
 *   initialSlPct?: number;
 *   parsed?: Record<string, unknown>;
 *   executionJson?: unknown;
 *   fetchMark?: () => Promise<number | null>;
 * }} ctx
 * @param {Record<string, unknown>} record
 */
export async function repairBitgetPositionTpsl(client, ctx, record) {
  const maxRetries = bitgetTpslRepairRetries();
  const backoffMs = [1000, 2000, 4000];
  /** @type {{ attempts: Array<Record<string, unknown>>; repaired?: boolean }} */
  const repair = { attempts: [] };
  record.tpslRepair = repair;

  let forcePrecision = false;
  let closeImmediately = false;
  /** @type {TpslRepairErrorCategory} */
  let lastCategory = "unknown";
  let lastError = "";
  let lastMark = 0;

  const holdSide = /** @type {"long"|"short"} */ (
    ctx.holdSide === "short" || ctx.holdSide === "sell" ? "short" : "long"
  );
  const direction =
    ctx.direction ?? (holdSide === "short" ? "做空" : "做多");
  const initialSlPct = Number(ctx.initialSlPct) > 0 ? Number(ctx.initialSlPct) : 4.3;

  let sizeStr = ctx.size;

  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    lastMark = await fetchMarkForRepair(client, ctx);
    if (!(lastMark > 0)) {
      lastError = "no_market_price";
      lastCategory = "transient";
      repair.attempts.push({
        attempt,
        at: new Date().toISOString(),
        ok: false,
        category: lastCategory,
        error: lastError,
      });
      if (attempt < maxRetries) await sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]);
      continue;
    }

    /** @type {ReturnType<typeof enrichBitgetContractMeta> | null} */
    let contractMeta = null;
    try {
      if (typeof client.getMixContract === "function") {
        const raw = await client.getMixContract({ symbol: ctx.symbol, productType: ctx.productType });
        contractMeta = enrichBitgetContractMeta(raw);
      } else {
        contractMeta = enrichBitgetContractMeta(null);
      }
    } catch {
      contractMeta = enrichBitgetContractMeta(null);
    }

    if (forcePrecision && contractMeta?.sizeMultiplier > 0) {
      const step = contractMeta.sizeMultiplier;
      const vp = contractMeta.volumePlace ?? 8;
      const n = Math.floor(Number(sizeStr) / step + 1e-12) * step;
      if (n > 0) sizeStr = priceStr(Number(n.toFixed(Math.min(8, vp))));
    }

    const levels = resolveRepairTpslLevels({
      mark: lastMark,
      holdSide,
      direction,
      initialSlPct,
      parsed: ctx.parsed,
      executionJson: ctx.executionJson,
      signalStopLossStr: ctx.stopLossStr,
      signalTakeProfitStr: ctx.takeProfitStr,
      contractMeta,
      forcePrecisionRound: forcePrecision,
      sizeStr,
    });

    /** @type {Record<string, unknown>} */
    const attemptRec = {
      attempt,
      at: new Date().toISOString(),
      mark: lastMark,
      stopLossStr: levels.stopLossStr,
      takeProfitStr: levels.takeProfitStr,
      size: sizeStr,
      usedSignalSl: levels.usedSignalSl,
      usedSignalTp: levels.usedSignalTp,
      precisionRound: forcePrecision,
    };

    try {
      const posResp = await client.withHoldSideFallback(
        (hs) =>
          client.placePosTpsl({
            symbol: ctx.symbol,
            productType: ctx.productType,
            marginCoin: ctx.marginCoin,
            holdSide: hs,
            stopLossTriggerPrice: levels.stopLossStr,
            stopSurplusTriggerPrice: levels.takeProfitStr,
            stopSurplusSize: sizeStr,
            stopLossClientOid: `dc-sl-verify-${ctx.cardId}-${Date.now()}-a${attempt}`,
            stopSurplusClientOid: `dc-tp-verify-${ctx.cardId}-${Date.now()}-a${attempt}`,
          }),
        ctx.holdSide
      );
      attemptRec.ok = true;
      attemptRec.response = posResp;
      repair.attempts.push(attemptRec);

      await sleep(500);
      const inspect = await inspectBitgetPositionTpsl(client, ctx);
      attemptRec.verifyAfter = inspect;
      if (inspect.ok) {
        repair.repaired = true;
        return { ok: true, inspect, repair };
      }
      lastError = "verify_still_missing_tpsl";
      lastCategory = "transient";
      attemptRec.verifyMissing = true;
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message ?? e);
      lastError = msg;
      lastCategory = classifyBitgetTpslRepairError(msg, holdSide);
      attemptRec.ok = false;
      attemptRec.error = msg;
      attemptRec.category = lastCategory;
      repair.attempts.push(attemptRec);

      if (lastCategory === "sl_breached") {
        closeImmediately = true;
        repair.closeReason = "sl_breached";
        break;
      }
      if (lastCategory === "precision") {
        forcePrecision = true;
      }
    }

    if (closeImmediately) break;
    if (attempt < maxRetries) {
      await sleep(backoffMs[Math.min(attempt - 1, backoffMs.length - 1)]);
    }
  }

  if (!repair.closeReason) {
    repair.closeReason = closeImmediately ? "sl_breached" : "retries_exhausted";
  }

  return {
    ok: false,
    repair,
    closeImmediately,
    closeReason: repair.closeReason,
    lastCategory,
    lastError,
    mark: lastMark,
  };
}

/**
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {{
 *   symbol: string;
 *   holdSide: string;
 *   cardId: number;
 *   category: string;
 *   lastError: string;
 *   mark: number;
 *   attempts: Array<Record<string, unknown>>;
 *   closeImmediately: boolean;
 *   action: "close"|"alert";
 * }} details
 */
export function formatBitgetNakedPositionAlert(details) {
  const lines = [
    details.action === "close" ? "Bitget 裸仓已平" : "Bitget 裸仓告警",
    `标的 ${details.symbol} ${details.holdSide} card=#${details.cardId}`,
    `原因分类: ${details.category}`,
    details.closeImmediately ? "（止损已被穿越 / SL 相对现价无效，立即平仓）" : "（补挂重试已用尽）",
    `原始错误: ${details.lastError || "—"}`,
    `标记价: ${details.mark > 0 ? details.mark : "—"}`,
    `尝试记录: ${JSON.stringify(details.attempts)}`,
  ];
  return lines.join("\n");
}

/**
 * 从信号或默认规则解析开仓用 SL/TP（含多档 TP 字符串列表）。
 * @param {{
 *   parsed: Record<string, unknown>;
 *   executionJson?: unknown;
 *   fillPrice: number;
 *   direction: string;
 *   initialSlPct: number;
 * }} input
 */
export function resolveOpenTpslPrices(input) {
  const ex = normalizeExecution(input.executionJson ?? null, input.parsed);
  const direction = input.direction;
  const fillPrice = input.fillPrice;
  const isShort = isShortDirection(direction);

  let slNum = Number(
    String(ex.planned?.stopLossPrice ?? input.parsed.stopLoss ?? "")
      .replace(/[^\d.]/g, "")
  );
  if (!Number.isFinite(slNum) || slNum <= 0) {
    slNum = calcInitialStopLoss(fillPrice, direction, input.initialSlPct) ?? 0;
  }

  let tpNums = (ex.planned?.takeProfitPrices ?? [])
    .map((p) => Number(String(p).replace(/[^\d.]/g, "")))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!tpNums.length && Array.isArray(input.parsed.takeProfits)) {
    tpNums = input.parsed.takeProfits
      .map((p) => Number(String(p).replace(/[^\d.]/g, "")))
      .filter((n) => Number.isFinite(n) && n > 0);
  }

  const slForDefault = Number.isFinite(slNum) && slNum > 0 ? slNum : null;
  const applied = applyDefaultTpSl(fillPrice, isShort, tpNums, slForDefault);
  slNum = applied.sl;
  tpNums = applied.tps;

  const takeProfits = tpNums.map((n) => priceStr(n)).filter(Boolean);
  const stopLoss = priceStr(slNum);
  const firstTp = takeProfits[0] ?? "";

  return {
    stopLossPrice: slNum,
    takeProfitPrice: tpNums[0] ?? 0,
    stopLossStr: stopLoss,
    takeProfitStr: firstTp,
    takeProfits,
  };
}

/**
 * @param {ReturnType<typeof import("./bitget-api.js").createBitgetClient>} client
 * @param {{
 *   symbol: string;
 *   productType: string;
 *   marginCoin?: string;
 *   holdSide: string;
 * }} p
 */
export async function inspectBitgetPositionTpsl(client, p) {
  const symbol = String(p.symbol).toUpperCase();
  const wantSide = String(p.holdSide ?? "").toLowerCase();
  const sideAlts = new Set(
    wantSide === "long" || wantSide === "buy"
      ? ["long", "buy"]
      : wantSide === "short" || wantSide === "sell"
        ? ["short", "sell"]
        : []
  );

  let hasSl = false;
  let hasTp = false;

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
      const hs = String(r.holdSide ?? "").toLowerCase();
      if (sideAlts.size && hs && !sideAlts.has(hs)) continue;

      const slFields = [r.stopLoss, r.stopLossTriggerPrice, r.presetStopLossPrice, r.stopLossPrice];
      const tpFields = [r.takeProfit, r.stopSurplusTriggerPrice, r.presetStopSurplusPrice, r.takeProfitPrice];
      for (const v of slFields) {
        const n = Number(v);
        if (v != null && String(v) !== "" && String(v) !== "0" && (Number.isFinite(n) ? n > 0 : true)) {
          hasSl = true;
          break;
        }
      }
      for (const v of tpFields) {
        const n = Number(v);
        if (v != null && String(v) !== "" && String(v) !== "0" && (Number.isFinite(n) ? n > 0 : true)) {
          hasTp = true;
          break;
        }
      }
    }
  } catch {
    /* plan 查询兜底 */
  }

  if (!hasSl || !hasTp) {
    try {
      const planResp = await client.getOrdersPlanPending({
        productType: p.productType,
        symbol,
      });
      for (const row of unwrapBitgetRows(planResp)) {
        if (!row || typeof row !== "object") continue;
        const r = /** @type {Record<string, unknown>} */ (row);
        const planType = String(r.planType ?? r.plan_type ?? "").toLowerCase();
        const hs = String(r.holdSide ?? r.posSide ?? "").toLowerCase();
        if (sideAlts.size && hs && !sideAlts.has(hs)) continue;
        if (planType.includes("loss")) hasSl = true;
        if (planType.includes("profit") || planType.includes("surplus")) hasTp = true;
      }
    } catch {
      /* ignore */
    }
  }

  return { hasSl, hasTp, ok: hasSl && hasTp };
}

/**
 * 市价开仓：必须同时带 preset TP/SL；预设被拒则按最新标记价重算后重试，禁止裸开仓。
 * @param {ReturnType<typeof import("./bitget-api.js").createBitgetClient>} client
 * @param {{
 *   openBase: Record<string, unknown>;
 *   symbol: string;
 *   productType: string;
 *   marginCoin: string;
 *   holdSide: "long"|"short";
 *   direction: string;
 *   size: string;
 *   initialSlPct: number;
 *   stopLossStr: string;
 *   takeProfitStr: string;
 *   fetchMark: () => Promise<number | null>;
 *   parsed?: Record<string, unknown>;
 *   executionJson?: unknown;
 *   maxPresetAttempts?: number;
 * }} p
 */
export async function placeBitgetOpenWithPresets(client, p) {
  const holdSide = p.holdSide;
  const maxPresetAttempts = p.maxPresetAttempts ?? 3;
  /** @type {string[]} */
  const presetErrors = [];

  for (let presetAttempt = 1; presetAttempt <= maxPresetAttempts; presetAttempt++) {
    const mark = (await p.fetchMark()) ?? 0;
    if (!(mark > 0)) {
      return { ok: false, reason: "no_market_price", presetErrors };
    }

    const resolved = resolveOpenTpslPrices({
      parsed: p.parsed ?? {},
      executionJson: p.executionJson,
      fillPrice: mark,
      direction: p.direction,
      initialSlPct: p.initialSlPct,
    });
    let slStr = presetAttempt === 1 && p.stopLossStr ? p.stopLossStr : resolved.stopLossStr;
    let tpStr = presetAttempt === 1 && p.takeProfitStr ? p.takeProfitStr : resolved.takeProfitStr;
    let slNum = Number(slStr);
    let tpNum = Number(tpStr);

    if (!isValidStopLoss(mark, slNum, holdSide) || !isValidTakeProfit(mark, tpNum, holdSide)) {
      slStr = resolved.stopLossStr;
      tpStr = resolved.takeProfitStr;
      slNum = resolved.stopLossPrice;
      tpNum = resolved.takeProfitPrice;
    }

    if (!slStr || !tpStr || !isValidStopLoss(mark, slNum, holdSide) || !isValidTakeProfit(mark, tpNum, holdSide)) {
      presetErrors.push(`preset ${presetAttempt}: invalid tp/sl vs mark ${mark}`);
      await sleep(300 * presetAttempt);
      continue;
    }

    try {
      const openResp = await client.placeOrder({
        ...p.openBase,
        presetStopLossPrice: slStr,
        presetStopSurplusPrice: tpStr,
      });
      return {
        ok: true,
        openResp,
        presetStopLossPrice: slStr,
        presetStopSurplusPrice: tpStr,
        markUsed: mark,
        presetAttempt,
      };
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message ?? e);
      presetErrors.push(`preset ${presetAttempt}: ${msg}`);
      await sleep(350 * presetAttempt);
    }
  }

  return { ok: false, reason: "preset_open_failed", presetErrors };
}

/**
 * @param {string} totalSize
 * @param {string[]} takeProfits
 * @param {number[]} ratios
 * @param {Record<string, unknown>} contractMeta
 * @param {(size: number, meta: Record<string, unknown>, opts: { mode?: string }) => string} formatOrderSize
 */
export function buildTpPlans(totalSize, takeProfits, ratios, contractMeta, formatOrderSize) {
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

/**
 * @param {ReturnType<typeof import("./bitget-api.js").createBitgetClient>} client
 * @param {{
 *   symbol: string;
 *   productType: string;
 *   marginCoin: string;
 *   holdSide: string;
 *   size: string;
 *   takeProfits: string[];
 *   tpPartialRatios: number[];
 *   contractMeta: Record<string, unknown>;
 *   cardId: number;
 *   skipFirstLevel?: boolean;
 * }} p
 */
export async function placeBitgetPartialTakeProfits(client, p) {
  const { formatOrderSize } = await import("./bitget-order-from-signal.js");
  const tps = p.takeProfits.map((x) => String(x).replace(/[^\d.]/g, "")).filter(Boolean);
  const startIdx = p.skipFirstLevel && tps.length > 1 ? 1 : 0;
  const sliceTps = tps.slice(startIdx);
  if (!sliceTps.length) return { tpResults: [] };

  const ratios = p.tpPartialRatios.slice(startIdx);
  const plans = buildTpPlans(p.size, sliceTps, ratios.length ? ratios : [1], p.contractMeta, formatOrderSize);
  /** @type {Array<Record<string, unknown>>} */
  const tpResults = [];

  for (const tp of plans) {
    try {
      const resp = await client.withHoldSideFallback(
        (hs) =>
          client.placeTpslOrder({
            symbol: p.symbol,
            productType: p.productType,
            marginCoin: p.marginCoin,
            planType: "profit_plan",
            triggerPrice: String(tp.price),
            holdSide: hs,
            size: String(tp.size),
            clientOid: `dc-tp${tp.level}-${p.cardId}-${Date.now()}`,
          }),
        p.holdSide
      );
      tpResults.push({ ...tp, orderId: resp?.data?.orderId ?? resp?.data?.planId, response: resp });
    } catch (e) {
      tpResults.push({ ...tp, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  }
  return { tpResults };
}

/**
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {string} text
 */
export async function sendBitgetTradeTelegramAlert(log, text) {
  if (process.env.BITGET_SKIP_TELEGRAM_ALERT === "1") return;
  try {
    const { createSystemTelegramAlert } = await import("./discord-system-telegram.js");
    const tg = createSystemTelegramAlert(log);
    await tg.notify(text, { kind: "bitget_naked_position" });
  } catch (e) {
    log.warn(`Bitget Telegram 告警发送失败: ${String(/** @type {Error} */ (e).message ?? e)}`);
  }
}

/**
 * 开仓后校验 TP/SL；缺失则 place-pos-tpsl；仍失败则按策略平仓或告警。
 * @param {ReturnType<typeof import("./bitget-api.js").createBitgetClient>} client
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {{
 *   symbol: string;
 *   productType: string;
 *   marginCoin: string;
 *   holdSide: string;
 *   size: string;
 *   stopLossStr: string;
 *   takeProfitStr: string;
 *   cardId: number;
 * }} ctx
 * @param {Record<string, unknown>} record
 */
export async function ensureBitgetPositionTpslAfterOpen(client, log, ctx, record) {
  if (!bitgetRequireTpslEnabled()) {
    record.tpslVerification = { skipped: true, reason: "BITGET_REQUIRE_TPSL=0" };
    return { ok: true, record };
  }

  const deadline = Date.now() + bitgetTpslVerifyWindowMs();
  let lastInspect = { hasSl: false, hasTp: false, ok: false };

  while (Date.now() < deadline) {
    lastInspect = await inspectBitgetPositionTpsl(client, ctx);
    if (lastInspect.ok) {
      record.tpslVerification = { ok: true, at: new Date().toISOString(), ...lastInspect };
      return { ok: true, record };
    }
    await sleep(500);
  }

  record.tpslVerification = {
    ok: false,
    preRepair: lastInspect,
    at: new Date().toISOString(),
  };

  const repairResult = await repairBitgetPositionTpsl(client, ctx, record);
  if (repairResult.ok) {
    record.tpslVerification = {
      ok: true,
      repaired: true,
      at: new Date().toISOString(),
      ...repairResult.inspect,
    };
    return { ok: true, record };
  }

  const action = bitgetNakedPositionAction();
  const repair = repairResult.repair ?? { attempts: [] };
  const category = repairResult.closeReason ?? repairResult.lastCategory ?? "unknown";
  const alertDetails = {
    symbol: ctx.symbol,
    holdSide: ctx.holdSide,
    cardId: ctx.cardId,
    category,
    lastError: repairResult.lastError ?? "",
    mark: repairResult.mark ?? 0,
    attempts: repair.attempts ?? [],
    closeImmediately: Boolean(repairResult.closeImmediately),
    action,
  };
  const alertText = formatBitgetNakedPositionAlert(alertDetails);

  const shouldClose =
    action === "close" && (repairResult.closeImmediately || category === "retries_exhausted" || category === "sl_breached");

  if (shouldClose) {
    try {
      const closeResp = await client.closePositions({
        symbol: ctx.symbol,
        productType: ctx.productType,
        holdSide: /** @type {"long"|"short"} */ (ctx.holdSide),
      });
      record.nakedPositionClosed = true;
      record.closeResponse = closeResp;
      record.status = "naked_closed";
      record.nakedCloseCategory = category;
      await sendBitgetTradeTelegramAlert(log, alertText);
      log.warn(`${alertText}`);
    } catch (e) {
      record.nakedPositionCloseError = String(/** @type {Error} */ (e).message ?? e);
      await sendBitgetTradeTelegramAlert(
        log,
        `${alertText}\n平仓失败: ${record.nakedPositionCloseError}`
      );
      log.warn(`Bitget 裸仓平仓失败 card=#${ctx.cardId}: ${record.nakedPositionCloseError}`);
      return { ok: false, record, reason: "naked_close_failed" };
    }
    return { ok: false, record, reason: "naked_closed" };
  }

  await sendBitgetTradeTelegramAlert(log, alertText);
  log.warn(`${alertText}（BITGET_NAKED_POSITION_ACTION=alert）`);
  return { ok: false, record, reason: "naked_alert_only" };
}
