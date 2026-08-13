/**
 * 卡片时间维度评估：按 Discord 频道分组的胜率 / 损益。
 */
import { archiveCardToClient, resolveCardChannelName } from "./card-archive-service.js";
import { parseProgressJson } from "./card-level-progress.js";

/**
 * @param {string} range
 * @param {string|undefined} fromRaw
 * @param {string|undefined} toRaw
 */
export function resolveEvalRangeMs(range, fromRaw, toRaw) {
  const now = Date.now();
  const r = String(range ?? "1d").toLowerCase();
  if (r === "custom") {
    const fromMs = fromRaw ? new Date(String(fromRaw)).getTime() : NaN;
    const toMs = toRaw ? new Date(String(toRaw)).getTime() : now;
    return {
      range: "custom",
      fromMs: Number.isFinite(fromMs) ? fromMs : now - 86400000,
      toMs: Number.isFinite(toMs) ? toMs : now,
    };
  }
  /** @type {Record<string, number>} */
  const map = {
    "1d": 1,
    "7d": 7,
    "14d": 14,
    "30d": 30,
    "90d": 90,
  };
  const days = map[r] ?? 1;
  const startOfDay = new Date();
  startOfDay.setHours(0, 0, 0, 0);
  if (r === "1d") {
    return { range: "1d", fromMs: startOfDay.getTime(), toMs: now };
  }
  return { range: r in map ? r : "1d", fromMs: now - days * 86400000, toMs: now };
}

/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 */
export function classifyCardEval(card) {
  const progress = parseProgressJson(card.progress);
  const backtest =
    card.backtest && typeof card.backtest === "object"
      ? /** @type {Record<string, unknown>} */ (card.backtest)
      : null;

  const entryHit = Boolean(progress?.entryHitAt);
  const tpHits = Array.isArray(progress?.tpHits) ? progress.tpHits : [];
  const status = String(progress?.status ?? "");
  const outcomeRaw = String(progress?.outcome ?? "");

  let outcome = "pending";
  if (tpHits.length > 0 || outcomeRaw === "take_profit") outcome = "take_profit";
  else if (status === "closed_sl" || outcomeRaw === "stop_loss") outcome = "stop_loss";
  else if (backtest?.outcome === "take_profit" || backtest?.outcome === "stop_loss") {
    // 未入进度机时回退窗口回测结果（须已入场语义：有 entry）
    if (backtest.entry != null || entryHit) {
      outcome = String(backtest.outcome);
    }
  }

  const entered =
    entryHit ||
    status === "entered" ||
    status === "partial_tp" ||
    status === "closed_tp" ||
    status === "closed_sl" ||
    outcome === "take_profit" ||
    outcome === "stop_loss";

  let pnlPct = null;
  if (progress && Number.isFinite(Number(progress.pnlPct))) {
    pnlPct = Number(progress.pnlPct);
  } else if (backtest && Number.isFinite(Number(backtest.pnl ?? backtest.pnlPct))) {
    pnlPct = Number(backtest.pnl ?? backtest.pnlPct);
  }

  return {
    entered,
    outcome,
    pnlPct,
    tpHits,
    progress,
  };
}

/**
 * @param {Array<ReturnType<typeof archiveCardToClient>>} cards
 */
function aggregateMetrics(cards) {
  let winCount = 0;
  let lossCount = 0;
  let pendingCount = 0;
  let totalPnlPct = 0;
  let pnlN = 0;
  let tp1Hits = 0;
  let tp2Hits = 0;
  let tp3Hits = 0;
  let cardCount = 0;

  for (const card of cards) {
    const c = classifyCardEval(card);
    if (!c.entered) continue;
    cardCount += 1;
    if (c.outcome === "take_profit") winCount += 1;
    else if (c.outcome === "stop_loss") lossCount += 1;
    else pendingCount += 1;

    if (c.pnlPct != null && (c.outcome === "take_profit" || c.outcome === "stop_loss" || (c.tpHits?.length ?? 0) > 0)) {
      totalPnlPct += c.pnlPct;
      pnlN += 1;
    }
    for (const h of c.tpHits ?? []) {
      const idx = Number(h.index);
      if (idx === 0) tp1Hits += 1;
      else if (idx === 1) tp2Hits += 1;
      else if (idx === 2) tp3Hits += 1;
    }
  }

  const decided = winCount + lossCount;
  return {
    cardCount,
    winCount,
    lossCount,
    pendingCount,
    winRate: decided > 0 ? Math.round((winCount / decided) * 10000) / 100 : null,
    totalPnlPct: Math.round(totalPnlPct * 100) / 100,
    avgPnlPct: pnlN > 0 ? Math.round((totalPnlPct / pnlN) * 100) / 100 : null,
    tp1Hits,
    tp2Hits,
    tp3Hits,
  };
}

/**
 * @param {import("express").Express} app
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 */
export function registerCardEvalRoutes(app, store) {
  app.get("/api/cards/eval/summary", async (req, res) => {
    try {
      const { range, fromMs, toMs } = resolveEvalRangeMs(
        String(req.query.range ?? "1d"),
        req.query.from != null ? String(req.query.from) : undefined,
        req.query.to != null ? String(req.query.to) : undefined
      );
      const rows = await store.listCardsForEval({ fromMs, toMs, limit: 2000 });
      const cards = rows.map((r) => archiveCardToClient(r));

      /** @type {Map<string, typeof cards>} */
      const byChannel = new Map();
      for (const card of cards) {
        const cid = String(card.channelId ?? "").trim() || "_unknown";
        if (!byChannel.has(cid)) byChannel.set(cid, []);
        byChannel.get(cid).push(card);
      }

      const channels = [...byChannel.entries()]
        .map(([channelId, list]) => {
          const name =
            channelId === "_unknown"
              ? "未分组"
              : resolveCardChannelName(channelId, list[0]?.channelName);
          return {
            channelId: channelId === "_unknown" ? "" : channelId,
            channelName: name,
            ...aggregateMetrics(list),
          };
        })
        .sort((a, b) => (b.cardCount || 0) - (a.cardCount || 0));

      res.json({
        ok: true,
        range,
        fromMs,
        toMs,
        note: "PnL 按 1/N 分批止盈累加（杠杆口径与回测一致）；胜率：任意 TP=赢，先 SL=输，未入场不计",
        overall: aggregateMetrics(cards),
        channels,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });

  app.get("/api/cards/eval/channels/:channelId", async (req, res) => {
    try {
      let channelId = String(req.params.channelId ?? "").trim();
      if (channelId === "none" || channelId === "_unknown") channelId = "";
      const { range, fromMs, toMs } = resolveEvalRangeMs(
        String(req.query.range ?? "1d"),
        req.query.from != null ? String(req.query.from) : undefined,
        req.query.to != null ? String(req.query.to) : undefined
      );
      const rows = await store.listCardsForEval({
        fromMs,
        toMs,
        channelId: channelId || undefined,
        limit: 1000,
      });
      let cards = rows.map((r) => archiveCardToClient(r));
      if (!channelId) {
        cards = cards.filter((c) => !String(c.channelId ?? "").trim());
      }

      const items = cards.map((card) => {
        const c = classifyCardEval(card);
        const ex = card.execution && typeof card.execution === "object" ? card.execution : null;
        const planned = ex?.planned && typeof ex.planned === "object" ? ex.planned : null;
        return {
          id: card.id,
          symbol: card.symbol,
          direction: ex?.direction ?? null,
          channelId: card.channelId,
          channelName: card.channelName,
          signalAt: card.signalAt,
          entry: planned?.entryPrice ?? null,
          takeProfits: planned?.takeProfitPrices ?? [],
          stopLoss: planned?.stopLossPrice ?? null,
          status: c.progress?.status ?? null,
          outcome: c.outcome,
          entered: c.entered,
          pnlPct: c.pnlPct,
          tpHits: c.tpHits,
          progress: c.progress,
        };
      });

      res.json({
        ok: true,
        range,
        fromMs,
        toMs,
        channelId,
        channelName: resolveCardChannelName(channelId, cards[0]?.channelName),
        metrics: aggregateMetrics(cards),
        cards: items,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });
}
