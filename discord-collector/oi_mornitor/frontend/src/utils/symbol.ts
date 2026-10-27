export function displaySymbol(symbol: string): string {
  return humanBaseAsset(symbol);
}

export function coinInitial(symbol: string): string {
  const base = displaySymbol(symbol);
  return base.slice(0, 1).toUpperCase() || "?";
}

const QUOTE_RE = /(?:USDT|USDC|BUSD|USD)$/i;
const MULTIPLIER_PREFIX_RE = /^(1000000|100000|10000|1000|1M)/i;

/** 去掉报价币：1000PEPEUSDT → 1000PEPE */
export function stripQuote(symbol: string): string {
  return String(symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(QUOTE_RE, "");
}

/**
 * 币安千倍/百万倍合约 → 人类常用名：1000PEPE → PEPE
 *（跨所查找、UI 展示用；币安 API 仍用原合约名）
 */
export function humanBaseAsset(symbol: string): string {
  let base = stripQuote(symbol);
  if (!base) return "";
  const m = base.match(MULTIPLIER_PREFIX_RE);
  if (m && base.length > m[1].length) {
    base = base.slice(m[1].length);
  }
  return base;
}

export function humanUsdtSymbol(symbol: string): string {
  const base = humanBaseAsset(symbol);
  return base ? `${base}USDT` : "";
}

export function toUsdtSymbol(symbol: string): string {
  const s = String(symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9]/g, "");
  if (!s) return "";
  if (/USDT$|USDC$|BUSD$/.test(s)) return s.replace(/USDC$|BUSD$/, "USDT");
  return `${s}USDT`;
}

const MULTIPLIER_PREFIXES = ["1000", "10000", "100000", "1000000", "1M"] as const;

/** 给人类名补千倍/百万倍合约候选：KORU → 1000KORUSDT 等 */
export function multiplierUsdtSymbols(symbol: string): string[] {
  const base = humanBaseAsset(symbol);
  if (!base) return [];
  // 已是千倍名则不再叠前缀
  if (MULTIPLIER_PREFIX_RE.test(stripQuote(symbol))) return [];
  return MULTIPLIER_PREFIXES.map((p) => `${p}${base}USDT`);
}

/** OKX/Bitget/Gate 优先人类名；币安/Bybit 优先原合约，并兜底试 1000× */
export function symbolLookupCandidates(
  symbol: string,
  venue: "binance" | "bybit" | "okx" | "bitget" | "gate" | string = "binance",
): string[] {
  const raw = toUsdtSymbol(symbol);
  const human = humanUsdtSymbol(raw);
  const multis = multiplierUsdtSymbols(raw);
  const preferHuman = venue === "okx" || venue === "bitget" || venue === "gate";
  // 币安：原名 → 人类名 → 1000/1M…（KORU 只有人类名时必须落到 1000KORUSDT）
  const ordered = preferHuman
    ? [human, raw, ...multis]
    : [raw, human, ...multis];
  const out: string[] = [];
  for (const s of ordered) {
    if (s && !out.includes(s)) out.push(s);
  }
  return out;
}

/** 合约乘数：1000PEPEUSDT → 1000；无前缀 → 1 */
export function contractMultiplier(symbol: string): number {
  const base = stripQuote(symbol);
  const m = base.match(MULTIPLIER_PREFIX_RE);
  if (!m) return 1;
  const raw = m[1].toUpperCase();
  return raw === "1M" ? 1_000_000 : Number(raw);
}

/**
 * 把 `price` 对齐到 `reference` 的量级（处理 1000SHIB 合约价 vs SHIB 人类价）。
 * 返回应乘到 price 上的系数；同量级则 1。
 */
export function priceScaleAlignFactor(price: number, reference: number): number {
  if (!(price > 0) || !(reference > 0)) return 1;
  const ratio = price / reference;
  // 已在同一量级（±50x 内的正常波动），不缩放
  if (ratio >= 0.02 && ratio <= 50) return 1;
  const multiples = [1_000_000, 100_000, 10_000, 1_000] as const;
  for (const m of multiples) {
    // price ≈ reference * m → 除以 m
    if (ratio >= m * 0.35 && ratio <= m * 2.8) return 1 / m;
    // price ≈ reference / m → 乘以 m
    if (ratio >= (1 / m) * 0.35 && ratio <= (1 / m) * 2.8) return m;
  }
  return 1;
}

/** 将价格对齐到参考价量级 */
export function alignPriceToReference(price: number, reference: number): number {
  return price * priceScaleAlignFactor(price, reference);
}


/** 稳定币本位：几乎无波动，不进形态扫描 / 胜率回溯 */
const STABLECOIN_BASES = new Set([
  "USDT",
  "USDC",
  "FDUSD",
  "TUSD",
  "USDE",
  "USDD",
  "DAI",
  "BUSD",
  "USD1",
  "USDP",
  "GUSD",
  "FRAX",
  "PYUSD",
  "EURC",
  "EURT",
  "USTC",
]);

export function isStablecoinSymbol(symbol: string): boolean {
  const raw = String(symbol ?? "")
    .trim()
    .toUpperCase()
    .replace(/[-_]/g, "");
  if (!raw) return false;
  if (STABLECOIN_BASES.has(raw)) return true;
  const base = humanBaseAsset(raw);
  return !!base && STABLECOIN_BASES.has(base.toUpperCase());
}
