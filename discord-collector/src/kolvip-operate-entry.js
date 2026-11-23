/**
 * kolvip Show → python-ai-operate：仅四行正文 + 相对原信号更优的入场区间。
 */
import { preferSingleLanguageSignalText } from "./message-text-format.js";

const SHORT_RE = /空|short|sell|做空/i;
const LONG_RE = /多|long|buy|做多/i;

/**
 * @param {string} symbol
 */
export function classifyEntryAsset(symbol) {
  const s = String(symbol ?? "")
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (/^XAU|^GOLD/.test(s)) return "xau";
  if (/^BTC/.test(s)) return "btc";
  if (/^ETH/.test(s)) return "eth";
  return "alt";
}

/**
 * @param {string} raw
 * @returns {{ lo: number, hi: number } | null}
 */
export function parseEntryRange(raw) {
  const t = String(raw ?? "")
    .replace(/[,$￥¥]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!t) return null;
  const range = t.match(/(-?\d+(?:\.\d+)?)\s*(?:\$|usd)?\s*[-–—~至到]+\s*(-?\d+(?:\.\d+)?)/i);
  if (range) {
    const lo = Number(range[1]);
    const hi = Number(range[2]);
    if (Number.isFinite(lo) && Number.isFinite(hi)) {
      return { lo: Math.min(lo, hi), hi: Math.max(lo, hi) };
    }
  }
  const single = t.match(/(-?\d+(?:\.\d+)?)/);
  if (single) {
    const n = Number(single[1]);
    if (Number.isFinite(n)) return { lo: n, hi: n };
  }
  return null;
}

/**
 * @param {string} asset
 * @param {number} refPrice
 */
export function entryImproveDelta(asset, refPrice) {
  switch (asset) {
    case "xau":
      return 8;
    case "btc":
      return 250;
    case "eth":
      return 10;
    default: {
      const ref = Number(refPrice);
      if (!Number.isFinite(ref) || ref <= 0) return 0;
      return ref * 0.02;
    }
  }
}

/**
 * @param {{ lo: number, hi: number }} range
 * @param {string} direction
 * @param {string} symbol
 */
export function improveEntryRange(range, direction, symbol) {
  const asset = classifyEntryAsset(symbol);
  const mid = (range.lo + range.hi) / 2;
  const delta = entryImproveDelta(asset, mid);
  if (!delta) return { ...range };
  const short = SHORT_RE.test(String(direction ?? ""));
  const long = LONG_RE.test(String(direction ?? ""));
  if (short && !long) {
    return { lo: range.lo + delta, hi: range.hi + delta };
  }
  if (long && !short) {
    return { lo: range.lo - delta, hi: range.hi - delta };
  }
  return { ...range };
}

/**
 * @param {{ lo: number, hi: number }} range
 */
function formatEntryRange(range) {
  const fmt = (n) => {
    const x = Number(n);
    if (!Number.isFinite(x)) return String(n);
    if (Math.abs(x) >= 100) return String(Math.round(x));
    const s = x.toFixed(4).replace(/\.?0+$/, "");
    return s;
  };
  if (Math.abs(range.lo - range.hi) < 1e-9) return `${fmt(range.lo)}$`;
  return `${fmt(range.lo)}$ - ${fmt(range.hi)}$`;
}

/**
 * @param {string} line
 * @param {RegExp} re
 */
function pickField(line, re) {
  const m = String(line ?? "").match(re);
  return m ? String(m[1] ?? m[2] ?? "").trim() : "";
}

/**
 * @param {string} rawText
 */
export function parseSignalFieldsFromText(rawText) {
  const text = preferSingleLanguageSignalText(String(rawText ?? ""), "zh");
  const lines = text.split("\n");
  let symbol = "";
  let direction = "";
  let leverage = "";
  let entry = "";
  for (const line of lines) {
    const t = line.trim();
    if (!symbol) {
      symbol = pickField(
        t,
        /^币种\s*[:：]\s*#?([A-Za-z0-9/_-]+)|^coin\s*[:：#]\s*#?([A-Za-z0-9/_-]+)/i,
      );
    }
    if (!direction) {
      direction = pickField(t, /^方向\s*[:：]\s*(.+)|^direction\s*[:：]\s*(.+)/i);
    }
    if (!leverage) {
      leverage = pickField(
        t,
        /^杠杆\s*[:：]\s*(.+)|^leverage\s*[:：]\s*(.+)|^倍数\s*[:：]\s*(.+)/i,
      );
    }
    if (!entry) {
      entry = pickField(
        t,
        /^入场\s*[:：]\s*(.+)|^建仓\s*[:：]\s*(.+)|^entry\s*[:：]\s*(.+)/i,
      );
    }
  }
  if (!leverage) {
    const m = text.match(/(\d+)\s*倍/);
    if (m) leverage = `${m[1]}倍`;
  }
  return { symbol, direction, leverage, entry, text };
}

/**
 * @param {{
 *   symbol: string,
 *   direction: string,
 *   leverage?: string,
 *   entry: string,
 * }} fields
 */
export function formatKolvipOperateCdpNarrative(fields) {
  const sym = String(fields.symbol ?? "").trim();
  const coin = sym.startsWith("#") ? sym : sym ? `#${sym.replace(/^#/, "")}` : "";
  const dir = String(fields.direction ?? "").trim();
  const lev = String(fields.leverage ?? "").trim();
  const entry = String(fields.entry ?? "").trim();
  /** @type {string[]} */
  const lines = [];
  if (coin) lines.push(`币种：${coin}`);
  if (dir) lines.push(`方向：${dir}`);
  if (lev) lines.push(`杠杆：${lev}`);
  if (entry) lines.push(`入场：${entry}`);
  return lines.join("\n");
}

/**
 * @param {{
 *   symbol?: string,
 *   direction?: string,
 *   leverage?: string,
 *   entryRaw?: string,
 *   bodyText?: string,
 * }} input
 */
export function buildKolvipOperateEntryNarrative(input) {
  const fromText = input.bodyText ? parseSignalFieldsFromText(input.bodyText) : null;
  const symbol = String(input.symbol ?? fromText?.symbol ?? "").trim();
  const direction = String(input.direction ?? fromText?.direction ?? "").trim();
  const leverage = String(input.leverage ?? fromText?.leverage ?? "").trim();
  const entryRaw = String(input.entryRaw ?? fromText?.entry ?? "").trim();
  const range = parseEntryRange(entryRaw);
  if (!range) {
    return formatKolvipOperateCdpNarrative({ symbol, direction, leverage, entry: entryRaw });
  }
  const improved = improveEntryRange(range, direction, symbol);
  return formatKolvipOperateCdpNarrative({
    symbol,
    direction,
    leverage,
    entry: formatEntryRange(improved),
  });
}