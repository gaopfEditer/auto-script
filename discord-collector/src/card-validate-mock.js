/**
 * 卡片列表验证 — 模拟数据（不访问行情 / 数据库）。
 */

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
          takeProfitPrices: sym.direction === "long"
            ? [String(sym.entry * 1.03), String(sym.entry * 1.06)]
            : [String(sym.entry * 0.97), String(sym.entry * 0.94)],
          stopLossPrice: sym.direction === "long"
            ? String(sym.entry * 0.97)
            : String(sym.entry * 1.03),
        },
      },
      parsedJson: {},
      progress: inProgress ? { status: "entered", entryHitAt: signalAt } : { status: "closed_tp" },
    });
  }
  return cards;
}

/**
 * @param {Record<string, unknown>} card
 * @param {number} index
 */
export function buildMockValidateItem(card, index) {
  const sym = MOCK_SYMBOLS[index % MOCK_SYMBOLS.length];
  const signalAt = String(card.signalAt ?? card.createdAt ?? new Date().toISOString());
  const signalMs = new Date(signalAt).getTime();
  const inProgress =
    String(/** @type {Record<string, unknown>} */ (card.execution)?.outcome ?? "") === "pending";
  const isShort = sym.direction === "short";
  const entry = sym.entry;
  const leverage = sym.leverage;

  /** @type {Record<string, unknown>} */
  const base = {
    cardId: card.id,
    uid: card.uid,
    symbol: sym.symbol,
    channelId: card.channelId,
    channelName: card.channelName,
    sourceType: card.sourceType,
    signalAt,
    direction: sym.direction,
    entry,
    leverage,
    inProgress,
    entered: true,
    outcome: inProgress ? "pending" : index % 4 === 0 ? "take_profit" : "stop_loss",
    mock: true,
  };

  if (index === 5) {
    return { ...base, error: "missing_entry", entry: null };
  }

  if (inProgress) {
    const move = isShort ? -0.012 + index * 0.003 : 0.018 - index * 0.004;
    const currentPrice = isShort ? entry * (1 - move) : entry * (1 + move);
    const currentPnlPct = Math.round(move * leverage * 100 * 100) / 100;
    return {
      ...base,
      mode: "current",
      currentPrice: Math.round(currentPrice * 1e6) / 1e6,
      currentPnlPct,
      currentPnlLabel: `${currentPnlPct >= 0 ? "+" : ""}${currentPnlPct.toFixed(2)}% (@${leverage}x)`,
    };
  }

  const maxProfitPct = 28 + (index % 5) * 6.5;
  const maxDrawdownPct = 8 + (index % 4) * 3.2;
  const maxProfitAt = new Date(signalMs + (2 + index) * 3600_000).toISOString();
  const maxDrawdownAt = new Date(signalMs + (5 + index) * 3600_000).toISOString();
  const currentPnlPct = index % 4 === 0 ? maxProfitPct * 0.6 : -maxDrawdownPct * 0.4;

  return {
    ...base,
    mode: "full",
    signalMs,
    maxProfitPct: Math.round(maxProfitPct * 100) / 100,
    maxProfitAt,
    maxProfitPrice: isShort ? entry * 0.92 : entry * 1.08,
    maxDrawdownPct: Math.round(maxDrawdownPct * 100) / 100,
    maxDrawdownAt,
    currentPnlPct: Math.round(currentPnlPct * 100) / 100,
    currentPrice: isShort ? entry * 0.96 : entry * 1.04,
    klineCount: 48 + index * 12,
    windowEndAt: new Date().toISOString(),
  };
}

/** 静态样例（可直接 GET 预览，无需跑任务）。 */
export function buildMockValidateSample() {
  const cards = buildMockValidateCards(6);
  const items = cards.map((c, i) => buildMockValidateItem(c, i));
  return {
    ok: true,
    mock: true,
    note: "模拟数据，未访问行情与数据库",
    total: items.length,
    items,
    errors: items.filter((x) => x.error).map((x) => ({ cardId: x.cardId, error: String(x.error) })),
  };
}
