/** 紧凑金额：热钱看板统一 M（百万美金），≥1B 用 B */
function fmtCompactCore(
  n: number,
  digits = 2,
  signed = false,
): string {
  const abs = Math.abs(n);
  const prefix = n < 0 ? "-" : signed && n > 0 ? "+" : "";

  if (abs >= 1e9) {
    return `${prefix}${(abs / 1e9).toFixed(digits)}B`;
  }
  return `${prefix}${(abs / 1e6).toFixed(digits)}M`;
}

/** 榜单量级：M / K / B */
export function fmtMk(n: number | null | undefined, signed = true, digits = 2): string {
  if (n == null || Number.isNaN(n)) return "—";
  const v = Number(n);
  if (v === 0) return "0";
  const abs = Math.abs(v);
  const prefix = v < 0 ? "-" : signed && v > 0 ? "+" : "";
  if (abs >= 1e9) return `${prefix}${(abs / 1e9).toFixed(digits)}B`;
  if (abs >= 1e6) return `${prefix}${(abs / 1e6).toFixed(digits)}M`;
  if (abs >= 1e3) return `${prefix}${(abs / 1e3).toFixed(digits)}K`;
  return `${prefix}${Math.round(abs)}`;
}

/** 金额 / OI / 成交额（无正号） */
export function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return "—";
  return fmtCompactCore(Number(n), digits, false);
}

/** 变动量（带 +/- 号） */
export function fmtDelta(n: number | null | undefined, digits = 2): string {
  if (n == null || Number.isNaN(n)) return "—";
  const v = Number(n);
  if (v === 0) return "0";
  return fmtCompactCore(v, digits, true);
}

export function fmtPct(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n)) return "—";
  const v = Number(n);
  const sign = v > 0 ? "+" : "";
  return `${sign}${v.toFixed(2)}%`;
}

/** pattern-chart-meta 价格有效数字位数（与头部价格展示一致） */
export const META_PRICE_SIGFIGS = 5;

/** 未知价时宁可多保留小数，避免低价 meme 被 minMove=0.01 量化成锯齿 */
export const CHART_PRICE_DECIMALS_FALLBACK = 8;
export const CHART_PRICE_DECIMALS_MAX = 10;

/** 与头部 meta 价格一致的展示 */
export function fmtMetaPrice(n: number | null | undefined): string {
  if (n == null || Number.isNaN(n) || !Number.isFinite(Number(n))) return "—";
  const v = Number(n);
  if (v === 0) return "0";
  const abs = Math.abs(v);
  // 低价币用足够小数，避免 toPrecision 科学计数难读；高价保留有效位
  if (abs >= 1000) return v.toFixed(2);
  if (abs >= 1) return Number(v.toPrecision(META_PRICE_SIGFIGS)).toString();
  const decimals = Math.min(
    CHART_PRICE_DECIMALS_MAX,
    Math.max(4, Math.ceil(-Math.log10(abs)) + META_PRICE_SIGFIGS - 1),
  );
  return v
    .toFixed(decimals)
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, "");
}

/**
 * 按价格量级推断 Y 轴小数位（供 lightweight-charts priceFormat）。
 * 例：87000→2；1.23→4；0.21→6；0.00021→9。
 * 未知价用 8，切勿默认 2（minMove=0.01 会毁掉山寨盘面）。
 */
export function priceDecimalsFromMetaPrice(n: number | null | undefined): number {
  if (n == null || !Number.isFinite(Number(n))) return CHART_PRICE_DECIMALS_FALLBACK;
  const abs = Math.abs(Number(n));
  if (!(abs > 0)) return CHART_PRICE_DECIMALS_FALLBACK;
  if (abs >= 1000) return 2;
  if (abs >= 100) return 2;
  if (abs >= 10) return 3;
  if (abs >= 1) return 4;
  // <1：保留「数量级 + 有效位」足够的小数，让相邻 K 线不被量化抹平
  const decimals = Math.ceil(-Math.log10(abs)) + 4;
  return Math.min(CHART_PRICE_DECIMALS_MAX, Math.max(5, decimals));
}

/** 结合近期高低，保证 minMove 小于典型波幅的一小部分 */
export function priceDecimalsFromCandles(
  prices: Array<number | null | undefined>,
): number {
  const vals = prices
    .map((x) => Number(x))
    .filter((x) => Number.isFinite(x) && x > 0);
  if (!vals.length) return CHART_PRICE_DECIMALS_FALLBACK;
  const last = vals[vals.length - 1]!;
  let decimals = priceDecimalsFromMetaPrice(last);
  if (vals.length >= 2) {
    const lo = Math.min(...vals);
    const hi = Math.max(...vals);
    const span = hi - lo;
    if (span > 0 && Number.isFinite(span)) {
      // 至少让 minMove ≲ span/200
      const need = Math.ceil(-Math.log10(span / 200));
      if (Number.isFinite(need)) {
        decimals = Math.max(decimals, Math.min(CHART_PRICE_DECIMALS_MAX, need));
      }
    }
  }
  return decimals;
}

function minMoveFromPrecision(precision: number): number {
  if (precision <= 0) return 1;
  return Number(`1e-${precision}`);
}

/** K 线价格轴 / 十字光标价格文本 */
export function formatChartAxisPrice(p: number, decimals: number): string {
  if (!Number.isFinite(p)) return "";
  if (decimals <= 0) return String(Math.round(p));
  // 去掉多余尾零，但仍保留足够有效位
  return p
    .toFixed(decimals)
    .replace(/(\.\d*?[1-9])0+$/, "$1")
    .replace(/\.0+$/, "");
}

export function chartPriceFormat(n: number | null | undefined): {
  type: "price";
  precision: number;
  minMove: number;
} {
  const precision = priceDecimalsFromMetaPrice(n);
  return { type: "price", precision, minMove: minMoveFromPrecision(precision) };
}

export function chartPriceFormatFromPrices(
  prices: Array<number | null | undefined>,
): {
  type: "price";
  precision: number;
  minMove: number;
} {
  const precision = priceDecimalsFromCandles(prices);
  return { type: "price", precision, minMove: minMoveFromPrecision(precision) };
}

/** MACD 等振荡指标：按数值量级单独设精度，避免沿用 0.01 把柱子锯齿化 */
export function chartOscillatorFormat(
  values: Array<number | null | undefined>,
): {
  type: "price";
  precision: number;
  minMove: number;
} {
  const vals = values
    .map((x) => Math.abs(Number(x)))
    .filter((x) => Number.isFinite(x) && x > 0);
  const peak = vals.length ? Math.max(...vals) : 0;
  const precision = priceDecimalsFromMetaPrice(peak || null);
  return { type: "price", precision, minMove: minMoveFromPrecision(precision) };
}

export function fmtTs(ts: number): string {
  if (!ts) return "—";
  return new Date(ts * 1000).toLocaleString("zh-CN", { hour12: false });
}

export function deltaClass(v: number): string {
  if (v > 0) return "pos";
  if (v < 0) return "neg";
  return "";
}

export function statusLabel(status: string): string {
  const map: Record<string, string> = {
    pump: "🔥 涌入",
    dump: "🩸 撤离",
    warming: "⏳ 预热",
    normal: "正常",
    suppressed: "🔇 抑制",
  };
  return map[status] ?? "正常";
}
