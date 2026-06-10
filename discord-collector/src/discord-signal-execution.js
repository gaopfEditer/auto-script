/**
 * 信号卡片执行结果：信号计划 vs 实际成交。
 */

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
export function normalizeTradeLeg(leg) {
  if (!leg || typeof leg !== "object") return emptyTradeLeg();
  const o = /** @type {Record<string, unknown>} */ (leg);
  return {
    entryPrice: String(o.entryPrice ?? o.entry ?? "").trim(),
    takeProfitPrices: normalizePriceList(o.takeProfitPrices ?? o.takeProfits ?? o.targets),
    stopLossPrice: String(o.stopLossPrice ?? o.stopLoss ?? "").trim(),
  };
}

/** @param {unknown} leg @returns {SignalActualLeg} */
export function normalizeActualLeg(leg) {
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

/** @param {Record<string, unknown> | null | undefined} parsed */
export function executionFromParsed(parsed) {
  if (!parsed || typeof parsed !== "object") return emptyExecution();
  const p = parsed;
  const symbol = String(p.symbol ?? p.asset ?? "").trim();
  const direction = String(p.direction ?? "").trim();
  const entryRaw =
    p.entry ??
    (Array.isArray(p.entries) ? p.entries.join(" / ") : "") ??
    p.entryPrice ??
    "";
  const tpRaw = p.targets ?? p.takeProfits ?? p.takeProfit;
  const planned = normalizeTradeLeg({
    entryPrice: entryRaw,
    takeProfitPrices: tpRaw,
    stopLossPrice: p.stopLoss ?? p.stop_loss,
  });
  return { symbol, direction, planned, actual: emptyActualLeg(), outcome: "pending", outcomeNote: "" };
}

/** @param {unknown} raw @param {unknown} [parsedJson] @returns {SignalExecution} */
export function normalizeExecution(raw, parsedJson) {
  let ex = raw;
  if (typeof ex === "string") {
    try {
      ex = JSON.parse(ex);
    } catch {
      ex = null;
    }
  }
  if (ex && typeof ex === "object") {
    const o = /** @type {Record<string, unknown>} */ (ex);
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
  return executionFromParsed(
    parsedJson && typeof parsedJson === "object"
      ? /** @type {Record<string, unknown>} */ (parsedJson)
      : null
  );
}

/** @param {SignalExecution} ex */
export function formatManualRawContent(ex) {
  const tps = ex.planned.takeProfitPrices.length ? ex.planned.takeProfitPrices.join(", ") : "-";
  return [
    `手动信号 ${ex.symbol || "—"}`,
    `方向: ${ex.direction || "-"}`,
    `计划入场: ${ex.planned.entryPrice || "-"}`,
    `计划止盈: ${tps}`,
    `计划止损: ${ex.planned.stopLossPrice || "-"}`,
    `结果: ${outcomeLabel(ex.outcome)}`,
  ].join("\n");
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

/** @param {Record<string, unknown>} row */
export function summarizeCardExecution(row) {
  const ex = normalizeExecution(row.execution_json ?? row.executionJson, row.parsed_json ?? row.parsedJson);
  return { execution: ex, outcome: ex.outcome };
}

export const OUTCOME_VALUES = ["pending", "take_profit", "stop_loss", "manual_close", "cancelled"];
