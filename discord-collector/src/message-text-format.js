/**
 * 喊单正文：反转义 / HTML 换行；无换行时按常见模板拆行（kolvip 等 API 常压成一行）。
 */

/**
 * @param {string} raw
 */
export function decodeEscapedNewlines(raw) {
  let text = String(raw ?? "");
  if (!text) return "";
  return text
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/\u2028|\u2029/g, "\n")
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\\t/g, "\t");
}

/**
 * @param {string} text
 */
export function expandCollapsedSignalText(text) {
  const t = String(text ?? "");
  if (!t || /\n/.test(t)) return t;
  if (
    !/(ENTRY|TARGETS|STOP\s*LOSS|Direction|COIN|入场价|入场[：:]|目标价|目标[：:]|目标位|止损|方向|币种|📍|➖{3,})/i.test(
      t
    )
  ) {
    return t;
  }
  let out = t;
  out = out.replace(/\s*(➖{3,}➖*)\s*/g, "\n$1\n");
  out = out.replace(/\s+(?=📍)/g, "\n");
  out = out.replace(
    /\s+(?=(?:ENTRY|TARGETS|STOP\s*LOSS|Direction|COIN|SIGNAL\s*ID)\s*[:：])/gi,
    "\n"
  );
  out = out.replace(
    /\s+(?=(?:入场价|入场|目标价|目标位|目标|止损|方向|币种|信号编号|杠杆)\s*[:：])/g,
    "\n"
  );
  out = out.replace(/\s*(>>>\s*)/g, "\n");
  out = out.replace(/\s+(?=-\s*(?:Binance|【))/g, "\n");
  return out
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/**
 * @param {string} raw
 * @param {{ preserveLines?: boolean }} [opts]
 */
export function formatMessageTextForDisplay(raw, { preserveLines = true } = {}) {
  let text = decodeEscapedNewlines(raw);
  if (!text) return "";
  if (!preserveLines) {
    return text.replace(/\s+/g, " ").trim();
  }
  text = expandCollapsedSignalText(text);
  return text
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

const EN_SIGNAL_LABEL =
  /^(?:coin|direction|entry|entries|target|targets|stop\s*loss|stoploss|leverage|signal(?:\s*id)?)\s*[:：#]/i;
const ZH_SIGNAL_LABEL = /^(?:币种|方向|入场|建仓|目标|止盈|止损|杠杆|信号(?:编号)?)\s*[:：]/;

/**
 * kolvip 等双语喊单：上文英文模板 + 下文中文译文（以「币种：」等行起始）。
 * @param {string} text 已 format 的正文
 * @returns {{ english: string, chinese: string } | null}
 */
export function splitBilingualMessageText(text) {
  const t = String(text ?? "").trim();
  if (!t || !/\n/.test(t)) return null;
  const lines = t.split("\n");
  let firstEn = -1;
  let zhStart = -1;
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i].trim();
    if (!line) continue;
    if (firstEn < 0 && EN_SIGNAL_LABEL.test(line)) firstEn = i;
    if (ZH_SIGNAL_LABEL.test(line)) {
      zhStart = i;
      break;
    }
  }
  if (firstEn < 0 || zhStart < 0 || zhStart <= firstEn) return null;
  const english = lines.slice(0, zhStart).join("\n").trim();
  const chinese = lines.slice(zhStart).join("\n").trim();
  if (!english || !chinese) return null;
  return { english, chinese };
}

/** @param {string[]} lines @param {RegExp} re */
function firstLineMatching(lines, re) {
  for (const line of lines) {
    const t = String(line ?? "").trim();
    if (t && re.test(t)) return t;
  }
  return "";
}

/** 中文块缺字段时从英文模板补全（目标/止损/杠杆等）。 */
function enrichChineseSignalFromEnglish(chinese, english) {
  const zhLines = String(chinese ?? "")
    .split("\n")
    .map((l) => l.trimEnd());
  const enLines = String(english ?? "").split("\n");
  const hasZh = (re) => zhLines.some((l) => re.test(String(l).trim()));
  /** @type {string[]} */
  const add = [];
  const pairs = [
    { zhRe: /^杠杆\s*[:：]/, enRe: /^Leverage\s*[:：]/i, label: "杠杆" },
    { zhRe: /^目标\s*[:：]|^止盈\s*[:：]/, enRe: /^Targets?\s*[:：]/i, label: "目标" },
    { zhRe: /^止损\s*[:：]/, enRe: /^Stop\s*loss\s*[:：]|^Stoploss\s*[:：]/i, label: "止损" },
    { zhRe: /^入场\s*[:：]|^建仓\s*[:：]/, enRe: /^Entry\s*[:：]/i, label: "入场" },
    { zhRe: /^方向\s*[:：]/, enRe: /^Direction\s*[:：]/i, label: "方向" },
    { zhRe: /^币种\s*[:：]/, enRe: /^Coin\s*[:：#]/i, label: "币种" },
  ];
  for (const { zhRe, enRe, label } of pairs) {
    if (hasZh(zhRe)) continue;
    const enLine = firstLineMatching(enLines, enRe);
    if (!enLine) continue;
    const val = enLine.replace(/^[^:：]+[:：]\s*/i, "").trim();
    if (val) add.push(`${label}：${val}`);
  }
  if (!add.length) return chinese;
  return `${String(chinese).trim()}\n${add.join("\n")}`.trim();
}

/**
 * TG / 卡片推送：双语重复喊单只保留一侧（默认中文块）。
 * @param {string} raw
 * @param {"zh" | "en"} [lang]
 */
export function preferSingleLanguageSignalText(raw, lang = "zh") {
  const t = formatMessageTextForDisplay(raw, { preserveLines: true });
  if (!t) return "";
  const parts = splitBilingualMessageText(t);
  if (!parts) return t;
  if (lang === "en") return expandCollapsedSignalText(parts.english);
  let zh = expandCollapsedSignalText(parts.chinese);
  zh = enrichChineseSignalFromEnglish(zh, parts.english);
  return zh;
}