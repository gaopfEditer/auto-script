/**
 * Discord 各频道信号正文解析（规则 + 结构化字段）。
 */
import { normalizeSignalText } from "./discord-signal-dedup.js";

/** @param {string} text */
function lines(text) {
  return String(text ?? "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter(Boolean);
}

/** @param {string} line @param {RegExp} re */
function matchLine(line, re) {
  const m = line.match(re);
  return m ? String(m[1] ?? m[0]).trim() : "";
}

/** @param {string} text @param {RegExp} re @param {string} [flags] */
function matchAll(text, re) {
  return [...String(text ?? "").matchAll(re)].map((m) => String(m[1] ?? m[0]).trim());
}

/**
 * 中文币种名 → 标准 symbol（按需追加；较长名称优先匹配）
 * @type {Array<{ names: string[], symbol: string }>}
 */
const CN_SYMBOL_ALIASES = [
  { names: ["比特币"], symbol: "BTC" },
  { names: ["以太坊"], symbol: "ETH" },
];

/** @param {string} text */
function matchSymbolFromText(text) {
  const fromHash = matchLine(text, /#([A-Z0-9]+)/i);
  if (fromHash) return fromHash.toUpperCase();

  const sorted = [...CN_SYMBOL_ALIASES].sort((a, b) => {
    const maxA = Math.max(...a.names.map((n) => n.length));
    const maxB = Math.max(...b.names.map((n) => n.length));
    return maxB - maxA;
  });
  for (const { names, symbol } of sorted) {
    for (const name of names) {
      if (String(text ?? "").includes(name)) return symbol;
    }
  }
  return "";
}

/** 归一化后低于此长度忽略（闲聊/短回复） */
const MIN_SIGNAL_TEXT_LEN = 30;
/** 特征正则命中比例阈值 */
const SIGNAL_MATCH_RATIO = 0.8;

/** @param {string} text @param {RegExp[]} patterns */
function matchesSignalPatterns(text, patterns) {
  if (!patterns.length) return false;
  const hit = patterns.filter((re) => re.test(text)).length;
  return hit / patterns.length >= SIGNAL_MATCH_RATIO;
}

/** @type {Record<string, RegExp[]>} */
const SIGNAL_PATTERN_SETS = {
  binance_killers: [
    /COIN\s*:|货币\s*:|SIGNAL\s*ID|信号\s*ID/i,
    /Direction\s*:|方向\s*[：:]/i,
    /ENTRY\s*:|TARGETS\s*:|Target\s*\d|目标\s*\d/i,
    /STOP\s*LOSS|止损\s*[：:]/i,
    /USDT|\$\w+|\d+\.\d{2,}/,
  ],
  btc_cn: [
    /方向\s*[：:]/,
    /(多|空|做多|做空)/,
    /(入场|建仓)\s*[：:]/,
    /止盈\s*[：:]/,
    /(止损|倍数|仓位|信心度)\s*[：:]/,
  ],
  streak_cn: [
    /(BTC|ETH|比特币)/i,
    /(做多|做空|空|多)/,
    /(止盈|止损)\s*[：:]/,
    /(市价|保证金|再挂|附近|倍)/,
    /\d{4,}/,
  ],
  eth_short: [
    /(BTC|ETH|比特币)/i,
    /(做多|做空|空|多)/,
    /(止盈|止损)\s*[：:]/,
    /(市价|保证金|再挂|附近|倍)/,
    /\d{4,}/,
  ],
  tw_opg: [
    /#?[A-Z]{2,6}|OPG|比特币|以太坊/i,
    /(市價|市价|進空|進多|做多|做空|空|多)/,
    /(槓桿|杠杆|倉位|仓位)\s*[：:]/,
    /止盈/,
    /(止損|止损)\s*[：:]/,
  ],
  dabiaoke: [
    /(Btc|BTC|Eth|ETH|[A-Z]{2,10})/i,
    /方向\s*[：:]/,
    /(建仓|入场)\s*[：:]/,
    /止损\s*[：:]/,
    /止盈\s*[：:]/,
  ],
  feiyang: [
    /具体产品\s*[：:]/,
    /(进行方向|方向)\s*[：:]/,
    /(进场点位|入场|建仓)\s*[：:]/,
    /(止盈点位|止盈)\s*[：:]/,
    /(止损点位|止损)\s*[：:]/,
  ],
  fengge: [
    /[A-Z]{2,10}(现价|\/)/i,
    /(做多|做空|多|空)/,
    /止损\s*[：:]/,
    /止盈\s*[：:]/,
    /\d{2,}/,
  ],
  yanchi: [
    /[\d.]+[-–—][\d.]+/,
    /(空|多|做多|做空|再空)/,
    /止损/,
    /止盈/,
    /\d{3,}/,
  ],
  generic: [
    /(做多|做空|LONG|SHORT|多|空)/i,
    /(止盈|目标|TARGETS?|TP)\s*[：:]/i,
    /(止损|STOP\s*LOSS|SL)\s*[：:]/i,
    /(入场|建仓|ENTRY|进场)\s*[：:]/i,
    /\d{2,}/,
  ],
};

/**
 * @param {string} text
 * @param {import("./discord-signal-config.js").ParserKind} kind
 */
export function looksLikeSignal(text, kind) {
  const t = normalizeSignalText(text);
  if (t.length < MIN_SIGNAL_TEXT_LEN) return false;
  const patterns = SIGNAL_PATTERN_SETS[kind] ?? SIGNAL_PATTERN_SETS.generic;
  return matchesSignalPatterns(t, patterns);
}

/** @param {string} text */
export function parseBinanceKillers(text) {
  const ls = lines(text);
  const joined = ls.join("\n");
  const signalId =
    matchLine(joined, /信号\s*ID[：:\s]*([#\d\w-]+)/i) ||
    matchLine(joined, /SIGNAL\s*ID[：:\s]*([#\d\w-]+)/i) ||
    matchLine(joined, /#(\d+)/);
  const symbol =
    matchLine(joined, /货币[：:\s]*\$?([\w/]+)/i) ||
    matchLine(joined, /COIN[：:\s]*\$?([\w/]+)/i) ||
    matchLine(joined, /([A-Z]{2,10}\/USDT)/i);
  const direction =
    matchLine(joined, /方向[：:\s]*([^\n➖]+)/i) ||
    matchLine(joined, /Direction[：:\s]*([^\n➖]+)/i);
  const entry =
    matchLine(joined, /ENTRY[：:\s]*([^\n➖]+)/i) ||
    matchLine(joined, /入场[：:\s]*([^\n]+)/i);
  const leverage =
    matchLine(joined, /\(([^)]*倍[^)]*)\)/) ||
    matchLine(joined, /\(([^)]*\bx\b[^)]*)\)/i) ||
    matchLine(joined, /(\d+[-~]\d+倍)/);
  const targetsRaw =
    matchLine(joined, /TARGETS[：:\s]*([^\n]+)/i) ||
    matchLine(joined, /目标[：:\s]*([^\n]+)/i);
  const targetsFromLine = targetsRaw
    ? targetsRaw.split(/[-–—,\s]+/).map((x) => x.trim()).filter((x) => /^\d/.test(x))
    : [];
  const targets = [
    ...targetsFromLine,
    ...matchAll(joined, /目标\s*\d+[：:\s]*([\d.]+)/gi),
    ...matchAll(joined, /Target\s*\d+[：:\s]*([\d.]+)/gi),
  ];
  const stopLoss =
    matchLine(joined, /STOP\s*LOSS[：:\s]*([\d.]+)/i) ||
    matchLine(joined, /止损[：:\s]*([\d.]+)/i);
  if (!direction || (!targets.length && !entry)) return null;
  return {
    parser: "binance_killers",
    signalId,
    symbol: symbol.replace(/^\$/, ""),
    direction,
    entry,
    leverage,
    targets: [...new Set(targets)],
    stopLoss,
    title: "Binance Killers",
  };
}

/** @param {string} text */
export function parseBtcCn(text) {
  const blocks = String(text ?? "").split(/(?=比特币|BTC|#BTC)/i).map((b) => b.trim()).filter(Boolean);
  const block = blocks.find((b) => /方向[：:]/.test(b) && /(入场|建仓)[：:]/.test(b)) ?? text;
  const joined = lines(block).join("\n");
  const asset = /狗狗|DOGE|Doge/i.test(joined) ? "DOGE" : "BTC";
  const direction = matchLine(joined, /方向[：:\s]*([^\n]+)/);
  const entry = matchLine(joined, /入场[：:\s]*([^\n]+)/);
  const confidence = matchLine(joined, /信心度[：:\s]*([^\n]+)/);
  const leverage = matchLine(joined, /倍数[：:\s]*([^\n]+)/);
  const position = matchLine(joined, /仓位[：:\s]*([^\n]+)/);
  const takeProfit = matchLine(joined, /止盈[：:\s]*([\s\S]*?)(?=止损|理由|注：|$)/);
  const stopLoss = matchLine(joined, /止损[：:\s]*([^\n]+)/);
  const reason = matchLine(joined, /理由[：:\s]*([^\n]+)/);
  if (!direction || !entry) return null;
  return {
    parser: "btc_cn",
    symbol: asset,
    direction,
    entry,
    confidence,
    leverage,
    position,
    takeProfit: takeProfit.replace(/\s+/g, " ").trim(),
    stopLoss,
    reason,
    title: asset === "DOGE" ? "DOGE 信号" : "比特币信号",
  };
}

/** @param {string} text */
export function parseStreakCn(text) {
  const block =
    String(text ?? "")
      .split(/(?=BTC|ETH)/i)
      .find((b) => /(BTC|ETH)/i.test(b) && /(做多|做空|空|多)/.test(b)) ?? text;
  const joined = lines(block).join("\n");
  const asset = /ETH/i.test(joined) && !/BTC/i.test(joined) ? "ETH" : "BTC";
  const direction = /做空|空/.test(joined) ? "做空" : /做多|多/.test(joined) ? "做多" : "";
  const streak =
    matchLine(joined, /（(\d+连胜)）/) ||
    matchLine(joined, /\((\d+连胜)\)/) ||
    matchLine(joined, /累计(\d+连胜)/);
  let entries = matchAll(joined, /(\d+(?:\.\d+)?)\s*附近[^\n]*(?:市价|直接)/gi);
  if (!entries.length) entries = matchAll(joined, /(\d+(?:\.\d+)?)\s*市价[^\n]*/gi);
  const pending = matchAll(joined, /再挂(\d+(?:\.\d+)?)/gi);
  const takeProfits = matchAll(joined, /第[一二三四1234]止盈[：:\s]*([^\n]+)/gi);
  const stopLoss = matchLine(joined, /止损[：:\s]*([\d.]+)/i);
  const marginNotes = matchAll(joined, /(\d+%?\s*保证金)/gi);
  const leverageNotes = matchAll(joined, /(\d+倍)/gi);
  if (!direction || (!takeProfits.length && !stopLoss && !entries.length)) return null;
  return {
    parser: "streak_cn",
    asset,
    symbol: asset,
    direction,
    streak,
    entries,
    pending,
    takeProfits,
    stopLoss,
    marginNotes,
    leverageNotes,
    title: `${asset} ${direction}${streak ? `（${streak}）` : ""}`,
  };
}

/** @param {string} text */
export function parseEthShort(text) {
  return parseStreakCn(text);
}

/** @param {string} text */
export function parseDabiaoke(text) {
  const joined = lines(text).join("\n");
  const symRaw = matchLine(joined, /^(Btc|BTC|Eth|ETH|DOGE)/im) || matchLine(joined, /^([A-Z]{2,10})/im);
  const symbol = symRaw ? symRaw.toUpperCase() : "BTC";
  const direction = matchLine(joined, /方向[：:\s]*([^\n]+)/);
  const entry = matchLine(joined, /建仓[：:\s]*([\d.]+)/);
  const stopLoss = matchLine(joined, /止损[：:\s]*([\d.]+)/);
  const tpLine = matchLine(joined, /止盈[：:\s]*([^\n]+)/);
  const takeProfits = tpLine
    ? tpLine
        .split(/[-–—]/)
        .map((x) => x.trim())
        .filter((x) => /^\d/.test(x))
    : [];
  const note = lines(text)
    .slice(4)
    .join(" ")
    .trim();
  if (!direction || !entry) return null;
  return {
    parser: "dabiaoke",
    symbol,
    asset: symbol,
    direction,
    entry,
    stopLoss,
    takeProfits,
    note,
    title: `${symbol} · 大镖客`,
  };
}

/** @param {string} text */
export function parseFeiyang(text) {
  const joined = lines(text).join("\n");
  const symbol = matchLine(joined, /具体产品[：:\s]*([^\n]+)/);
  const direction = matchLine(joined, /进行方向[：:\s]*([^\n]+)/);
  const entry = matchLine(joined, /进场点位[：:\s]*([^\n]+)/);
  const stopLoss = matchLine(joined, /止损点位[：:\s]*([^\n]+)/);
  const takeProfit = matchLine(joined, /止盈点位[：:\s]*([^\n]+)/);
  if (!symbol || !direction) return null;
  return {
    parser: "feiyang",
    symbol: symbol.trim(),
    asset: symbol.trim(),
    direction,
    entry,
    stopLoss,
    takeProfit,
    takeProfits: takeProfit ? [takeProfit] : [],
    title: `${symbol.trim()} · 飞扬`,
  };
}

/** @param {string} text */
export function parseFengge(text) {
  const joined = lines(text).join("\n");
  const m = joined.match(/([A-Z]{2,10})现价([\d.]+)(做多|做空|多|空)/i);
  const symbol = m?.[1]?.toUpperCase() ?? matchLine(joined, /^([A-Z]{2,10})/i);
  const entry = m?.[2] ?? "";
  const direction = m?.[3] ?? (/做空|空/.test(joined) ? "做空" : /做多|多/.test(joined) ? "做多" : "");
  const stopLoss = matchLine(joined, /止损[：:\s]*([\d.]+)/);
  const takeProfit = matchLine(joined, /止盈[：:\s]*([\d.]+)/);
  if (!symbol || !direction) return null;
  return {
    parser: "fengge",
    symbol,
    asset: symbol,
    direction,
    entry,
    stopLoss,
    takeProfit,
    takeProfits: takeProfit ? [takeProfit] : [],
    title: `${symbol} · 峰哥`,
  };
}

/** @param {string} text */
export function parseYanchi(text) {
  const joined = lines(text).join("\n");
  const entry =
    matchLine(joined, /^([\d.]+[-–—][\d.]+)/m) ||
    matchLine(joined, /([\d.]+[-–—][\d.]+)\s*再空/) ||
    matchLine(joined, /([\d.]+[-–—][\d.]+)/);
  const direction = /再空|做空|空/.test(joined) ? "做空" : /做多|多/.test(joined) ? "做多" : "";
  const stopLoss = matchLine(joined, /止损[：:\s]*([\d.]+)/);
  const tpLine = matchLine(joined, /止盈[：:\s]*([^\n（]+)/);
  const takeProfits = tpLine
    ? tpLine
        .split(/[-–—]/)
        .map((x) => x.trim())
        .filter((x) => /^\d/.test(x))
    : [];
  const note = matchLine(joined, /不要踩点[^\n]*/);
  if (!entry || !direction) return null;
  return {
    parser: "yanchi",
    symbol: "BTC",
    asset: "BTC",
    direction,
    entry,
    stopLoss,
    takeProfits,
    note,
    title: "颜驰",
  };
}

/** @param {string} text */
export function parseTwOpg(text) {
  const joined = lines(text).join("\n");
  const symbol = matchSymbolFromText(joined) || "OPG";
  const direction = /進空|做空|空/.test(joined)
    ? "做空"
    : /進多|做多|多/.test(joined)
      ? "做多"
      : matchLine(joined, /(市價|市价)([^\n]+)/);
  const leverage = matchLine(joined, /槓桿建議[：:\s]*([^\n]+)/i) || matchLine(joined, /杠杆[：:\s]*([^\n]+)/i);
  const position = matchLine(joined, /倉位建議[：:\s]*([^\n]+)/i) || matchLine(joined, /仓位[：:\s]*([^\n]+)/i);
  const takeProfits = matchAll(joined, /第[一二三四1234]止盈[：:\s]*([\d.]+)/gi);
  const stopLoss = matchLine(joined, /止損[：:\s]*([\d.]+)/i) || matchLine(joined, /止损[：:\s]*([\d.]+)/i);
  const note = matchLine(joined, /穩健操作建議[：:\s]*([^\n]+)/i);
  if (!direction || !takeProfits.length || !stopLoss) return null;
  return {
    parser: "tw_opg",
    symbol,
    direction,
    leverage,
    position,
    takeProfits,
    stopLoss,
    note,
    title: `${symbol} ${typeof direction === "string" && direction.length <= 4 ? direction : "信号"}`,
  };
}

/**
 * @param {string} text
 * @param {import("./discord-signal-config.js").ParserKind} kind
 */
export function parseSignalText(text, kind) {
  const t = String(text ?? "").trim();
  if (!t || !looksLikeSignal(t, kind)) return null;
  switch (kind) {
    case "binance_killers":
      return parseBinanceKillers(t);
    case "btc_cn":
      return parseBtcCn(t);
    case "streak_cn":
    case "eth_short":
      return parseStreakCn(t);
    case "tw_opg":
      return parseTwOpg(t);
    case "dabiaoke":
      return parseDabiaoke(t);
    case "feiyang":
      return parseFeiyang(t);
    case "fengge":
      return parseFengge(t);
    case "yanchi":
      return parseYanchi(t);
    default:
      return (
        parseDabiaoke(t) ||
        parseBtcCn(t) ||
        parseStreakCn(t) ||
        parseFeiyang(t) ||
        parseFengge(t) ||
        parseYanchi(t) ||
        parseTwOpg(t) ||
        parseBinanceKillers(t)
      );
  }
}

/** @param {Record<string, unknown>} parsed @param {string} styleId */
export function formatCardFallback(parsed, styleId) {
  const useTw = styleId === "tw_formal";
  const useEn = styleId === "en_brief";
  const L = (cn, tw, en) => (useEn ? en : useTw ? tw : cn);

  if (parsed.parser === "binance_killers") {
    const targets = /** @type {string[]} */ (parsed.targets ?? []).join(useEn ? ", " : " · ");
    return [
      `${parsed.title ?? "Signal"} · ${parsed.symbol ?? ""}`,
      L(`方向：${parsed.direction}`, `方向：${parsed.direction}`, `${parsed.direction} ${parsed.symbol}`),
      parsed.entry ? L(`入场：${parsed.entry}`, `入場：${parsed.entry}`, `Entry ${parsed.entry}`) : "",
      parsed.leverage ? L(`杠杆：${parsed.leverage}`, `槓桿：${parsed.leverage}`, `Lev ${parsed.leverage}`) : "",
      targets ? L(`目标：${targets}`, `目標：${targets}`, `TP: ${targets}`) : "",
      parsed.stopLoss ? L(`止损：${parsed.stopLoss}`, `止損：${parsed.stopLoss}`, `SL ${parsed.stopLoss}`) : "",
      parsed.signalId ? `ID ${parsed.signalId}` : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (parsed.parser === "btc_cn") {
    return [
      `${parsed.title ?? "BTC"}`,
      L(`方向：${parsed.direction}`, `方向：${parsed.direction}`, `${parsed.direction}`),
      L(`入场：${parsed.entry}`, `入場：${parsed.entry}`, `Entry ${parsed.entry}`),
      parsed.leverage ? L(`倍数：${parsed.leverage}`, `倍數：${parsed.leverage}`, `Lev ${parsed.leverage}`) : "",
      parsed.takeProfit ? L(`止盈：${parsed.takeProfit}`, `止盈：${parsed.takeProfit}`, `TP ${parsed.takeProfit}`) : "",
      parsed.stopLoss ? L(`止损：${parsed.stopLoss}`, `止損：${parsed.stopLoss}`, `SL ${parsed.stopLoss}`) : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (parsed.parser === "eth_short" || parsed.parser === "streak_cn") {
    const tps = /** @type {string[]} */ (parsed.takeProfits ?? []).join(" · ");
    return [
      parsed.title ?? parsed.symbol ?? "信号",
      parsed.entries?.length ? L(`入场：${parsed.entries.join(" / ")}`, `入場：${parsed.entries.join(" / ")}`, `Entry ${parsed.entries.join("/")}`) : "",
      tps ? L(`止盈：${tps}`, `止盈：${tps}`, `TP ${tps}`) : "",
      parsed.stopLoss ? L(`止损：${parsed.stopLoss}`, `止損：${parsed.stopLoss}`, `SL ${parsed.stopLoss}`) : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (parsed.parser === "dabiaoke" || parsed.parser === "feiyang" || parsed.parser === "fengge" || parsed.parser === "yanchi") {
    const tps = /** @type {string[]} */ (parsed.takeProfits ?? []).join(" · ") || String(parsed.takeProfit ?? "");
    return [
      parsed.title ?? parsed.symbol ?? "信号",
      L(`方向：${parsed.direction}`, `方向：${parsed.direction}`, `${parsed.direction}`),
      parsed.entry ? L(`入场：${parsed.entry}`, `入場：${parsed.entry}`, `Entry ${parsed.entry}`) : "",
      tps ? L(`止盈：${tps}`, `止盈：${tps}`, `TP ${tps}`) : "",
      parsed.stopLoss ? L(`止损：${parsed.stopLoss}`, `止損：${parsed.stopLoss}`, `SL ${parsed.stopLoss}`) : "",
      parsed.note ? String(parsed.note) : "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  if (parsed.parser === "tw_opg") {
    const tps = /** @type {string[]} */ (parsed.takeProfits ?? []).join(" · ");
    return [
      `#${parsed.symbol} ${parsed.direction}`,
      parsed.leverage ? `槓桿：${parsed.leverage}` : "",
      parsed.position ? `倉位：${parsed.position}` : "",
      tps ? `止盈：${tps}` : "",
      parsed.stopLoss ? `止損：${parsed.stopLoss}` : "",
      parsed.note ?? "",
    ]
      .filter(Boolean)
      .join("\n");
  }

  return JSON.stringify(parsed, null, 2);
}
