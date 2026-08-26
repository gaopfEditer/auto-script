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
  if (!ex || typeof ex !== "object") {
    const n0 = String(note ?? "").trim();
    return n0 ? [`备注：${n0}`] : [];
  }
  if (ex.outcome && ex.outcome !== "pending") {
    lines.push(`结果：${outcomeLabel(ex.outcome)}`);
  }
  const a = ex.actual && typeof ex.actual === "object" ? ex.actual : {};
  const { entry, exit } = resolveActualEntryExit(a, ex.direction);
  if (entry != null) lines.push(`入场：${entry}`);
  if (exit != null) lines.push(`出场：${exit}`);
  const tp = takeProfitText(a);
  if (tp) lines.push(`止盈：${tp}`);
  if (a.stopLossPrice) lines.push(`止损：${a.stopLossPrice}`);
  if (a.exitPrice) lines.push(`平仓：${a.exitPrice}`);
  const profit = calcProfitPercents(
    a.buyPrice,
    a.sellPrice,
    ex.direction,
    resolveEvalLeverage(ex.symbol),
    ex.symbol
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
  if (!Number.isFinite(n) || n <= 0) return "";
  return `SC-${Math.trunc(n)}`;
}

/** @param {string} v @returns {string} */
export function dash(v) {
  const s = String(v ?? "").trim();
  return s || "—";
}

/** @param {string} direction */
export function isLongDirection(direction) {
  return resolveTradeDirection(direction) === "long";
}

/** @param {string} direction */
export function isShortDirection(direction) {
  return resolveTradeDirection(direction) === "short";
}

/**
 * @param {string} [direction]
 * @returns {"long" | "short" | null}
 */
export function resolveTradeDirection(direction) {
  const raw = String(direction ?? "").trim();
  if (!raw) return null;

  // 句首明确方向优先：「多 建仓…」「空 …」；避免正文「清空」误判为空单
  const lead = raw.match(/^(做多|做空|多单|空单|LONG|SHORT|多|空)(?=$|[\s:：·,，/|（(\[【]|\d)/i);
  if (lead) {
    return /空|SHORT/i.test(lead[1]) ? "short" : "long";
  }

  const d = raw.replace(
    /清空|空气|空调|空间|太空|空白|空泛|空想|空洞|空仓观望|空仓等待|空仓中|空方力量|多空博弈|多空|空头回补/g,
    "·"
  );
  if (/做空|空单|進空|\bSHORT\b/i.test(d)) return "short";
  if (/做多|多单|進多|\bLONG\b/i.test(d)) return "long";
  if (/(^|[^\u4e00-\u9fff])空([^\u4e00-\u9fff]|$)/.test(d)) return "short";
  if (/(^|[^\u4e00-\u9fff])多([^\u4e00-\u9fff]|$)/.test(d)) return "long";
  if (/\bsell\b/i.test(d) && !/\bbuy\b/i.test(d)) return "short";
  if (/\bbuy\b/i.test(d)) return "long";
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
 * 从 actual 解析入场/出场：统一 buy=入场、sell=出场。
 * 兼容旧清算数据（空单曾把 buy/sell 按开平方向反存）。
 * @param {{ buyPrice?: string, sellPrice?: string }} actual
 * @param {string} [direction]
 */
export function resolveActualEntryExit(actual, direction) {
  const buy = parsePrice(actual?.buyPrice);
  const sell = parsePrice(actual?.sellPrice);
  const side = resolveTradeDirection(direction);
  if (buy == null || sell == null || !side) {
    return { entry: buy, exit: sell, side };
  }
  if (side === "short" && buy < sell) {
    return { entry: sell, exit: buy, side };
  }
  return { entry: buy, exit: sell, side };
}

/**
 * 用户已填写入场/出场且可计算收益率 → 无需自动回测。
 * @param {SignalExecution} ex
 */
export function hasEvaluatedYield(ex) {
  const a = ex?.actual;
  if (!a) return false;
  const { entry, exit, side } = resolveActualEntryExit(a, ex.direction);
  if (entry == null || exit == null || !side) return false;
  return true;
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
  const side = resolveTradeDirection(direction);
  if (!side) return null;
  const { entry, exit } = resolveActualEntryExit({ buyPrice: buy, sellPrice: sell }, direction);
  if (entry == null || exit == null) return null;
  const spot = side === "short"
    ? ((entry - exit) / entry) * 100
    : ((exit - entry) / entry) * 100;
  const lev = resolveEvalLeverage(symbol, leverage);
  const leveragePct = spot * lev;
  return { spot, leveragePct, leverage: lev, side };
}

/** @param {unknown} raw */
function parseCardJsonBlob(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return /** @type {Record<string, unknown>} */ (raw);
  if (typeof raw === "string") {
    try {
      const v = JSON.parse(raw);
      return v && typeof v === "object" ? /** @type {Record<string, unknown>} */ (v) : null;
    } catch {
      return null;
    }
  }
  return null;
}

/**
 * 卡片杠杆盈亏 %：优先 actual 买卖价，其次清算 progress / backtest。
 * @param {Record<string, unknown>} card
 */
export function resolveCardPnlPct(card) {
  const ex = cardExecution(/** @type {import("./discordSignalApi.js").SignalCard} */ (card));
  const profit = calcProfitPercents(
    ex.actual.buyPrice,
    ex.actual.sellPrice,
    ex.direction,
    undefined,
    ex.symbol || card.symbol
  );
  if (profit) return profit.leveragePct;

  const progress = parseCardJsonBlob(card.progress ?? card.progress_json);
  if (progress && Number.isFinite(Number(progress.pnlPct))) {
    return Number(progress.pnlPct);
  }

  const bt = parseCardJsonBlob(card.backtest ?? card.backtest_json);
  if (bt) {
    const p = Number(bt.pnlPct ?? bt.pnl);
    if (Number.isFinite(p)) return p;
  }

  const rawEx = card.execution;
  if (rawEx && typeof rawEx === "object") {
    const auto = /** @type {Record<string, unknown>} */ (rawEx).autoEval;
    if (auto && typeof auto === "object" && Number.isFinite(Number(auto.pnlPct))) {
      return Number(auto.pnlPct);
    }
  }
  return null;
}

/** @param {number | null | undefined} pct @returns {string} */
export function formatProfitPercent(pct) {
  if (pct == null || !Number.isFinite(pct)) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

/** 隐藏 KOL 时掩码百分比：无正负号 `6***%`，有则 `+1***%` / `-1***%` */
export function maskProfitPercentText(formatted) {
  const s = String(formatted ?? "").trim();
  if (!s || s === "—") return s;
  const hasPct = s.endsWith("%");
  const body = hasPct ? s.slice(0, -1).trim() : s.trim();

  let sign = "";
  let rest = body;
  if (rest.startsWith("+") || rest.startsWith("-")) {
    sign = rest[0];
    rest = rest.slice(1).trim();
  }

  const digit = rest.match(/\d/)?.[0] ?? "";
  if (!digit) return `${sign}***${hasPct ? "%" : ""}`;

  return `${sign}${digit}***${hasPct ? "%" : ""}`;
}

/**
 * @param {Record<string, unknown>} card
 */
export function cardProfitBadge(card) {
  const pct = resolveCardPnlPct(card);
  if (pct == null || !Number.isFinite(pct)) return null;
  return {
    text: formatProfitPercent(pct),
    gain: pct > 0,
    loss: pct < 0,
  };
}

/** @param {Record<string, unknown>} card */
export function resolveCardEvalOutcome(card) {
  const ex = cardExecution(/** @type {import("./discordSignalApi.js").SignalCard} */ (card));
  if (ex.outcome && ex.outcome !== "pending") return ex.outcome;

  const progress = parseCardJsonBlob(card.progress ?? card.progress_json);
  const status = String(progress?.status ?? "").trim();
  const tpHits = Array.isArray(progress?.tpHits) ? progress.tpHits : [];
  const po = String(progress?.outcome ?? "").trim();

  if (tpHits.length > 0 || po === "take_profit" || status === "closed_tp") return "take_profit";
  if (status === "closed_sl" || po === "stop_loss" || progress?.slHitAt) return "stop_loss";

  const bt = parseCardJsonBlob(card.backtest ?? card.backtest_json);
  const bo = String(bt?.outcome ?? "").trim();
  if (bo === "take_profit" || bo === "stop_loss") {
    const entryHit = Boolean(progress?.entryHitAt);
    if (entryHit || bt?.entry != null) return bo;
  }

  if (hasEvaluatedYield(ex)) {
    if (tpHits.length > 0) return "take_profit";
    if (progress?.slHitAt || status === "closed_sl") return "stop_loss";
  }

  return ex.outcome || "pending";
}

/**
 * 是否已触发入场（与后端 card-eval-outcome 一致；未入场不计盈亏统计）。
 * @param {Record<string, unknown>} card
 */
export function isCardEnteredForEval(card) {
  const progress = parseCardJsonBlob(card.progress ?? card.progress_json);
  const status = String(progress?.status ?? "").trim();
  if (status === "not_entered") return false;

  const entryHit = Boolean(progress?.entryHitAt);
  if (entryHit) return true;
  if (
    status === "entered" ||
    status === "partial_tp" ||
    status === "closed_tp" ||
    status === "closed_sl"
  ) {
    return true;
  }

  const ex = cardExecution(/** @type {import("./discordSignalApi.js").SignalCard} */ (card));
  if (ex.outcome === "take_profit" || ex.outcome === "stop_loss") return true;
  if (hasEvaluatedYield(ex)) return true;

  const po = String(progress?.outcome ?? "").trim();
  if (po === "take_profit" || po === "stop_loss") return true;

  const bt = parseCardJsonBlob(card.backtest ?? card.backtest_json);
  const bo = String(bt?.outcome ?? "").trim();
  if (bo === "take_profit" || bo === "stop_loss") {
    if (bt?.entry != null || entryHit) return true;
  }

  return false;
}

/** @param {import("./discordSignalApi.js").SignalCard[]} cards */
export function statLineFromCards(cards) {
  /** @type {Record<string, number>} */
  const stats = {
    total: 0,
    pending: 0,
    take_profit: 0,
    stop_loss: 0,
    manual_close: 0,
    cancelled: 0,
    not_entered: 0,
  };
  for (const c of cards) {
    const row = /** @type {Record<string, unknown>} */ (c);
    if (!isCardEnteredForEval(row)) {
      stats.not_entered++;
      continue;
    }
    stats.total++;
    const o = resolveCardEvalOutcome(row);
    if (o in stats && o !== "total" && o !== "not_entered") stats[o]++;
    else stats.pending++;
  }
  return stats;
}

/**
 * 盈利率展示：优先 actual 买卖价，其次清算 progress / backtest。
 * @param {Record<string, unknown>} card
 */
export function resolveCardProfitDisplay(card) {
  if (!isCardEnteredForEval(/** @type {Record<string, unknown>} */ (card))) return null;
  const ex = cardExecution(/** @type {import("./discordSignalApi.js").SignalCard} */ (card));
  const profit = calcProfitPercents(
    ex.actual.buyPrice,
    ex.actual.sellPrice,
    ex.direction,
    undefined,
    ex.symbol || card.symbol
  );
  if (profit) return profit;
  const levPct = resolveCardPnlPct(card);
  if (levPct == null || !Number.isFinite(levPct)) return null;
  const lev = resolveEvalLeverage(ex.symbol || card.symbol);
  const side = resolveTradeDirection(ex.direction);
  if (!side) return null;
  return {
    spot: levPct / lev,
    leveragePct: levPct,
    leverage: lev,
    side,
  };
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
    const row = /** @type {Record<string, unknown>} */ (c);
    if (!isCardEnteredForEval(row)) continue;
    const pct = resolveCardPnlPct(row);
    if (pct == null || !Number.isFinite(pct)) continue;
    sum += pct;
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
