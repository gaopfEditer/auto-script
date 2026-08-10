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
  { names: ["以太币", "以太坊"], symbol: "ETH" },
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
    /槓桿建議|槓桿[：:]/,
    /倉位建議|倉位[：:]/,
    /第[一二三四1234]止盈|止盈[：:]/,
    /(止損|止损)\s*[：:]/,
    /#?[A-Z]{2,6}|OPG|比特币|以太坊|市[價价]|進空|進多|做多|做空/,
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
  biquan_suozhang: [
    /比特币|以太坊|以太币|BTC|ETH/i,
    /止损[：:]/,
    /止盈|直营/,
    /(多一下|追个?空|做多|做空|附近\s*[多空]|开一点\s*空)/,
    /\d{3,}/,
  ],
  unknown_trader: [
    /#[A-Z0-9]+|\$[A-Z0-9]+/i,
    /(多头|空头|做多|做空)/,
    /入场价格[：:]/,
    /目标价格[：:]/,
    /止损价格[：:]/,
  ],
  altcoin_king: [
    /#[A-Z0-9]+/i,
    /市[價价][多空]/,
    /止盈/,
    /止[損损]/,
    /進場|入場|入场/,
    /\d+\.\d+/,
  ],
  /** 军长：现价开多/空 + 参考价 + 止损；TP 按 3%/6%/10% 推算 */
  junzhang: [
    /现价开/,
    /(多单|空单|做多|做空|[多空])/,
    /参考价格|[A-Z0-9]+[：:]\s*[\d.]+/i,
    /止损\s*[\d.]/,
    /\d+\.\d+/,
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
  if (isSimpleTpslText(t)) return true;
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
  const entry =
    matchLine(joined, /建仓[：:\s]*([\d.\-–—]+)/) || matchLine(joined, /入场[：:\s]*([\d.\-–—]+)/);
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
function resolveBiquanSuozhangDirection(text) {
  const t = String(text ?? "");
  if (/追个?空|追空|做空|开一点\s*空|附近\s*空|\s空(?:\s*$|[试（])/.test(t)) return "做空";
  if (/多一下|追多|做多|附近\s*多|\s多(?:\s*$|[试（])/.test(t)) return "做多";
  return "";
}

/** @param {string} firstLine */
function parseBiquanSuozhangEntry(firstLine) {
  const line = String(firstLine ?? "").trim();
  const m =
    line.match(/(?:比特币|以太坊|以太币|BTC|ETH)\s+(?:反弹)?\s*([\d.]+(?:\s*[-–—~]\s*[\d.]+)?)/i) ||
    line.match(/(?:反弹)?\s*([\d.]+(?:\s*[-–—~]\s*[\d.]+)?)\s*附近/i);
  if (!m) return "";
  return String(m[1]).replace(/\s+/g, "");
}

/** @param {string} text */
export function parseBiquanSuozhang(text) {
  const ls = lines(text);
  const joined = ls.join("\n");
  const head = ls[0] ?? joined;
  const symbol = matchSymbolFromText(head) || matchSymbolFromText(joined);
  const direction = resolveBiquanSuozhangDirection(head) || resolveBiquanSuozhangDirection(joined);
  const entry = parseBiquanSuozhangEntry(head);
  const stopLoss = matchLine(
    joined,
    /止损[：:\s]*(?:15分钟(?:有效)?(?:跌破|突破站稳|站稳))?([\d.]+)/i
  );
  const tpLine = matchLine(joined, /(?:止盈|直营)[：:\s]*([^\n（]+)/i);
  const takeProfits = tpLine
    ? tpLine
        .split(/[-–—~]+/)
        .map((x) => x.trim())
        .filter((x) => /^\d/.test(x))
    : [];
  const noteMatch = head.match(/[（(]([^）)]+)[）)]/);
  const note = noteMatch ? String(noteMatch[1]).trim() : "";
  if (!symbol || !direction || !entry) return null;
  const sym = symbol.toUpperCase();
  return {
    parser: "biquan_suozhang",
    symbol: sym,
    asset: sym,
    direction,
    entry,
    stopLoss,
    takeProfits,
    note,
    title: `${sym} · 币圈所长`,
  };
}

/** @param {string} text */
export function parseUnknownTrader(text) {
  const joined = lines(text).join("\n");
  const symbol =
    matchLine(joined, /#([A-Z0-9]+)/i) ||
    matchLine(joined, /\$([A-Z0-9]+)/i);
  const direction = /空头|做空/.test(joined)
    ? "做空"
    : /多头|做多/.test(joined)
      ? "做多"
      : "";
  const entry = matchLine(joined, /入场价格[：:\s]*([\d.]+)/);
  const target = matchLine(joined, /目标价格[：:\s]*([\d.]+)/);
  const stopLoss = matchLine(joined, /止损价格[：:\s]*([\d.]+)/);
  if (!symbol || !direction || !entry) return null;
  const sym = symbol.toUpperCase();
  const takeProfits = target ? [target] : [];
  return {
    parser: "unknown_trader",
    symbol: sym,
    asset: sym,
    direction,
    entry,
    targets: takeProfits,
    takeProfits,
    stopLoss,
    title: `${sym} · unknown-trader`,
  };
}

/** @param {string} raw */
function parseTakeProfitLevels(raw) {
  if (!raw) return [];
  const cleaned = String(raw)
    .split(/\s*止[损損]/)[0]
    .trim();
  if (!cleaned) return [];
  if (/[-–—]/.test(cleaned)) {
    return cleaned
      .split(/[-–—]+/)
      .map((x) => x.trim())
      .filter((x) => /^\d/.test(x));
  }
  const single = cleaned.match(/^([\d.]+)/);
  if (single) return [single[1]];
  return cleaned
    .split(/[\s,，;；/]+/)
    .map((x) => x.trim())
    .filter((x) => /^\d/.test(x));
}

/**
 * 通用止盈/止损提取：支持同行或分行、单档或多档；止损可无冒号（止损4.13）。
 * 例：`止盈：4.71   止損：4.9`、`止盈：3.799-3.685\n止损4.13`、`止盈：64.5-65.5-67 止損：63.7`
 * @param {string} text
 */
function extractTpslFields(text) {
  const joined = String(text ?? "");
  const tpLine = matchLine(joined, /止盈[：:\s]*([^\n]+)/i);
  const takeProfits = parseTakeProfitLevels(tpLine);
  const stopLoss = matchLine(joined, /止[损損]\s*[：:]?\s*([\d.]+)/i);
  return { takeProfits, stopLoss };
}

/** @param {string} text */
function isSimpleTpslText(text) {
  const t = String(text ?? "");
  if (!/止盈/.test(t) || !/止[损損]/.test(t)) return false;
  const { takeProfits, stopLoss } = extractTpslFields(t);
  return takeProfits.length > 0 && Boolean(stopLoss);
}

/** 市价开仓方向：市價空 / 市價進空 / 市价进空 等 */
const MARKET_DIR_RE = String.raw`(?:進空|进空|進多|进多|做空|做多|[空多])`;

/**
 * @param {string} text
 * @returns {{ symbol: string, direction: string, entry: string } | null}
 */
function matchMarketOpen(text) {
  const joined = String(text ?? "");
  const m =
    joined.match(new RegExp(String.raw`#([A-Z0-9]+)\s*市[價价]\s*(${MARKET_DIR_RE})(?:\s*(?:進場|进场|入場|入场)?\s*([\d.]+))?`, "i")) ||
    joined.match(new RegExp(String.raw`开单\s+#?([A-Z0-9]+)\s*市[價价]?\s*(${MARKET_DIR_RE})`, "i"));
  if (!m) return null;
  const dirRaw = String(m[2] ?? "");
  const direction = /空|short/i.test(dirRaw) ? "做空" : /多|long/i.test(dirRaw) ? "做多" : "";
  if (!direction) return null;
  return {
    symbol: String(m[1] ?? "").toUpperCase(),
    direction,
    entry: String(m[3] ?? "").trim(),
  };
}

/** @param {string} text */
function isMarketOpenText(text) {
  return Boolean(matchMarketOpen(text));
}

/** @param {string} text */
export function parseAltcoinKing(text) {
  const joined = lines(text).join("\n");
  const open = matchMarketOpen(joined);
  const { takeProfits, stopLoss } = extractTpslFields(joined);

  if (open) {
    const { symbol, direction, entry } = open;
    const hasTpsl = takeProfits.length > 0 && Boolean(stopLoss);
    return {
      parser: "altcoin_king",
      symbol,
      asset: symbol,
      direction,
      entry,
      takeProfits,
      stopLoss: stopLoss || "",
      orderMode: "market",
      signalPhase: hasTpsl ? "full" : "open",
      awaitingTpsl: !hasTpsl,
      title: `${symbol} · 山寨之王`,
    };
  }

  if (takeProfits.length && stopLoss) {
    const symbol = matchLine(joined, /#([A-Z0-9]+)/i).toUpperCase();
    return {
      parser: "altcoin_king",
      symbol,
      asset: symbol,
      direction: "",
      entry: "",
      takeProfits,
      stopLoss,
      signalPhase: "tpsl",
      title: symbol ? `${symbol} · 山寨之王 TP/SL` : "山寨之王 TP/SL",
    };
  }

  return null;
}

/** @param {string} text @param {RegExp} re */
function matchTwOpgField(text, re) {
  const m = String(text ?? "").match(re);
  return m ? String(m[1] ?? m[0]).trim() : "";
}

/** @param {string[]} takeProfits @param {string} stopLoss */
function inferDirectionFromTpSl(takeProfits, stopLoss) {
  const tps = takeProfits.map((x) => parseFloat(String(x).replace(/,/g, ""))).filter(Number.isFinite);
  const sl = parseFloat(String(stopLoss ?? "").replace(/,/g, ""));
  if (!tps.length || !Number.isFinite(sl)) return "";
  const minTp = Math.min(...tps);
  const maxTp = Math.max(...tps);
  const ascending = tps.every((v, i) => i === 0 || v >= tps[i - 1]);
  const descending = tps.every((v, i) => i === 0 || v <= tps[i - 1]);
  if (sl > maxTp && descending) return "做空";
  if (sl < minTp && ascending) return "做多";
  if (sl > maxTp) return "做空";
  if (sl < minTp) return "做多";
  return "";
}

/** @param {string} text */
function resolveTwOpgDirection(text) {
  const t = String(text ?? "");
  if (/進空|进空|做空/.test(t)) return "做空";
  if (/進多|进多|做多/.test(t)) return "做多";
  const mkt = matchLine(t, new RegExp(String.raw`(市價|市价)\s*(${MARKET_DIR_RE})`));
  if (mkt) {
    if (/空|進空|进空|做空/i.test(mkt)) return "做空";
    if (/多|進多|进多|做多/i.test(mkt)) return "做多";
  }
  return "";
}

/** @param {string} text */
export function parseTwOpg(text) {
  const joined = lines(text).join("\n");
  let symbol = matchSymbolFromText(joined);
  if (!symbol) {
    const symM = joined.match(/(?:^|[\s#])#?([A-Z0-9]{2,12})(?:USDT)?(?:\s|$|[^a-z])/i);
    if (symM) symbol = symM[1].toUpperCase();
  }
  const open = matchMarketOpen(joined);
  const tpBoundary = "第[一二三四1234]止盈|止盈[：:]|止[損损]|穩健操作建議|稳健操作建议|$";
  const leverage =
    matchTwOpgField(
      joined,
      new RegExp(`槓桿建議[：:\\s]*([\\s\\S]+?)(?=倉位建議|仓位建议|${tpBoundary})`, "i")
    ) ||
    matchTwOpgField(
      joined,
      new RegExp(`杠杆[：:\\s]*([\\s\\S]+?)(?=仓位建议|倉位建議|${tpBoundary})`, "i")
    );
  const position =
    matchTwOpgField(joined, new RegExp(`倉位建議[：:\\s]*([\\s\\S]+?)(?=${tpBoundary})`, "i")) ||
    matchTwOpgField(joined, new RegExp(`仓位建议[：:\\s]*([\\s\\S]+?)(?=${tpBoundary})`, "i"));
  const numberedTps = [...matchAll(joined, /第[一二三四1234]止盈[：:\s]*([\d.]+)/gi)].filter(Boolean);
  const { takeProfits: simpleTps, stopLoss } = extractTpslFields(joined);
  const takeProfits = numberedTps.length ? numberedTps : simpleTps;
  const note = matchTwOpgField(joined, /穩健操作建議[：:\s]*([\s\S]+?)$/i) || matchTwOpgField(joined, /稳健操作建议[：:\s]*([\s\S]+?)$/i);

  if (open && !takeProfits.length && !stopLoss) {
    return {
      parser: "tw_opg",
      symbol: open.symbol,
      direction: open.direction,
      entry: open.entry,
      orderMode: "market",
      signalPhase: "open",
      awaitingTpsl: true,
      title: `${open.symbol} ${open.direction}`,
    };
  }

  if (!takeProfits.length || !stopLoss) return null;

  let direction = resolveTwOpgDirection(joined);
  if (!direction) direction = inferDirectionFromTpSl(takeProfits, stopLoss);

  const dirLabel = direction || "待确认";
  const isTpslOnly = !open && !resolveTwOpgDirection(joined.replace(/开单/g, ""));

  return {
    parser: "tw_opg",
    symbol: (open?.symbol || symbol || "").trim(),
    direction: dirLabel,
    leverage: String(leverage ?? "").trim(),
    position: String(position ?? "").trim(),
    takeProfits,
    stopLoss,
    note,
    signalPhase: isTpslOnly ? "tpsl" : "full",
    orderMode: open ? "market" : undefined,
    title: open?.symbol || symbol ? `${open?.symbol || symbol} ${dirLabel}` : `seven ${dirLabel}`,
  };
}

/**
 * 按入场价与方向换算百分比止盈价。
 * @param {string|number} entry
 * @param {number} pct 如 0.03
 * @param {boolean} isLong
 */
function priceAtPctFromEntry(entry, pct, isLong) {
  const e = Number(entry);
  if (!Number.isFinite(e) || e <= 0 || !Number.isFinite(pct)) return "";
  const raw = isLong ? e * (1 + pct) : e * (1 - pct);
  const frac = String(entry).includes(".") ? (String(entry).split(".")[1]?.length ?? 0) : 0;
  const decimals = Math.min(8, Math.max(frac, 4));
  const n = Number(raw.toFixed(decimals));
  return Number.isFinite(n) && n > 0 ? String(n) : "";
}

/** 军长：止损常单独补发，关联窗口约 2 分钟 */
export const JUNZHANG_SL_LINK_MS = 2 * 60 * 1000;

/**
 * 军长频道：现价开仓 + 参考价；TP1/2/3 = ±3%/6%/10%。
 * 止损可同条，或约 2 分钟内另条 `止损0.0065` 合并。
 * 例：`XAI现价开个多` … `XAI：0.00696` …（另条）`止损0.0065`
 * @param {string} text
 */
export function parseJunzhang(text) {
  const joined = lines(text).join("\n");
  const stopLoss =
    matchLine(joined, /止损\s*[：:]?\s*([\d.]+)/i) ||
    matchLine(joined, /止[損损]\s*[：:]?\s*([\d.]+)/i);

  const openM =
    joined.match(/([A-Z][A-Z0-9]{1,14})\s*现价开个?([多空])(?:单)?/i) ||
    joined.match(/💰\s*([A-Z][A-Z0-9]{1,14})\s*现价开个?([多空])(?:单)?/i);
  let symbol = openM?.[1] ? String(openM[1]).toUpperCase() : "";
  let dirChar = openM?.[2] ? String(openM[2]) : "";

  if (!symbol) {
    const refSym = joined.match(/(?:^|\n)\s*([A-Z][A-Z0-9]{1,14})\s*[：:]\s*([\d.]+)/im);
    if (refSym) symbol = String(refSym[1]).toUpperCase();
  }
  if (!dirChar) {
    if (/现价开个?空|空单|做空/.test(joined) && !/现价开个?多|多单|做多/.test(joined)) {
      dirChar = "空";
    } else if (/现价开个?多|多单|做多|开个多/.test(joined)) {
      dirChar = "多";
    }
  }
  const direction = dirChar === "空" ? "做空" : dirChar === "多" ? "做多" : "";

  let entry = "";
  if (symbol) {
    const m = joined.match(new RegExp(String.raw`${symbol}\s*[：:]\s*([\d.]+)`, "i"));
    if (m) entry = m[1];
  }
  if (!entry) {
    entry =
      matchLine(joined, /参考价格[：:\s]*\n?\s*[A-Z0-9]+\s*[：:]\s*([\d.]+)/i) ||
      matchLine(joined, /参考价格[^\d]*([\d.]+)/i);
  }
  if (!entry) {
    const anyPrice = [...joined.matchAll(/([A-Z][A-Z0-9]{1,14})\s*[：:]\s*([\d.]+)/gi)];
    if (anyPrice.length) {
      if (!symbol) symbol = String(anyPrice[0][1]).toUpperCase();
      entry = anyPrice[0][2];
    }
  }

  const hasOpen = Boolean(symbol && direction && entry);

  // 仅止损补充（常约 2 分钟内另发）
  if (stopLoss && !hasOpen && !/现价开/.test(joined)) {
    return {
      parser: "junzhang",
      symbol: symbol || "",
      asset: symbol || "",
      direction: "",
      entry: "",
      stopLoss,
      takeProfits: [],
      targets: [],
      signalPhase: "tpsl",
      awaitingTpsl: false,
      title: symbol ? `${symbol} · 军长止损` : "军长止损",
    };
  }

  if (!hasOpen) return null;

  const isLong = direction === "做多";
  const takeProfits = [
    priceAtPctFromEntry(entry, 0.03, isLong),
    priceAtPctFromEntry(entry, 0.06, isLong),
    priceAtPctFromEntry(entry, 0.1, isLong),
  ].filter(Boolean);

  if (!takeProfits.length) return null;

  const hasSl = Boolean(stopLoss);
  return {
    parser: "junzhang",
    symbol,
    asset: symbol,
    direction,
    entry,
    stopLoss: stopLoss || "",
    takeProfits,
    targets: takeProfits,
    orderMode: "market",
    signalPhase: hasSl ? "full" : "open",
    awaitingTpsl: !hasSl,
    tpPartialRatios: [0.3, 0.3, 1],
    note: isLong
      ? "TP1 +3% 平30%；TP2 +6% 平30%；TP3 +10% 全平"
      : "TP1 -3% 平30%；TP2 -6% 平30%；TP3 -10% 全平",
    title: `${symbol} · 军长`,
  };
}

/**
 * @param {string} text
 * @param {import("./discord-signal-config.js").ParserKind} kind
 */
export function parseSignalText(text, kind) {
  const t = String(text ?? "").trim();
  if (!t) return null;

  if (kind === "junzhang" && /现价开|参考价格|止损\s*[\d.]/.test(t)) {
    const r = parseJunzhang(t);
    if (r) return r;
  }
  if (kind === "altcoin_king" && (isMarketOpenText(t) || /#[A-Z0-9]+/i.test(t))) {
    const r = parseAltcoinKing(t);
    if (r) return r;
  }
  if (kind === "tw_opg" && (isMarketOpenText(t) || looksLikeSignal(t, kind))) {
    const r = parseTwOpg(t);
    if (r) return r;
  }
  if (kind === "tw_opg" && (isSimpleTpslText(t) || /第[一二三四1234]止盈/.test(t))) {
    const r = parseTwOpg(t);
    if (r) return r;
  }
  if (kind === "altcoin_king" && isSimpleTpslText(t)) {
    return parseAltcoinKing(t);
  }

  if (!looksLikeSignal(t, kind)) return null;
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
    case "biquan_suozhang":
      return parseBiquanSuozhang(t);
    case "unknown_trader":
      return parseUnknownTrader(t);
    case "altcoin_king":
      return parseAltcoinKing(t);
    case "junzhang":
      return parseJunzhang(t);
    default:
      return (
        parseDabiaoke(t) ||
        parseBtcCn(t) ||
        parseStreakCn(t) ||
        parseFeiyang(t) ||
        parseFengge(t) ||
        parseYanchi(t) ||
        parseBiquanSuozhang(t) ||
        parseUnknownTrader(t) ||
        parseAltcoinKing(t) ||
        parseJunzhang(t) ||
        parseTwOpg(t) ||
        parseBinanceKillers(t)
      );
  }
}

/**
 * 简体极简 Telegram 卡片（与币圈所长推送风格一致）：
 * 📉 ETH 做空
 * 入场：1963
 * 止盈：1947, 1935, 1925
 * 止损：1985
 * 备注：…
 * @param {Record<string, unknown>} parsed
 */
function formatCnBriefTradeCard(parsed) {
  const symbol = String(parsed.symbol ?? parsed.asset ?? "").trim() || "—";
  const direction = String(parsed.direction ?? "").trim();
  const isShort = /空|short|sell/i.test(direction);
  const isLong = /多|long|buy/i.test(direction);
  const emoji = isShort ? "📉" : isLong ? "📈" : "📌";
  const entry = String(parsed.entry ?? "").trim()
    || (Array.isArray(parsed.entries) ? parsed.entries.join(" / ") : "");
  const tps = Array.isArray(parsed.takeProfits)
    ? parsed.takeProfits.map((x) => String(x).trim()).filter(Boolean)
    : Array.isArray(parsed.targets)
      ? parsed.targets.map((x) => String(x).trim()).filter(Boolean)
      : String(parsed.takeProfit ?? "")
          .split(/[,，\s·]+/)
          .map((x) => x.trim())
          .filter(Boolean);
  const stopLoss = String(parsed.stopLoss ?? "").trim();
  const note = String(parsed.note ?? "").trim();
  return [
    `${emoji} ${symbol}${direction ? ` ${direction}` : ""}`.trim(),
    entry ? `入场：${entry}` : "",
    tps.length ? `止盈：${tps.join(", ")}` : "",
    stopLoss ? `止损：${stopLoss}` : "",
    note ? `备注：${note}` : "",
  ]
    .filter(Boolean)
    .join("\n");
}

/** @param {Record<string, unknown>} parsed @param {string} styleId */
export function formatCardFallback(parsed, styleId) {
  const useTw = styleId === "tw_formal";
  const useEn = styleId === "en_brief";
  const L = (cn, tw, en) => (useEn ? en : useTw ? tw : cn);

  // 军长 / 币圈所长等同款简体极简（cn_brief / cn_formal）
  if (
    parsed.parser === "junzhang" ||
    ((parsed.parser === "biquan_suozhang" ||
      parsed.parser === "dabiaoke" ||
      parsed.parser === "feiyang" ||
      parsed.parser === "fengge" ||
      parsed.parser === "yanchi" ||
      parsed.parser === "unknown_trader" ||
      parsed.parser === "altcoin_king") &&
      !useTw &&
      !useEn)
  ) {
    return formatCnBriefTradeCard(parsed);
  }

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
