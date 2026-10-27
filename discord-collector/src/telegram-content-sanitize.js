/**
 * Telegram 出站正文清理：去掉引流行、CDP 平台不需要的频道名首行。
 */

/** 含以下字样的整行视为引流/活动推广，直接删除 */
const PROMO_LINE_RE =
  /(?:会员|會員|专属策略|專屬策略|活动入口|活動入口|翻[仓倉][^\n]{0,16}(?:活动|活動)|联系助理|聯繫助理|限时活动|限時活動|详情看置顶|詳情看置頂|公开频道|公開頻道|跟单完全不收费|跟單完全不收費|欢迎来内部|歡迎來內部|免费体验|免費體驗|稳定输出|穩定輸出|累计发布|累計發佈|均止盈|连胜|連勝|私信|入群|开户|带单|開戶|帶单|帶單)/i;

const CDP_HEADER_LINE_RE = /^【[^】\n]{1,120}】\s*\n?/;

/** @param {unknown} text */
export function stripPromotionalLines(text) {
  const kept = [];
  for (const line of String(text ?? "").split(/\r?\n/)) {
    if (!line.trim()) continue;
    if (PROMO_LINE_RE.test(line)) continue;
    kept.push(line.replace(/\s+$/, ""));
  }
  return kept.join("\n").trim();
}

/** @param {unknown} text */
export function stripCdpPlatformHeader(text) {
  const s = String(text ?? "").trim();
  if (!s) return "";
  return s.replace(CDP_HEADER_LINE_RE, "").trimStart();
}

/** CDP 发布：去首行频道名 + 删引流行 */
export function sanitizeCdpPlatformText(text) {
  return stripPromotionalLines(stripCdpPlatformHeader(text));
}

/** Telegram 群推送：删引流行（保留【频道名】首行） */
export function sanitizeTelegramPushText(text) {
  return stripPromotionalLines(text);
}
