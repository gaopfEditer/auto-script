/**
 * 从交易所晒单 OCR 文本解析盈利率、交易对、方向、杠杆、开仓价等。
 */

/**
 * 胖猫单图 OCR 出卡门槛：收益率（有符号）小于该值才发信号。
 * 负数始终出卡（例如 -5）；等于或高于该值不出卡。
 */
export const PANGMAO_OCR_YIELD_EMIT_BELOW_PCT = 40;

/** @param {string} raw */
export function normalizeOcrText(raw) {
  let t = String(raw ?? "")
    .replace(/\u200b/g, "")
    .replace(/[＋]/g, "+")
    .replace(/[−–—]/g, "-")
    .replace(/[％]/g, "%")
    .replace(/[，]/g, ",");
  while (/(\d),(\d{3})/.test(t)) {
    t = t.replace(/(\d),(\d{3})/g, "$1$2");
  }
  return t.replace(/\s+/g, " ").trim();
}

/**
 * 同一绝对值时保留负数，避免把亏损晒单收成正收益。
 * @param {number[]} nums
 * @returns {number | null}
 */
function mostProminentSignedPct(nums) {
  if (!nums.length) return null;
  let best = nums[0];
  for (const n of nums.slice(1)) {
    const absN = Math.abs(n);
    const absBest = Math.abs(best);
    if (absN > absBest || (absN === absBest && n < best)) best = n;
  }
  return best;
}

/**
 * 提取晒单收益率（有符号百分比，不含 %）。
 * 优先「收益率 / 盈亏 / ROI / PnL」旁边的数字；否则取绝对值最大的一条并保留符号。
 * @param {string} text
 * @returns {number | null}
 */
export function extractProfitRatePct(text) {
  const t = normalizeOcrText(text);
  if (!t) return null;

  /** @type {number[]} */
  const labeled = [];
  const labelRe =
    /(?:收益率|盈亏率|盈虧率|盈亏|盈虧|ROI|PnL|PNL|收益)\s*[:：]?\s*([+-]?\d+(?:\.\d+)?)\s*%/gi;
  for (const m of t.matchAll(labelRe)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) labeled.push(n);
  }
  if (labeled.length) return mostProminentSignedPct(labeled);

  /** @type {number[]} */
  const hits = [];
  for (const m of t.matchAll(/([+-]?\d+(?:\.\d+)?)\s*%/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) hits.push(n);
  }
  return mostProminentSignedPct(hits);
}

/**
 * 单图 OCR 是否出交易信号。
 * 收益率缺失 → 否；负数 → 是；否则仅当 yield < threshold（默认 40，40 本身不出）。
 * @param {number | null | undefined} yieldPct
 * @param {number} [threshold]
 */
export function shouldEmitPangmaoOcrYield(yieldPct, threshold = PANGMAO_OCR_YIELD_EMIT_BELOW_PCT) {
  if (yieldPct == null || yieldPct === "") return false;
  const y = typeof yieldPct === "number" ? yieldPct : Number(yieldPct);
  if (!Number.isFinite(y)) return false;
  if (y < 0) return true;
  const max = Number(threshold);
  const limit = Number.isFinite(max) ? max : PANGMAO_OCR_YIELD_EMIT_BELOW_PCT;
  return y < limit;
}

/** @param {string} num */
function normalizePriceNum(num) {
  return String(num ?? "")
    .replace(/,/g, "")
    .trim();
}

/**
 * 解析 WEEX / 常见合约晒单 OCR 文本为开仓 parsed（pangmao 兼容字段）。
 * @param {string} text
 * @returns {Record<string, unknown> | null}
 */
export function parseExchangePosterOcr(text) {
  const joined = normalizeOcrText(text);
  if (!joined) return null;

  let symbol = "";
  const pairM =
    joined.match(/\b([A-Z0-9]{2,15})USDT\b/i) ||
    joined.match(/\b(ETH|BTC|BNB|SOL|XRP|DOGE|ADA|AVAX|LINK|MATIC|LTC|BCH|ETC|FIL|APT|ARB|OP|SUI|SEI|TIA|INJ|PEPE|WIF|BONK|JUP|WLD|ORDI|STX|NEAR|ATOM|DOT|UNI|AAVE|MKR|CRV|LDO|RNDR|FET|RENDER|TAO|ENA|ETHFI|PENDLE|ONDO|W|NOT|TON|TRX|SHIB|FLOKI|BOME|PEOPLE|1000PEPE|1000SHIB|1000BONK|1000FLOKI|1000SATS)\b/i);
  if (pairM) {
    symbol = String(pairM[1]).toUpperCase().replace(/USDT$/i, "");
  }
  if (!symbol) {
    const symAlt = joined.match(/\b([A-Z]{2,10})\b/);
    if (symAlt) symbol = symAlt[1].toUpperCase();
  }
  if (symbol) symbol = String(symbol).toUpperCase().replace(/USDT$/i, "");

  let direction = "";
  if (/做多|做\s*多|开多|Buy\s*Long|\bLong\b/i.test(joined) && !/做空|Short/i.test(joined)) {
    direction = "做多";
  } else if (/做空|做\s*空|开空|Sell\s*Short|\bShort\b/i.test(joined)) {
    direction = "做空";
  } else if (/[|｜]\s*多/.test(joined)) {
    direction = "做多";
  } else if (/[|｜]\s*空/.test(joined)) {
    direction = "做空";
  }

  let leverage = "";
  const levM = joined.match(/(\d{1,4})\s*[xX×]/);
  if (levM) leverage = levM[1];

  let entry = "";
  const entryM =
    joined.match(/(?:开仓价格|開倉價格|开仓价|開倉價|开仓|開倉|Entry\s*Price?)\s*[:：]?\s*([+-]?\d[\d,]*(?:\.\d+)?)/i) ||
    joined.match(/(?:开仓价格|開倉價格)\s*([+-]?\d[\d,]*(?:\.\d+)?)/i);
  if (entryM) entry = normalizePriceNum(entryM[1]);

  if (!symbol || !direction) return null;

  return {
    parser: "pangmao",
    symbol,
    asset: symbol,
    direction,
    entry: entry || "",
    leverage: leverage || "",
    stopLoss: "",
    takeProfits: [],
    targets: [],
    orderMode: "market",
    signalPhase: "open",
    awaitingTpsl: true,
    title: `${symbol} · 胖猫`,
    ocrPoster: true,
  };
}

/**
 * @param {Record<string, unknown>} parsed
 */
export function buildOcrSignalFingerprint(parsed) {
  const sym = String(parsed.symbol ?? "")
    .toUpperCase()
    .replace(/USDT$/i, "")
    .trim();
  const dir = String(parsed.direction ?? "").trim();
  const entry = normalizePriceNum(String(parsed.entry ?? ""));
  if (!sym || !dir) return "";
  return `${sym}|${dir}|${entry || "-"}`;
}

/**
 * 胖猫单图 OCR 判定。
 * reason:
 * - ok：币种、方向、收益率齐全，且收益率 < 门槛或为负
 * - missing_yield / missing_fields：不出卡
 * - yield_gate：收益率 ≥ 门槛且非负（晒单），不出卡
 * @param {string} ocrText
 * @param {number} showOffMinProfitPct  收益率 ≥ 该值且非负则不出卡（默认 40）
 */
export function classifyOcrPoster(ocrText, showOffMinProfitPct) {
  const joined = normalizeOcrText(ocrText);
  const profitRatePct = extractProfitRatePct(joined);
  const threshold = Number(showOffMinProfitPct);
  const parsedAttempt = joined ? parseExchangePosterOcr(joined) : null;
  /** @type {"ok"|"missing_yield"|"missing_fields"|"yield_gate"} */
  let reason = "ok";
  if (profitRatePct == null) reason = "missing_yield";
  else if (!shouldEmitPangmaoOcrYield(profitRatePct, threshold)) reason = "yield_gate";
  else if (!parsedAttempt) reason = "missing_fields";
  const parsed =
    reason === "ok" && parsedAttempt
      ? { ...parsedAttempt, profitRatePct }
      : null;
  return {
    profitRatePct,
    isShowOff: reason === "yield_gate",
    emit: reason === "ok",
    reason,
    parsed,
  };
}
