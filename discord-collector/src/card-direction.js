/**
 * 卡片 / 信号「多空」方向解析。
 * 注意：正文里常见「清空」等词含「空」，不能用裸 `/空/` 判断。
 */

/** 含「空」但不是空单方向的干扰词 */
const SHORT_NOISE_RE =
  /清空|空气|空调|空间|太空|空白|空泛|空想|空洞|空仓观望|空仓等待|空仓中|空方力量|多空博弈|多空|空头回补/g;

/** @param {unknown} raw */
function scrubDirectionNoise(raw) {
  return String(raw ?? "").replace(SHORT_NOISE_RE, "·");
}

/**
 * @param {unknown} direction
 * @returns {"long" | "short" | null}
 */
export function resolveTradeDirection(direction) {
  const raw = String(direction ?? "").trim();
  if (!raw) return null;

  // 句首明确方向优先：「多 建仓…」「空 …」「做多」「做空」
  const lead = raw.match(/^(做多|做空|多单|空单|LONG|SHORT|多|空)(?=$|[\s:：·,，/|（(\[【]|\d)/i);
  if (lead) {
    return /空|SHORT/i.test(lead[1]) ? "short" : "long";
  }

  const d = scrubDirectionNoise(raw);
  if (/做空|空单|進空|\bSHORT\b/i.test(d)) return "short";
  if (/做多|多单|進多|\bLONG\b/i.test(d)) return "long";

  // 孤立的「空 / 多」（左右非汉字），避免再命中残余复合词
  if (/(^|[^\u4e00-\u9fff])空([^\u4e00-\u9fff]|$)/.test(d)) return "short";
  if (/(^|[^\u4e00-\u9fff])多([^\u4e00-\u9fff]|$)/.test(d)) return "long";

  if (/\bsell\b/i.test(d) && !/\bbuy\b/i.test(d)) return "short";
  if (/\bbuy\b/i.test(d)) return "long";
  return null;
}

/** @param {unknown} direction */
export function isShortDirection(direction) {
  return resolveTradeDirection(direction) === "short";
}

/** @param {unknown} direction */
export function isLongDirection(direction) {
  return resolveTradeDirection(direction) === "long";
}

/** @param {unknown} direction */
export function isShortSide(direction) {
  return isShortDirection(direction);
}
