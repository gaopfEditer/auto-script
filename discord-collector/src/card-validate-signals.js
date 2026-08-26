/**
 * 外部回测请求 — 客户端传入的信号列表（不依赖 MySQL）。
 */
import { resolveTradeDirection } from "./card-direction.js";
import { detectSymbolTier } from "./card-backtest-policy.js";

/**
 * @typedef {{
 *   id: string,
 *   symbol: string,
 *   direction: "long" | "short",
 *   signalAt: string,
 *   entry: number | null,
 *   entryMode: "market" | "limit",
 *   tier: "major" | "altcoin",
 *   profitThresholdPct: number,
 * }} BacktestSignalInput
 */

/**
 * @param {unknown} row
 * @param {number} index
 * @returns {BacktestSignalInput | null}
 */
export function normalizeBacktestSignal(row, index) {
  if (!row || typeof row !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (row);
  const symbol = String(r.symbol ?? r.coin ?? "")
    .trim()
    .toUpperCase()
    .replace(/USDT$|USDC$|BUSD$/, "");
  if (!symbol) return null;

  const dir = resolveTradeDirection(r.direction ?? r.side ?? r.type) ?? "long";
  const signalAtRaw =
    r.signalAt ?? r.postTime ?? r.postedAt ?? r.time ?? r.createdAt ?? new Date().toISOString();
  const signalAt = String(signalAtRaw).trim() || new Date().toISOString();

  const entryRaw = r.entry ?? r.entryPrice ?? r.price;
  const entryNum = entryRaw != null && entryRaw !== "" ? Number(entryRaw) : NaN;
  const entry = Number.isFinite(entryNum) && entryNum > 0 ? entryNum : null;

  const modeRaw = String(r.entryMode ?? r.entryType ?? "").toLowerCase();
  const entryMode =
    modeRaw === "market" || modeRaw === "市价"
      ? "market"
      : entry != null
        ? "limit"
        : "market";

  const tier = detectSymbolTier(symbol);
  const profitThresholdPct = tier === "major" ? 2 : 5;

  return {
    id: String(r.id ?? r.signalId ?? `sig-${index + 1}`),
    symbol,
    direction: dir,
    signalAt,
    entry,
    entryMode,
    tier,
    profitThresholdPct,
  };
}

/**
 * @param {Record<string, unknown>} body
 * @returns {BacktestSignalInput[]}
 */
export function parseBacktestSignals(body) {
  const b = body && typeof body === "object" ? body : {};
  const raw = b.signals ?? b.items ?? b.coins ?? b.list ?? [];
  if (!Array.isArray(raw)) return [];
  /** @type {BacktestSignalInput[]} */
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const sig = normalizeBacktestSignal(raw[i], i);
    if (sig) out.push(sig);
  }
  return out.slice(0, 500);
}

/** 回测窗口（计划实现；当前 mock 也返回此字段）。 */
export const BACKTEST_WINDOW_DAYS = 3;
