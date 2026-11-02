/**
 * 从交易所晒单 OCR 文本解析盈利率、交易对、方向、杠杆、开仓价等。
 */

/** @param {string} raw */
export function normalizeOcrText(raw) {
  let t = String(raw ?? "")
    .replace(/\u200b/g, "")
    .replace(/[，]/g, ",");
  while (/(\d),(\d{3})/.test(t)) {
    t = t.replace(/(\d),(\d{3})/g, "$1$2");
  }
  return t.replace(/\s+/g, " ").trim();
}

/**
 * 提取晒单盈利率（百分比数值，不含 %）。取 OCR 中最显著的一条 ROI。
 * @param {string} text
 * @returns {number | null}
 */
export function extractProfitRatePct(text) {
  const t = String(text ?? "");
  if (!t.trim()) return null;

  /** @type {number[]} */
  const hits = [];
  for (const m of t.matchAll(/([+-]?\d+(?:\.\d+)?)\s*[%％]/g)) {
    const n = Number(m[1]);
    if (Number.isFinite(n)) hits.push(Math.abs(n));
  }
  if (!hits.length) return null;
  return Math.max(...hits);
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
 * @param {string} ocrText
 * @param {number} showOffMinProfitPct  ≥ 该值视为晒单
 */
export function classifyOcrPoster(ocrText, showOffMinProfitPct) {
  const profitRatePct = extractProfitRatePct(ocrText);
  const threshold = Number(showOffMinProfitPct);
  const isShowOff =
    profitRatePct != null && Number.isFinite(threshold) && profitRatePct >= threshold;
  const parsed = !isShowOff ? parseExchangePosterOcr(ocrText) : null;
  return { profitRatePct, isShowOff, parsed };
}
