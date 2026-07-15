/** @typedef {{
 *   entryPrice: string,
 *   takeProfitPrices: string[],
 *   stopLossPrice: string,
 * }} SignalTradeLeg */

/** @typedef {{
 *   buyPrice: string,
 *   sellPrice: string,
 *   takeProfitPrices: string[],
 *   stopLossPrice: string,
 *   exitPrice: string,
 *   closedAt: string | null,
 * }} SignalActualLeg */

/** @typedef {{
 *   symbol: string,
 *   direction: string,
 *   planned: SignalTradeLeg,
 *   actual: SignalActualLeg,
 *   outcome: string,
 *   outcomeNote: string,
 * }} SignalExecution */

/** @returns {SignalTradeLeg} */
export function emptyTradeLeg() {
  return { entryPrice: "", takeProfitPrices: [], stopLossPrice: "" };
}

/** @returns {SignalActualLeg} */
export function emptyActualLeg() {
  return {
    buyPrice: "",
    sellPrice: "",
    takeProfitPrices: [],
    stopLossPrice: "",
    exitPrice: "",
    closedAt: null,
  };
}

/** @returns {SignalExecution} */
export function emptyExecution() {
  return {
    symbol: "",
    direction: "",
    planned: emptyTradeLeg(),
    actual: emptyActualLeg(),
    outcome: "pending",
    outcomeNote: "",
  };
}

/** @param {unknown} v @returns {string[]} */
export function normalizePriceList(v) {
  if (Array.isArray(v)) return v.map((x) => String(x ?? "").trim()).filter(Boolean);
  const s = String(v ?? "").trim();
  if (!s) return [];
  return s
    .split(/[,，;\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
}

/** @param {unknown} leg @returns {SignalTradeLeg} */
function normalizeTradeLeg(leg) {
  if (!leg || typeof leg !== "object") return emptyTradeLeg();
  const o = /** @type {Record<string, unknown>} */ (leg);
  return {
    entryPrice: String(o.entryPrice ?? o.entry ?? "").trim(),
    takeProfitPrices: normalizePriceList(o.takeProfitPrices ?? o.takeProfits ?? o.targets),
    stopLossPrice: String(o.stopLossPrice ?? o.stopLoss ?? "").trim(),
  };
}

/** @param {unknown} leg @returns {SignalActualLeg} */
function normalizeActualLeg(leg) {
  if (!leg || typeof leg !== "object") return emptyActualLeg();
  const o = /** @type {Record<string, unknown>} */ (leg);
  const closedAt = o.closedAt ?? o.closed_at;
  return {
    buyPrice: String(o.buyPrice ?? o.buy ?? "").trim(),
    sellPrice: String(o.sellPrice ?? o.sell ?? "").trim(),
    takeProfitPrices: normalizePriceList(o.takeProfitPrices ?? o.takeProfits),
    stopLossPrice: String(o.stopLossPrice ?? o.stopLoss ?? "").trim(),
    exitPrice: String(o.exitPrice ?? o.exit ?? "").trim(),
    closedAt: closedAt ? String(closedAt) : null,
  };
}

/** @param {unknown} ex @param {Record<string, unknown> | null | undefined} [parsedJson] @returns {SignalExecution} */
export function normalizeExecution(ex, parsedJson) {
  let raw = ex;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  if (raw && typeof raw === "object") {
    const o = /** @type {Record<string, unknown>} */ (raw);
    if (o.planned || o.actual) {
      return {
        symbol: String(o.symbol ?? ""),
        direction: String(o.direction ?? ""),
        planned: normalizeTradeLeg(o.planned),
        actual: normalizeActualLeg(o.actual),
        outcome: String(o.outcome ?? "pending") || "pending",
        outcomeNote: String(o.outcomeNote ?? ""),
      };
    }
    return {
      symbol: String(o.symbol ?? ""),
      direction: String(o.direction ?? ""),
      planned: normalizeTradeLeg({
        entryPrice: o.entryPrice,
        takeProfitPrices: o.takeProfitPrices,
        stopLossPrice: o.stopLossPrice,
      }),
      actual: normalizeActualLeg({
        buyPrice: o.actualBuyPrice ?? o.buyPrice,
        sellPrice: o.actualSellPrice ?? o.sellPrice,
        takeProfitPrices: o.actualTakeProfitPrices,
        stopLossPrice: o.actualStopLossPrice,
        exitPrice: o.actualExitPrice ?? o.exitPrice,
        closedAt: o.closedAt,
      }),
      outcome: String(o.outcome ?? "pending") || "pending",
      outcomeNote: String(o.outcomeNote ?? ""),
    };
  }
  if (parsedJson && typeof parsedJson === "object") {
    const p = parsedJson;
    return {
      symbol: String(p.symbol ?? p.asset ?? ""),
      direction: String(p.direction ?? ""),
      planned: normalizeTradeLeg({
        entryPrice: p.entry ?? (Array.isArray(p.entries) ? p.entries[0] : "") ?? p.entryPrice,
        takeProfitPrices: p.targets ?? p.takeProfits ?? p.takeProfit,
        stopLossPrice: p.stopLoss ?? p.stop_loss,
      }),
      actual: emptyActualLeg(),
      outcome: "pending",
      outcomeNote: "",
    };
  }
  return emptyExecution();
}

/** @param {import("./discordSignalApi.js").SignalCard} card @returns {SignalExecution} */
export function cardExecution(card) {
  return normalizeExecution(card.execution, card.parsedJson);
}

/** @param {SignalTradeLeg | SignalActualLeg} leg */
export function takeProfitText(leg) {
  return (leg.takeProfitPrices ?? []).join(", ");
}

/** @param {string} text */
export function parseTakeProfitText(text) {
  return normalizePriceList(text);
}

/** @param {string} outcome */
export function outcomeLabel(outcome) {
  switch (outcome) {
    case "take_profit":
      return "止盈";
    case "stop_loss":
      return "止损";
    case "manual_close":
      return "手动平仓";
    case "cancelled":
      return "已取消";
    default:
      return "进行中";
  }
}

export const OUTCOME_OPTIONS = [
  { value: "pending", label: "进行中" },
  { value: "take_profit", label: "止盈" },
  { value: "stop_loss", label: "止损" },
  { value: "manual_close", label: "手动平仓" },
  { value: "cancelled", label: "已取消" },
];

/** @param {SignalExecution} a @param {SignalExecution} b */
export function executionEquals(a, b) {
  return JSON.stringify(a) === JSON.stringify(b);
}

/** @param {import("./discordSignalApi.js").SignalCard} card */
export function canTraceMessage(card) {
  const mid = String(card.messageId ?? "").trim();
  return Boolean(mid && !card.isManual && !mid.startsWith("manual-"));
}

/** @param {SignalExecution} ex @param {string} [note] */
export function hasEvaluation(ex, note = "") {
  const a = ex.actual;
  return Boolean(
    a.buyPrice ||
      a.sellPrice ||
      a.stopLossPrice ||
      a.exitPrice ||
      (a.takeProfitPrices?.length ?? 0) > 0 ||
      a.closedAt ||
      (ex.outcome && ex.outcome !== "pending") ||
      ex.outcomeNote ||
      String(note ?? "").trim()
  );
}

/** @param {SignalExecution} ex @param {string} [note] @returns {string[]} */
export function evaluationSummaryLines(ex, note = "") {
  /** @type {string[]} */
  const lines = [];
  if (ex.outcome && ex.outcome !== "pending") {
    lines.push(`结果：${outcomeLabel(ex.outcome)}`);
  }
  const a = ex.actual;
  if (a.buyPrice) lines.push(`入场：${a.buyPrice}`);
  if (a.sellPrice) lines.push(`出场：${a.sellPrice}`);
  const tp = takeProfitText(a);
  if (tp) lines.push(`止盈：${tp}`);
  if (a.stopLossPrice) lines.push(`止损：${a.stopLossPrice}`);
  if (a.exitPrice) lines.push(`平仓：${a.exitPrice}`);
  const profit = calcProfitPercents(
    a.buyPrice,
    a.sellPrice,
    ex.direction,
    resolveEvalLeverage(ex.symbol)
  );
  if (profit) {
    lines.push(
      `${directionLabel(profit.side)} · 盈利 ${formatProfitPercent(profit.spot)}（${profit.leverage}x ${formatProfitPercent(profit.leveragePct)}）`
    );
  }
  if (a.closedAt) {
    lines.push(`时间：${new Date(a.closedAt).toLocaleString("zh-CN")}`);
  }
  if (ex.outcomeNote) lines.push(`说明：${ex.outcomeNote}`);
  const n = String(note ?? "").trim();
  if (n) lines.push(`备注：${n}`);
  return lines;
}

/** @param {unknown} id @returns {string} */
export function formatCardId(id) {
  const n = Number(id);
  return Number.isFinite(n) && n > 0 ? `#${n}` : "";
}

/** @param {string} v @returns {string} */
export function dash(v) {
  const s = String(v ?? "").trim();
  return s || "—";
}

/** @param {string} direction */
export function isLongDirection(direction) {
  const d = String(direction ?? "").trim();
  if (/空|做空|SHORT/i.test(d)) return false;
  return /多|做多|LONG/i.test(d);
}

/** @param {string} direction */
export function isShortDirection(direction) {
  return /空|做空|SHORT/i.test(String(direction ?? "").trim());
}

/**
 * @param {string} [direction]
 * @returns {"long" | "short" | null}
 */
export function resolveTradeDirection(direction) {
  if (isShortDirection(direction)) return "short";
  if (isLongDirection(direction)) return "long";
  return null;
}

/** @param {"long" | "short" | null} side @returns {string} */
export function directionLabel(side) {
  if (side === "short") return "空";
  if (side === "long") return "多";
  return "—";
}

/** @type {{ major: number, altcoin: number }} */
const DEFAULT_EVAL_LEVERAGE = { major: 100, altcoin: 20 };

/** @type {{ major: number, altcoin: number }} */
let evalLeverageConfig = { ...DEFAULT_EVAL_LEVERAGE };

/** @param {{ major?: number, altcoin?: number } | null | undefined} cfg */
export function configureEvalLeverage(cfg) {
  if (!cfg || typeof cfg !== "object") return;
  const major = Number(cfg.major);
  const altcoin = Number(cfg.altcoin);
  if (Number.isFinite(major) && major > 0) evalLeverageConfig.major = major;
  if (Number.isFinite(altcoin) && altcoin > 0) evalLeverageConfig.altcoin = altcoin;
}

/** @returns {{ major: number, altcoin: number }} */
export function getEvalLeverageConfig() {
  return { ...evalLeverageConfig };
}

/**
 * @param {unknown} symbol
 * @returns {"major" | "altcoin"}
 */
export function detectSymbolTier(symbol) {
  const bare = String(symbol ?? "")
    .toUpperCase()
    .trim()
    .replace(/USDT$|USDC$|BUSD$/, "");
  return bare === "BTC" || bare === "ETH" ? "major" : "altcoin";
}

/**
 * @param {unknown} symbol
 * @param {number} [override]
 * @returns {number}
 */
export function resolveEvalLeverage(symbol, override) {
  const n = Number(override);
  if (Number.isFinite(n) && n > 0) return n;
  return detectSymbolTier(symbol) === "major"
    ? evalLeverageConfig.major
    : evalLeverageConfig.altcoin;
}

/** @param {unknown} symbol @returns {string} */
export function evalLeverageLabel(symbol) {
  return `${resolveEvalLeverage(symbol)}x`;
}

/** @param {string} price @returns {number | null} */
export function parsePrice(price) {
  const s = String(price ?? "").trim().replace(/,/g, "");
  const n = parseFloat(s);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 买入=入场价，卖出=出场价
 * @param {string} buy 入场
 * @param {string} sell 出场
 * @param {string} [direction]
 * @param {number} [leverage] 不传则按 symbol 推断（需配合第 5 参）
 * @param {unknown} [symbol]
 * @returns {{ spot: number, leveragePct: number, leverage: number, side: "long" | "short" } | null}
 */
export function calcProfitPercents(buy, sell, direction, leverage, symbol) {
  const entry = parsePrice(buy);
  const exit = parsePrice(sell);
  const side = resolveTradeDirection(direction);
  if (entry == null || exit == null || !side) return null;
  const spot = side === "short"
    ? ((entry - exit) / entry) * 100
    : ((exit - entry) / entry) * 100;
  const lev = resolveEvalLeverage(symbol, leverage);
  const leveragePct = spot * lev;
  return { spot, leveragePct, leverage: lev, side };
}

/** @param {number | null | undefined} pct @returns {string} */
export function formatProfitPercent(pct) {
  if (pct == null || !Number.isFinite(pct)) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

/** @param {import("./discordSignalApi.js").SignalCard[]} cards */
export function statLineFromCards(cards) {
  /** @type {Record<string, number>} */
  const stats = {
    total: cards.length,
    pending: 0,
    take_profit: 0,
    stop_loss: 0,
    manual_close: 0,
    cancelled: 0,
  };
  for (const c of cards) {
    const o = String(cardExecution(c).outcome ?? "pending");
    if (o in stats && o !== "total") stats[o]++;
    else stats.pending++;
  }
  return stats;
}

/**
 * 汇总卡片杠杆后收益率（仅含已填入场+出场且可计算的单）。
 * @param {import("./discordSignalApi.js").SignalCard[]} cards
 * @returns {{ sum: number, count: number } | null}
 */
export function sumLeverageProfitFromCards(cards) {
  let sum = 0;
  let count = 0;
  for (const c of cards) {
    const ex = cardExecution(c);
    const profit = calcProfitPercents(
      ex.actual.buyPrice,
      ex.actual.sellPrice,
      ex.direction,
      undefined,
      ex.symbol
    );
    if (!profit) continue;
    sum += profit.leveragePct;
    count += 1;
  }
  if (!count) return null;
  return { sum, count };
}

/** @param {import("./discordSignalApi.js").SignalCard} card */
export function isSignalCardActive(card) {
  if (card.status === "expired") return false;
  if (!card.expiresAt) return card.status === "active";
  return card.status === "active" && new Date(card.expiresAt).getTime() > Date.now();
}

/** @param {import("./discordSignalApi.js").SignalCard} card */
export function cardStatusLabel(card) {
  return isSignalCardActive(card) ? "有效" : "失效";
}

/** @param {SignalExecution} ex */
export function formatPlannedSummary(ex) {
  /** @type {string[]} */
  const parts = [];
  const sym = String(ex.symbol ?? "").trim().replace(/^\$/, "");
  if (sym) parts.push(sym);
  if (ex.direction) parts.push(ex.direction);
  const p = ex.planned;
  if (p.entryPrice) parts.push(`入场 ${p.entryPrice}`);
  const tp = takeProfitText(p);
  if (tp) parts.push(`止盈 ${tp}`);
  if (p.stopLossPrice) parts.push(`止损 ${p.stopLossPrice}`);
  return parts.length ? parts.join(" · ") : "—";
}

/** @param {SignalExecution} ex */
export function formatActualSummary(ex) {
  /** @type {string[]} */
  const parts = [];
  if (ex.direction) parts.push(ex.direction);
  const a = ex.actual;
  if (a.buyPrice) parts.push(`入场 ${a.buyPrice}`);
  if (a.sellPrice) parts.push(`出场 ${a.sellPrice}`);
  const tp = takeProfitText(a);
  if (tp) parts.push(`止盈 ${tp}`);
  if (a.stopLossPrice) parts.push(`止损 ${a.stopLossPrice}`);
  if (ex.outcome && ex.outcome !== "pending") parts.push(outcomeLabel(ex.outcome));
  return parts.length ? parts.join(" · ") : "—";
}

/** @param {import("./discordSignalApi.js").SignalCard} card */
export function cardBodyPreview(card, maxLines = 2) {
  const styles = Object.keys(card.cardsByStyle ?? {});
  const body = (styles.length ? card.cardsByStyle[styles[0]] : card.rawContent) ?? "";
  const text = String(body).trim();
  if (!text) return "";
  return text.split("\n").slice(0, maxLines).join(" / ");
}

/** @param {SignalExecution} ex @returns {SignalExecution} */
export function seedActualFromPlanned(ex) {
  const entry = String(ex.planned?.entryPrice ?? "").trim();
  const sl = String(ex.planned?.stopLossPrice ?? "").trim();
  const tps = [...(ex.planned?.takeProfitPrices ?? [])];
  const a = ex.actual;

  if (entry) {
    if (!a.buyPrice) a.buyPrice = entry;
  }
  if (sl && !a.stopLossPrice) a.stopLossPrice = sl;
  if (tps.length && !(a.takeProfitPrices?.length ?? 0)) {
    a.takeProfitPrices = [...tps];
  }
  if (!a.closedAt) a.closedAt = new Date().toISOString();
  return ex;
}

/** @param {SignalExecution} ex @param {string} [note] @returns {string} */
export function evaluationSummaryText(ex, note = "") {
  const lines = evaluationSummaryLines(ex, note);
  return lines.length ? lines.join("\n") : "暂无评价";
}

/** @param {SignalExecution} ex @param {Record<string, string | null>} [texts] */
export function buildExecutionPayload(ex, texts = {}) {
  const plannedTp = texts.plannedTp != null ? parseTakeProfitText(texts.plannedTp) : ex.planned.takeProfitPrices;
  const actualTp = texts.actualTp != null ? parseTakeProfitText(texts.actualTp) : ex.actual.takeProfitPrices;
  return {
    ...ex,
    planned: { ...ex.planned, takeProfitPrices: plannedTp },
    actual: { ...ex.actual, takeProfitPrices: actualTp },
  };
}
