/**
 * 外部回测请求 — 客户端传入的信号列表（不依赖 MySQL）。
 */
import { resolveTradeDirection } from "./card-direction.js";
import { detectSymbolTier } from "./card-backtest-policy.js";
import {
  getTelegramOiRollingSpec,
  resolveBacktestPolicy,
} from "./card-telegram-oi-backtest.js";

/**
 * @typedef {'telegram_oi' | 'window_days'} BacktestPolicyId
 */

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
 *   backtestPolicy: BacktestPolicyId,
 *   source?: string,
 *   interval?: string,
 *   signalKind?: string,
 *   typeLabel?: string,
 *   rollingOverrides?: Record<string, unknown>,
 * }} BacktestSignalInput
 */

/**
 * @param {Record<string, unknown>} body
 * @param {Record<string, unknown>} row
 */
function pickRollingOverrides(body, row) {
  const fromRow =
    row.rolling && typeof row.rolling === "object"
      ? /** @type {Record<string, unknown>} */ (row.rolling)
      : {};
  const fromBody =
    body.rolling && typeof body.rolling === "object"
      ? /** @type {Record<string, unknown>} */ (body.rolling)
      : {};
  return { ...fromBody, ...fromRow };
}

/**
 * @param {unknown} row
 * @param {number} index
 * @param {Record<string, unknown>} [body]
 * @returns {BacktestSignalInput | null}
 */
export function normalizeBacktestSignal(row, index, body = {}) {
  if (!row || typeof row !== "object") return null;
  const r = /** @type {Record<string, unknown>} */ (row);
  const symbol = String(r.symbol ?? r.coin ?? "")
    .trim()
    .toUpperCase()
    .replace(/USDT$|USDC$|BUSD$/, "");
  if (!symbol) return null;

  const dir = resolveTradeDirection(r.direction ?? r.side ?? r.type) ?? "long";
  const signalAtRaw =
    r.signalAt ?? r.postTime ?? r.postedAt ?? r.time ?? r.kline_open_time ?? r.createdAt ?? new Date().toISOString();
  let signalAt = String(signalAtRaw).trim() || new Date().toISOString();
  if (/^\d+$/.test(signalAt)) {
    const n = Number(signalAt);
    const ms = n > 10_000_000_000 ? n : n * 1000;
    signalAt = new Date(ms).toISOString();
  }

  const entryRaw = r.entry ?? r.entryPrice ?? r.price ?? r.close;
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
  const backtestPolicy = resolveBacktestPolicy(r, body);
  const rollingOverrides = pickRollingOverrides(body, r);
  let profitThresholdPct;
  if (backtestPolicy === "telegram_oi") {
    profitThresholdPct = getTelegramOiRollingSpec(tier, rollingOverrides).stepPct;
  } else {
    profitThresholdPct =
      Number(r.profitThresholdPct) > 0
        ? Number(r.profitThresholdPct)
        : tier === "major"
          ? 2
          : 5;
  }

  return {
    id: String(r.id ?? r.signalId ?? `sig-${index + 1}`),
    symbol,
    direction: dir,
    signalAt,
    entry,
    entryMode,
    tier,
    profitThresholdPct,
    backtestPolicy,
    source: r.source != null ? String(r.source) : undefined,
    interval: r.interval != null ? String(r.interval) : undefined,
    signalKind: r.signalKind ?? r.kind != null ? String(r.signalKind ?? r.kind) : undefined,
    typeLabel:
      r.typeLabel ?? r.type_label ?? r.pattern_label != null
        ? String(r.typeLabel ?? r.type_label ?? r.pattern_label)
        : undefined,
    rollingOverrides: Object.keys(rollingOverrides).length ? rollingOverrides : undefined,
  };
}

/**
 * @param {Record<string, unknown>} body
 * @returns {BacktestSignalInput[]}
 */
export function parseBacktestSignals(body) {
  const b = body && typeof body === "object" ? body : {};
  const raw = b.signals ?? b.items ?? b.coins ?? b.list ?? b.alerts ?? [];
  if (!Array.isArray(raw)) return [];
  /** @type {BacktestSignalInput[]} */
  const out = [];
  for (let i = 0; i < raw.length; i++) {
    const sig = normalizeBacktestSignal(raw[i], i, b);
    if (sig) out.push(sig);
  }
  return out.slice(0, 500);
}

/** 通用窗口回测默认天数（backtestPolicy=window_days）。 */
export const BACKTEST_WINDOW_DAYS = 3;
