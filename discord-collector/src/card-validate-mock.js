/**
 * 卡片回测 — 模拟数据（不访问行情 / 数据库）。
 * 当前 validate 接口默认走此路径；真实 K 线回测尚未启用。
 */
import { detectSymbolTier, getBacktestSpec } from "./card-backtest-policy.js";

const MOCK_CHANNELS = [
  { channelId: "mock-ch-001", channelName: "军长频道" },
  { channelId: "mock-ch-002", channelName: "币圈老韭菜" },
  { channelId: "mock-ch-003", channelName: "合约狙击手" },
];

const MOCK_SYMBOLS = [
  { symbol: "BTC", entry: 95000, leverage: 100, direction: "long" },
  { symbol: "ETH", entry: 3200, leverage: 100, direction: "short" },
  { symbol: "SOL", entry: 145, leverage: 100, direction: "long" },
  { symbol: "DOGE", entry: 0.18, leverage: 20, direction: "long" },
  { symbol: "PEPE", entry: 0.000012, leverage: 20, direction: "short" },
  { symbol: "ARB", entry: 0.85, leverage: 20, direction: "long" },
  { symbol: "WIF", entry: 2.4, leverage: 20, direction: "long" },
  { symbol: "SUI", entry: 3.2, leverage: 20, direction: "short" },
];

/**
 * @param {import("./card-validate-signals.js").BacktestSignalInput} sig
 * @param {number} index
 */
export function backtestSignalToMockCard(sig, index) {
  const tier = detectSymbolTier(sig.symbol);
  const spec = getBacktestSpec(tier);
  const ch = MOCK_CHANNELS[index % MOCK_CHANNELS.length];
  const entry =
    sig.entry ??
    (tier === "major"
      ? sig.symbol === "ETH"
        ? 3200
        : 95000
      : 1 + index * 0.37);
  return {
    id: 91001 + index,
    uid: `SC-BT-${91001 + index}`,
    symbol: sig.symbol,
    channelId: ch.channelId,
    channelName: ch.channelName,
    sourceType: "api",
    signalAt: sig.signalAt,
    createdAt: sig.signalAt,
    assetClass: "crypto",
    backtestInput: {
      signalId: sig.id,
      direction: sig.direction,
      entryMode: sig.entryMode,
      entry: sig.entry,
      tier: sig.tier,
      profitThresholdPct: sig.profitThresholdPct,
    },
    execution: {
      symbol: sig.symbol,
      direction: sig.direction === "short" ? "做空" : "做多",
      outcome: "pending",
      planned: {
        entryPrice: String(entry),
        takeProfitPrices: [],
        stopLossPrice: "",
      },
    },
    parsedJson: {},
    progress: { status: "entered", entryHitAt: sig.signalAt },
    _mockLeverage: spec.leverage,
    _mockDirection: sig.direction,
    _mockEntry: entry,
  };
}

/**
 * @param {import("./card-validate-signals.js").BacktestSignalInput[]} signals
 */
export function buildMockValidateCardsFromSignals(signals) {
  return signals.map((sig, i) => backtestSignalToMockCard(sig, i));
}

/**
 * @param {number} [count]
 */
export function buildMockValidateCards(count = 8) {
  const n = Math.min(20, Math.max(1, Number(count) || 8));
  /** @type {Array<Record<string, unknown>>} */
  const cards = [];
  for (let i = 0; i < n; i++) {
    const sym = MOCK_SYMBOLS[i % MOCK_SYMBOLS.length];
    const ch = MOCK_CHANNELS[i % MOCK_CHANNELS.length];
    const hoursAgo = 6 + i * 3;
    const signalAt = new Date(Date.now() - hoursAgo * 3600_000).toISOString();
    const inProgress = i % 4 === 2 || i % 4 === 3;
    cards.push({
      id: 90001 + i,
      uid: `SC-MOCK-${90001 + i}`,
      symbol: sym.symbol,
      channelId: ch.channelId,
      channelName: ch.channelName,
      sourceType: i % 2 === 0 ? "discord" : "telegram",
      signalAt,
      createdAt: signalAt,
      assetClass: "crypto",
      execution: {
        symbol: sym.symbol,
        direction: sym.direction === "short" ? "做空" : "做多",
        outcome: inProgress ? "pending" : i % 4 === 0 ? "take_profit" : "stop_loss",
        planned: {
          entryPrice: String(sym.entry),
          takeProfitPrices:
            sym.direction === "long"
              ? [String(sym.entry * 1.03), String(sym.entry * 1.06)]
              : [String(sym.entry * 0.97), String(sym.entry * 0.94)],
          stopLossPrice:
            sym.direction === "long" ? String(sym.entry * 0.97) : String(sym.entry * 1.03),
        },
      },
      parsedJson: {},
      progress: inProgress ? { status: "entered", entryHitAt: signalAt } : { status: "closed_tp" },
      _mockLeverage: sym.leverage,
      _mockDirection: sym.direction,
      _mockEntry: sym.entry,
    });
  }
  return cards;
}

/**
 * @param {Record<string, unknown>} card
 * @param {number} index
 */
export function buildMockValidateItem(card, index) {
  const input =
    card.backtestInput && typeof card.backtestInput === "object"
      ? /** @type {Record<string, unknown>} */ (card.backtestInput)
      : {};
  const symMeta = MOCK_SYMBOLS[index % MOCK_SYMBOLS.length];
  const symbol = String(card.symbol ?? symMeta.symbol);
  const tier = detectSymbolTier(symbol);
  const spec = getBacktestSpec(tier);
  const leverage = Number(card._mockLeverage) || spec.leverage;
  const direction = String(card._mockDirection ?? input.direction ?? symMeta.direction);
  const isShort = direction === "short";
  const signalAt = String(card.signalAt ?? card.createdAt ?? new Date().toISOString());
  const signalMs = new Date(signalAt).getTime();
  const entry = Number(card._mockEntry ?? input.entry ?? symMeta.entry);
  const profitThresholdPct = tier === "major" ? 2 : 5;
  const entryMode = String(input.entryMode ?? (input.entry != null ? "limit" : "market"));

  const maxProfitPct = Math.round((18 + (index % 6) * 7.2) * 100) / 100;
  const minProfitPct = Math.round(-(6 + (index % 5) * 2.8) * 100) / 100;
  const maxProfitAt = new Date(signalMs + (4 + index) * 3600_000).toISOString();
  const minProfitAt = new Date(signalMs + (8 + index) * 3600_000).toISOString();
  const hitProfitThresholdBeforeMax = index % 3 !== 2;
  const hitProfitThresholdBeforeMin = index % 4 === 0;
  const windowEndAt = new Date(signalMs + 3 * 86400_000).toISOString();

  /** @type {Record<string, unknown>} */
  const base = {
    signalId: input.signalId ?? card.uid ?? card.id,
    cardId: card.id,
    uid: card.uid,
    symbol,
    channelId: card.channelId,
    channelName: card.channelName,
    sourceType: card.sourceType,
    signalAt,
    direction,
    entry,
    entryMode,
    leverage,
    tier,
    windowDays: 3,
    profitThresholdPct,
    mock: true,
    note: "模拟回测结果；真实 K 线回测尚未启用",
  };

  if (index === 5 && !input.signalId) {
    return { ...base, error: "missing_entry", entry: null };
  }

  return {
    ...base,
    mode: "backtest_window",
    maxProfitPct,
    maxProfitAt,
    maxProfitPrice: isShort ? entry * 0.9 : entry * 1.12,
    minProfitPct,
    minProfitAt,
    minProfitPrice: isShort ? entry * 1.06 : entry * 0.94,
    hitProfitThresholdBeforeMax,
    hitProfitThresholdBeforeMin,
    currentPnlPct: Math.round((maxProfitPct + minProfitPct) / 2 * 100) / 100,
    klineCount: 36 + index * 8,
    windowEndAt,
  };
}

/** 静态样例（可直接 GET 预览，无需跑任务）。 */
export function buildMockValidateSample() {
  const cards = buildMockValidateCards(6);
  const items = cards.map((c, i) => buildMockValidateItem(c, i));
  return {
    ok: true,
    mock: true,
    note: "模拟数据，未访问行情与数据库；真实回测尚未启用",
    windowDays: 3,
    total: items.length,
    items,
    errors: items.filter((x) => x.error).map((x) => ({ cardId: x.cardId, error: String(x.error) })),
  };
}
