/**
 * 判断 Kook 消息是否为「完整做单」：同时包含入场与出场/止损止盈类信息。
 * 与 stream-collector/src/kook-trade-telegram-push.js 共用。
 */

/** @param {string} text */
export function normalizeTradeSignalText(text) {
  return String(text ?? "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .trim();
}

/**
 * @param {string} text 消息正文
 * @returns {boolean}
 */
export function isCompleteTradeSignal(text) {
  const t = normalizeTradeSignalText(text);
  if (t.length < 15) return false;

  const hasEntry =
    /(?:入场|建仓|市价|现价|挂单|保证金|附近)/.test(t) ||
    /直接(?:空|多)/.test(t) ||
    /\d+(?:\.\d+)?\s*倍/.test(t) ||
    /(?:再挂|挂)\s*\d/.test(t);

  const hasExit =
    /(?:芷損|芷楹|止盈|止损|止損|保本|逃命|强平)/.test(t) ||
    /移动.{0,8}(?:保本|止损|损)/.test(t);

  if (!hasEntry || !hasExit) return false;

  const hasDirection =
    /(?:做多|做空)/.test(t) ||
    /方向[：:\s]*(?:多|空|短空|短多|长多|长空)/.test(t) ||
    /(?:空|多)仓/.test(t);

  const hasSymbol =
    /#[A-Za-z0-9]{2,12}\b/.test(t) ||
    /\b(?:ETH|BTC|SOL|BNB|XRP|DOGE)\b/i.test(t);

  const hasTakeProfitLadder = /第[一二三四五六七八九十\d]+芷楹/.test(t) || /芷楹\s*\d/.test(t);

  return hasDirection || hasSymbol || hasTakeProfitLadder;
}

/** 粗筛：可能含做单关键词才值得调 AI */
export function mightBeTradeSignalRough(text) {
  const t = normalizeTradeSignalText(text);
  if (t.length < 12) return false;
  if (
    /(?:入场|建仓|市价|现价|挂单|保证金|芷損|芷楹|止盈|止损|止損|做空|做多|#\w{2,12}|倍|保证金|修改|调整|上移|下移|移至|减半|保本)/.test(
      t
    )
  ) {
    return true;
  }
  return t.length >= 40;
}
