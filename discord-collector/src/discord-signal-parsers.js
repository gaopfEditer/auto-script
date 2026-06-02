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
 * @param {string} text
 * @param {"binance_killers"|"btc_cn"|"eth_short"|"tw_opg"|"generic"} kind
 */
export function looksLikeSignal(text, kind) {
  const t = normalizeSignalText(text);
  if (t.length < 12) return false;
  switch (kind) {
    case "binance_killers":
      return /信号\s*ID|SIGNAL\s*ID|货币:|COIN:|方向:|Direction:|目标\s*\d|Target\s*\d/i.test(t);
    case "btc_cn":
      return /方向[：:].*(多|空)/.test(t) && /入场[：:]/.test(t);
    case "eth_short":
      return /ETH/i.test(t) && /(做多|做空|空|多)/.test(t) && /(止盈|止损|市价|保证金)/.test(t);
    case "tw_opg":
      return /(市價|市价).*(多|空)|槓桿|倉位|止盈|止損/i.test(t);
    default:
      return /(做多|做空|多|空|止盈|止损|芷損|目标|入场)/i.test(t);
  }
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
  const leverage =
    matchLine(joined, /\(([^)]*倍[^)]*)\)/) ||
    matchLine(joined, /\(([^)]*\bx\b[^)]*)\)/i) ||
    matchLine(joined, /(\d+[-~]\d+倍)/);
  const targets = [
    ...matchAll(joined, /目标\s*\d+[：:\s]*([\d.]+)/gi),
    ...matchAll(joined, /Target\s*\d+[：:\s]*([\d.]+)/gi),
  ];
  if (!direction || !targets.length) return null;
  return {
    parser: "binance_killers",
    signalId,
    symbol: symbol.replace(/^\$/, ""),
    direction,
    leverage,
    targets,
    title: "Binance Killers",
  };
}

/** @param {string} text */
export function parseBtcCn(text) {
  const blocks = String(text ?? "").split(/(?=比特币|BTC|#BTC)/i).map((b) => b.trim()).filter(Boolean);
  const block = blocks.find((b) => /方向[：:]/.test(b) && /入场[：:]/.test(b)) ?? text;
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
    asset,
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
export function parseEthShort(text) {
  const block = String(text ?? "").split(/(?=ETH)/i).find((b) => /ETH/i.test(b) && /(做多|做空)/.test(b)) ?? text;
  const joined = lines(block).join("\n");
  const direction = /做空|空/.test(joined) ? "做空" : /做多|多/.test(joined) ? "做多" : "";
  const streak = matchLine(joined, /（(\d+连胜)）/) || matchLine(joined, /\((\d+连胜)\)/);
  const entries = matchAll(joined, /(\d+(?:\.\d+)?)\s*市价[^\n]*/gi);
  const pending = matchAll(joined, /再挂(\d+(?:\.\d+)?)/gi);
  const takeProfits = matchAll(joined, /第[一二三四1234]止盈[：:\s]*([^\n]+)/gi);
  const stopLoss = matchLine(joined, /止损[：:\s]*([\d.]+)/i);
  const marginNotes = matchAll(joined, /(\d+%?\s*保证金)/gi);
  if (!direction || (!takeProfits.length && !stopLoss && !entries.length)) return null;
  return {
    parser: "eth_short",
    asset: "ETH",
    direction,
    streak,
    entries,
    pending,
    takeProfits,
    stopLoss,
    marginNotes,
    title: `ETH ${direction}${streak ? `（${streak}）` : ""}`,
  };
}

/** @param {string} text */
export function parseTwOpg(text) {
  const joined = lines(text).join("\n");
  const symbol = matchLine(joined, /#([A-Z0-9]+)/i) || "OPG";
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
    case "eth_short":
      return parseEthShort(t);
    case "tw_opg":
      return parseTwOpg(t);
    default:
      return parseBtcCn(t) || parseEthShort(t) || parseTwOpg(t) || parseBinanceKillers(t);
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
      parsed.leverage ? L(`杠杆：${parsed.leverage}`, `槓桿：${parsed.leverage}`, `Lev ${parsed.leverage}`) : "",
      targets ? L(`目标：${targets}`, `目標：${targets}`, `TP: ${targets}`) : "",
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

  if (parsed.parser === "eth_short") {
    const tps = /** @type {string[]} */ (parsed.takeProfits ?? []).join(" · ");
    return [
      parsed.title ?? "ETH",
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
