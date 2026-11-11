/**
 * channel_profiles.json `placeAnOrder` 白名单 Telegram 群 → Debug 勾选平台自动开单。
 * `send` 只控制转发/CDP，不能单独授权下单。
 * 默认 20x、保证金 orderSizeUsdt（Debug 可调，默认 1U）、市价开仓 + 完整 TP/SL（5% SL + 5/8/12% 三档）。
 */
import { fetchFuturesPrice, parseEntryPrice } from "./card-price-fetch.js";
import { isShortDirection } from "./card-direction.js";
import { normalizeExecution } from "./discord-signal-execution.js";
import { applyDefaultTpSl } from "./card-liquidation-engine.js";
import { parseEntryPriceForOrder } from "./bitget-order-from-signal.js";
import { priceStr } from "./bitget-tpsl-guard.js";
import { isPlaceAnOrderChannel } from "./telegram-channel-profiles.js";
import { isPlaceholderTradeSymbol } from "./symbol-aliases.js";

export const TELEGRAM_TRADE_LEVERAGE = 20;
export const TELEGRAM_TRADE_INITIAL_SL_PCT = 5;

/**
 * Telegram 来源卡片能否自动下单。只认 placeAnOrder，不认 send，也不认 BITGET_AUTO_TRADE_CHANNEL_IDS。
 * @param {unknown} channelId
 * @param {string} [profilesFile]
 */
export function isTelegramAutoTradeChannel(channelId, profilesFile) {
  return isPlaceAnOrderChannel(channelId, profilesFile);
}

/** @returns {Record<string, unknown>} */
export function buildDefaultTelegramExitPlan() {
  return {
    takeProfitSizePcts: [30, 30, 40],
    slTrailAfterTp: ["entry", "tp1"],
    defaultApplied: true,
    slPct: TELEGRAM_TRADE_INITIAL_SL_PCT,
    tpPcts: [5, 8, 12],
  };
}

/**
 * @param {unknown} raw
 * @returns {number | null}
 */
function parseSlNum(raw) {
  const n = Number(String(raw ?? "").replace(/[^\d.]/g, ""));
  return Number.isFinite(n) && n > 0 ? n : null;
}

/** @param {unknown} entry */
function isMarketEntryLabel(entry) {
  const s = String(entry ?? "").trim();
  return !s || /市[价價]|现价|market/i.test(s);
}

/** @param {unknown[]} vals */
function firstNonBlank(...vals) {
  for (const v of vals) {
    const s = String(v ?? "").trim();
    if (s) return s;
  }
  return "";
}

/** @param {unknown[]} vals */
function firstRealSymbol(...vals) {
  for (const v of vals) {
    const s = String(v ?? "").trim();
    if (s && !isPlaceholderTradeSymbol(s)) return s;
  }
  return "";
}

/** @param {number} price */
function formatFetchedPrice(price) {
  return price.toFixed(8).replace(/0+$/, "").replace(/\.$/, "");
}

/**
 * 市价 / 缺价时补标记价或最新价，便于默认止盈止损。
 * `fetchPrice` 可注入，单测不访问网络。
 * @param {Record<string, unknown>} parsed
 * @param {ReturnType<typeof normalizeExecution>} execution
 * @param {string} symbol
 * @param {{ fetchPrice?: (symbol: string) => Promise<{ price?: number }> }} [opts]
 */
export async function enrichTelegramMarketEntry(parsed, execution, symbol, opts = {}) {
  const sym = firstRealSymbol(symbol, parsed.symbol, execution.symbol);
  if (!sym) return;
  const entryRaw = firstNonBlank(parsed.entry, execution.planned?.entryPrice);
  if (!isMarketEntryLabel(entryRaw)) return;
  const fetchPrice = opts.fetchPrice ?? fetchFuturesPrice;
  try {
    const { price } = await fetchPrice(sym);
    if (!Number.isFinite(price) || price <= 0) return;
    const entry = formatFetchedPrice(price);
    parsed.entry = entry;
    parsed.orderMode = String(parsed.orderMode ?? "market");
    execution.planned.entryPrice = entry;
    if (!execution.symbol || isPlaceholderTradeSymbol(execution.symbol)) execution.symbol = sym;
    if (!parsed.symbol || isPlaceholderTradeSymbol(String(parsed.symbol))) parsed.symbol = sym;
  } catch {
    /* 拉价失败时，若正文/解析里已有止损，后续仍可下单 */
  }
}

/**
 * 合并 execution → parsed，缺 TP/SL 时按 5/8/12% + 5% SL 补全（需有效入场价）。
 * @param {Record<string, unknown>} parsed
 * @param {ReturnType<typeof normalizeExecution>} execution
 */
export function prepareTelegramTradeParsed(parsed, execution) {
  /** @type {Record<string, unknown>} */
  const next = { ...parsed };
  next.parser = String(next.parser ?? "telegram");
  next.orderMode = "market";
  const realSymbol = firstRealSymbol(execution.symbol, next.symbol);
  next.symbol = realSymbol || firstNonBlank(execution.symbol, next.symbol);
  next.direction = firstNonBlank(execution.direction, next.direction);
  next.entry = firstNonBlank(next.entry, execution.planned?.entryPrice);
  if (isMarketEntryLabel(next.entry)) {
    const plannedEntry = String(execution.planned?.entryPrice ?? "").trim();
    if (plannedEntry && !isMarketEntryLabel(plannedEntry)) next.entry = plannedEntry;
  }

  /** @type {string[]} */
  let tps = [];
  const plannedTps = execution.planned?.takeProfitPrices ?? [];
  const parsedTps = Array.isArray(next.takeProfits) ? next.takeProfits : [];
  const tpSource = plannedTps.length ? plannedTps : parsedTps;
  tps = tpSource.map((x) => String(x ?? "").trim()).filter(Boolean);
  tps = tps.flatMap((p) => {
    const parts = p.split(/[,，/|｜\s—–~～-]+/).map((s) => s.trim()).filter((s) => /^[\d.]+$/.test(s) && Number(s) > 0);
    return parts.length ? parts : [];
  });
  let slRaw = firstNonBlank(next.stopLoss, execution.planned?.stopLossPrice);

  const direction = next.direction;
  const entryNum =
    parseEntryPriceForOrder(next.entry, direction) ??
    parseEntryPrice(next.entry) ??
    null;

  if (entryNum && entryNum > 0) {
    const isShort = isShortDirection(direction);
    const tpNums = tps
      .map((p) => Number(String(p).replace(/[^\d.]/g, "")))
      .filter((n) => Number.isFinite(n) && n > 0);
    let slNum = parseSlNum(slRaw);
    const needDefaultTp = !tps.length;
    const needDefaultSl = slNum == null;
    if (needDefaultTp || needDefaultSl) {
      const applied = applyDefaultTpSl(entryNum, isShort, tpNums, slNum);
      if (needDefaultTp) {
        tps = applied.tps.map((p) => priceStr(p));
      }
      if (needDefaultSl && applied.sl != null) {
        slRaw = priceStr(applied.sl);
        slNum = applied.sl;
      }
      if (!next.exitPlan || typeof next.exitPlan !== "object") {
        next.exitPlan = buildDefaultTelegramExitPlan();
      } else if (needDefaultSl) {
        next.exitPlan = { .../** @type {Record<string, unknown>} */ (next.exitPlan), defaultApplied: true };
      }
    }
  }

  next.takeProfits = tps;
  next.stopLoss = slRaw;
  const hasTpsl = tps.length >= 1 && Boolean(slRaw);
  if (hasTpsl) {
    next.signalPhase = "full";
    next.awaitingTpsl = false;
  } else if (next.signalPhase === "open" || next.awaitingTpsl === true) {
    next.signalPhase = "open";
    next.awaitingTpsl = true;
  } else {
    next.signalPhase = "open";
    next.awaitingTpsl = true;
  }
  if (next.exitPlan && typeof next.exitPlan === "object") {
    execution.planned.exitPlan = /** @type {Record<string, unknown>} */ (next.exitPlan);
  }
  execution.planned.takeProfitPrices = tps;
  execution.planned.stopLossPrice = slRaw;
  if (next.entry && (!execution.planned.entryPrice || isMarketEntryLabel(execution.planned.entryPrice))) {
    execution.planned.entryPrice = next.entry;
  }
  if (next.symbol) execution.symbol = String(next.symbol);
  if (next.direction) execution.direction = String(next.direction);

  return { parsed: next, execution };
}

/**
 * 自动开单前：补市价入场 + 缺省 TP/SL（5/8/12% + 5% SL）。
 * @param {Record<string, unknown>} parsed
 * @param {ReturnType<typeof normalizeExecution>} execution
 * @param {string} symbol
 */
/**
 * 把正文里的币种/方向/入场/止盈/止损补进空白字段。已有数值不被覆盖。
 * @param {Record<string, unknown>} parsed
 * @param {ReturnType<typeof normalizeExecution>} execution
 */
export function absorbTelegramSignalFields(parsed, execution) {
  if (!execution.planned) execution.planned = { entryPrice: "", takeProfitPrices: [], stopLossPrice: "" };
  const raw = firstNonBlank(parsed.rawContent, parsed.body, parsed.text);
  const fromText = raw ? extractTelegramTradeFields(raw) : null;

  const symbol = firstRealSymbol(parsed.symbol, execution.symbol, fromText?.symbol);
  if (symbol) {
    parsed.symbol = symbol;
    if (!execution.symbol || isPlaceholderTradeSymbol(execution.symbol)) execution.symbol = symbol;
  }

  const direction = firstNonBlank(parsed.direction, execution.direction, fromText?.direction);
  if (direction) {
    parsed.direction = direction;
    if (!String(execution.direction ?? "").trim()) execution.direction = direction;
  }

  let entry = firstNonBlank(parsed.entry, execution.planned.entryPrice);
  if ((!entry || isMarketEntryLabel(entry)) && fromText?.entry && !isMarketEntryLabel(fromText.entry)) {
    entry = fromText.entry;
  }
  if (entry) {
    parsed.entry = entry;
    const plannedEntry = String(execution.planned.entryPrice ?? "").trim();
    if (!plannedEntry || (isMarketEntryLabel(plannedEntry) && !isMarketEntryLabel(entry))) {
      execution.planned.entryPrice = entry;
    }
  }

  const plannedTps = Array.isArray(execution.planned.takeProfitPrices) ? execution.planned.takeProfitPrices : [];
  const parsedTps = Array.isArray(parsed.takeProfits) ? parsed.takeProfits : [];
  /** @type {string[]} */
  let tps = (plannedTps.length ? plannedTps : parsedTps).map((x) => String(x ?? "").trim()).filter(Boolean);
  if (!tps.length && fromText?.takeProfits?.length) tps = fromText.takeProfits;
  if (tps.length) {
    parsed.takeProfits = tps;
    if (!plannedTps.length) execution.planned.takeProfitPrices = tps;
  }

  const sl = firstNonBlank(parsed.stopLoss, execution.planned.stopLossPrice, fromText?.stopLoss);
  if (sl) {
    parsed.stopLoss = sl;
    if (!String(execution.planned.stopLossPrice ?? "").trim()) execution.planned.stopLossPrice = sl;
  }
}

/**
 * @param {Record<string, unknown>} parsed
 * @param {ReturnType<typeof normalizeExecution>} execution
 * @param {string} symbol
 * @param {{ fetchPrice?: (symbol: string) => Promise<{ price?: number }> }} [opts]
 */
export async function prepareAutoTradeForOrder(parsed, execution, symbol, opts = {}) {
  const nextParsed = { ...parsed };
  const nextEx = { ...execution, planned: { ...(execution.planned ?? {}) } };
  const hinted = firstRealSymbol(symbol);
  if (hinted) {
    if (!nextParsed.symbol || isPlaceholderTradeSymbol(String(nextParsed.symbol))) nextParsed.symbol = hinted;
    if (!nextEx.symbol || isPlaceholderTradeSymbol(nextEx.symbol)) nextEx.symbol = hinted;
  }
  absorbTelegramSignalFields(nextParsed, nextEx);
  await enrichTelegramMarketEntry(nextParsed, nextEx, hinted || String(nextParsed.symbol ?? ""), opts);
  return prepareTelegramTradeParsed(nextParsed, nextEx);
}

/** @param {ReturnType<typeof normalizeExecution>} execution */
export function telegramTradeRequiresStopLoss(execution) {
  return parseSlNum(execution.planned?.stopLossPrice) != null;
}

/** @param {ReturnType<typeof normalizeExecution>} execution */
export function telegramTradeRequiresTpsl(execution) {
  const tps = execution.planned?.takeProfitPrices ?? [];
  return tps.length >= 1 && telegramTradeRequiresStopLoss(execution);
}

/**
 * 分阶段市价开仓（initial / #SYMBOL+方向）可无完整 TP/SL，用 initialSlPct 先开仓。
 * @param {Record<string, unknown>} parsed
 * @param {ReturnType<typeof normalizeExecution>} execution
 */
export function telegramTradeCanStagedOpen(parsed, execution) {
  const sym = String(parsed.symbol ?? execution.symbol ?? "").trim();
  const dir = String(parsed.direction ?? execution.direction ?? "").trim();
  if (!sym || sym === "待补充" || !dir) return false;
  return (
    parsed.signalPhase === "open" ||
    parsed.awaitingTpsl === true ||
    (parsed.orderMode === "market" && !telegramTradeRequiresTpsl(execution))
  );
}

/**
 * 从 Telegram 正文抽出可用字段。缺币种或方向时仍返回已识别的止盈止损。
 * @param {unknown} raw
 */
export function extractTelegramTradeFields(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return { symbol: "", direction: "", entry: "", takeProfits: [], stopLoss: "" };

  let symbol = "";
  const labeled = text.match(/币[种種][：:]\s*([A-Z0-9]+)/i);
  if (labeled) symbol = String(labeled[1]).replace(/USDT$/i, "").toUpperCase();
  if (!symbol) {
    const hashes = [...text.matchAll(/#\s*([A-Z0-9]{2,12})/gi)]
      .map((m) => String(m[1]).toUpperCase())
      .filter((s) => s !== "PROM");
    if (hashes.length) symbol = hashes[0].replace(/USDT$/i, "");
  }
  if (!symbol) {
    const pair = text.match(/\b([A-Z]{2,12})\s*\/\s*USDT/i);
    if (pair) symbol = String(pair[1]).toUpperCase();
  }

  let direction = "";
  const dirBlock = text.match(/方向[：:][^\n]*/i)?.[0] ?? text;
  if (/空|📉|🔻|sell|short/i.test(dirBlock) && !/多|long|buy|📈/i.test(dirBlock)) {
    direction = "short";
  } else if (/多|📈|🚀|long|buy/i.test(dirBlock)) {
    direction = "long";
  }
  if (!direction && /市[价價]\s*空|空\s*市[价價]/.test(text)) direction = "short";
  if (!direction && /市[价價]\s*多|多\s*市[价價]/.test(text)) direction = "long";

  const entry =
    text.match(/(?:进场|進場|入场|入場)[点點][：:]\s*([^\n]+)/i)?.[1]?.trim() ??
    text.match(/entry[：:]\s*([^\n]+)/i)?.[1]?.trim() ??
    "";

  const tpRaw =
    text.match(/(?:获利|獲利|止盈)[目标標]?[：:]\s*([^\n]+)/i)?.[1]?.trim() ??
    text.match(/take\s*profit[：:]\s*([^\n]+)/i)?.[1]?.trim() ??
    "";
  /** @type {string[]} */
  const takeProfits = tpRaw
    ? tpRaw
        .split(/[,，/|\s—–~～-]+/)
        .map((s) => s.trim())
        .filter((s) => /^[\d.]+$/.test(s) && Number(s) > 0)
    : [];

  const stopLoss =
    text.match(/(?:止损|止損)[位置]?[：:]\s*([^\n]+)/i)?.[1]?.trim() ??
    text.match(/stop\s*loss[：:]\s*([^\n]+)/i)?.[1]?.trim() ??
    "";

  return { symbol, direction, entry, takeProfits, stopLoss };
}

/**
 * Debug 模拟用：轻量解析 Telegram 结构化信号正文。
 * @param {unknown} raw
 * @returns {{ symbol: string; direction: string; entry: string; takeProfits: string[]; stopLoss: string } | null}
 */
export function parseTelegramTradeTextLite(raw) {
  const fields = extractTelegramTradeFields(raw);
  if (!fields.symbol || !fields.direction) return null;
  return fields;
}
