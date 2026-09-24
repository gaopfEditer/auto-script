/**
 * channel_profiles.json `send` 白名单 Telegram 群 → Debug 勾选平台自动开单。
 * 默认 20x、保证金 orderSizeUsdt（Debug 可调，默认 1U）、市价开仓 + 完整 TP/SL（5% SL + 5/8/12% 三档）。
 */
import { fetchFuturesPrice, parseEntryPrice } from "./card-price-fetch.js";
import { isShortDirection } from "./card-direction.js";
import { normalizeExecution } from "./discord-signal-execution.js";
import { applyDefaultTpSl } from "./card-liquidation-engine.js";
import { parseEntryPriceForOrder } from "./bitget-order-from-signal.js";
import { isCdpSendChannel } from "./telegram-channel-profiles.js";

export const TELEGRAM_TRADE_LEVERAGE = 20;
export const TELEGRAM_TRADE_INITIAL_SL_PCT = 5;

/** @param {unknown} channelId */
export function isTelegramAutoTradeChannel(channelId) {
  return isCdpSendChannel(channelId);
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

/**
 * 紧凑信号（#SYMBOL + 方向）无数字入场价时，用 Binance 现价补全以便默认 TP/SL。
 * @param {Record<string, unknown>} parsed
 * @param {ReturnType<typeof normalizeExecution>} execution
 * @param {string} symbol
 */
export async function enrichTelegramMarketEntry(parsed, execution, symbol) {
  const sym = String(symbol ?? parsed.symbol ?? execution.symbol ?? "").trim();
  if (!sym) return;
  const entryRaw = String(parsed.entry ?? execution.planned?.entryPrice ?? "").trim();
  if (!isMarketEntryLabel(entryRaw)) return;
  try {
    const { price } = await fetchFuturesPrice(sym);
    if (!Number.isFinite(price) || price <= 0) return;
    const entry = String(price);
    parsed.entry = entry;
    parsed.orderMode = String(parsed.orderMode ?? "market");
    execution.planned.entryPrice = entry;
    if (!execution.symbol) execution.symbol = sym;
  } catch {
    /* 无价则 maybeAutoTrade 仍会因缺 TP/SL 跳过 */
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
  next.symbol = String(execution.symbol ?? next.symbol ?? "").trim();
  next.direction = String(execution.direction ?? next.direction ?? "").trim();
  next.entry = String(execution.planned?.entryPrice ?? next.entry ?? "").trim();

  /** @type {string[]} */
  let tps = execution.planned?.takeProfitPrices?.length
    ? execution.planned.takeProfitPrices.map((x) => String(x ?? "").trim()).filter(Boolean)
    : Array.isArray(next.takeProfits)
      ? next.takeProfits.map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];
  let slRaw = String(execution.planned?.stopLossPrice ?? next.stopLoss ?? "").trim();

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
    const slNum = parseSlNum(slRaw);
    const needDefault = !tps.length || slNum == null;
    if (needDefault) {
      const applied = applyDefaultTpSl(entryNum, isShort, tpNums, slNum);
      if (!tps.length) {
        tps = applied.tps.map((p) => String(p));
      }
      if (slNum == null && applied.sl != null) {
        slRaw = String(applied.sl);
      }
      if (!next.exitPlan || typeof next.exitPlan !== "object") {
        next.exitPlan = buildDefaultTelegramExitPlan();
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
  if (!execution.planned.entryPrice && next.entry) {
    execution.planned.entryPrice = next.entry;
  }

  return { parsed: next, execution };
}

/** @param {ReturnType<typeof normalizeExecution>} execution */
export function telegramTradeRequiresTpsl(execution) {
  const tps = execution.planned?.takeProfitPrices ?? [];
  const sl = String(execution.planned?.stopLossPrice ?? "").trim();
  return tps.length >= 1 && Boolean(sl);
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
 * Debug 模拟用：轻量解析 Telegram 结构化信号正文。
 * @param {unknown} raw
 * @returns {{ symbol: string; direction: string; entry: string; takeProfits: string[]; stopLoss: string } | null}
 */
export function parseTelegramTradeTextLite(raw) {
  const text = String(raw ?? "").trim();
  if (!text) return null;

  let symbol = "";
  const symM =
    text.match(/币[种種][：:]\s*([A-Z0-9]+)/i) ??
    text.match(/#[\s]*([A-Z0-9]{2,12})/i) ??
    text.match(/\b([A-Z]{2,12})\s*\/\s*USDT/i);
  if (symM) symbol = String(symM[1]).replace(/USDT$/i, "").toUpperCase();

  let direction = "";
  const dirBlock = text.match(/方向[：:][^\n]*/i)?.[0] ?? text;
  if (/空|📉|🔻|sell|short/i.test(dirBlock) && !/多|long|buy|📈/i.test(dirBlock)) {
    direction = "short";
  } else if (/多|📈|🚀|long|buy/i.test(dirBlock)) {
    direction = "long";
  }
  if (!symbol || !direction) return null;

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
        .split(/[,，/|\s—–-]+/)
        .map((s) => s.trim())
        .filter((s) => /[\d.]/.test(s))
    : [];

  const stopLoss =
    text.match(/(?:止损|止損)[位置]?[：:]\s*([^\n]+)/i)?.[1]?.trim() ??
    text.match(/stop\s*loss[：:]\s*([^\n]+)/i)?.[1]?.trim() ??
    "";

  return { symbol, direction, entry, takeProfits, stopLoss };
}
