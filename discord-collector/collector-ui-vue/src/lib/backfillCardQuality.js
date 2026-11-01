/** 与 src/backfill-card-quality.js 同逻辑（本地展示过滤） */
const USDT_PAIR_RE = /#?([A-Z0-9]{2,12})USDT\b/gi;
const MIXED_PROMO_RE =
  /VIP|内部群|涨幅榜|长期共赢|每单精确|从不模糊喊单|193[,.]?\d+\s*%|🚀|💵|📉/i;

function humanBase(symbol) {
  return String(symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(/USDT$/i, "")
    .replace(/^(1000000|100000|10000|1000|1M)/i, "");
}

/** @param {string} text */
function mentionedUsdtBases(text) {
  /** @type {Set<string>} */
  const bases = new Set();
  for (const m of String(text ?? "").matchAll(USDT_PAIR_RE)) {
    const b = String(m[1] ?? "").trim().toUpperCase();
    if (b && !["USDT", "USDC", "BUSD", "USD"].includes(b)) bases.add(b);
  }
  return bases;
}

/** @param {Record<string, unknown>} card */
/** @param {Record<string, unknown> | null | undefined} item */
export function isBackfillKlineMiss(item) {
  if (!item || typeof item !== "object") return false;
  if (item.klineFailed) return true;
  const err = String(item.error ?? item.errorDetail ?? "");
  return /K线暂缺|K线全部|FUTURES_ALL|no_klines/i.test(err);
}

/** @param {Record<string, unknown>} c */
export function backfillOutcomeShortLabel(c) {
  if (c.marketEntryOverride && c.entered) return "市价假设";
  if (c.skipped) return "跳过";
  if (isBackfillKlineMiss(c)) return "K线暂缺";
  if (c.backtestInvalid) {
    const code = String(c.backtestInvalidCode ?? "");
    if (code === "polluted_signal") return "营销混排";
    if (code === "pnl_outlier") return "盈亏异常";
    if (code === "entry_market_mismatch") return "价偏过大";
    return "质量过滤";
  }
  if (c.error && !c.entered) {
    const e = String(c.error);
    if (e.length > 24) return e.slice(0, 22) + "…";
    return e;
  }
  if (!c.entered) return "未入场";
  if (c.outcome === "take_profit") return "止盈";
  if (c.outcome === "stop_loss") return "止损";
  if (c.outcome === "pending") return "进行中";
  if (c.error) return "失败";
  return "—";
}

export function isPollutedBackfillCard(card) {
  const preview = String(card.preview ?? card.body ?? "");
  const symBase = humanBase(card.symbol);
  const bases = mentionedUsdtBases(preview);
  if (bases.size >= 2) return true;
  if (symBase && bases.size === 1 && !bases.has(symBase)) return true;
  if (MIXED_PROMO_RE.test(preview) && (bases.size >= 1 || /#\w+USDT/i.test(preview))) return true;
  return false;
}
