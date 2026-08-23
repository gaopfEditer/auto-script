/**
 * 卡片时间维度评估：按 Discord 频道分组的胜率 / 损益。
 */
import { archiveCardToClient, resolveCardChannelName } from "./card-archive-service.js";
import { parseProgressJson } from "./card-level-progress.js";
import { parseArchiveRangeMs } from "./card-archive-api.js";
import { isCardEnteredForEval, resolveCardEvalOutcome } from "./card-eval-outcome.js";

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

  if (status === "not_entered") {
    return {
      entered: false,
      outcome: "pending",
      pnlPct: 0,
      tpHits: [],
      progress,
    };
  }

  const outcome = resolveCardEvalOutcome(card);
  const entered = isCardEnteredForEval(card);

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
 * @param {ReturnType<typeof archiveCardToClient>} card
 */
export function cardHasTpStrategy(card) {
  const ex = card.execution && typeof card.execution === "object" ? card.execution : null;
  const planned = ex?.planned && typeof ex.planned === "object" ? ex.planned : null;
  const tps = planned?.takeProfitPrices;
  if (Array.isArray(tps) && tps.some((p) => String(p ?? "").trim())) return true;
  const parsed = card.parsedJson && typeof card.parsedJson === "object" ? card.parsedJson : null;
  const fromParsed = parsed?.takeProfits ?? parsed?.targets ?? parsed?.takeProfit;
  if (Array.isArray(fromParsed) && fromParsed.some((p) => String(p ?? "").trim())) return true;
  if (typeof fromParsed === "string" && fromParsed.trim()) return true;
  return false;
}

/**
 * 上一自然周（周一 00:00 → 本周一 00:00，本地时区）。
 * @returns {{ fromMs: number, toMs: number }}
 */
export function resolveLastWeekMs() {
  const startOfToday = new Date();
  startOfToday.setHours(0, 0, 0, 0);
  const day = startOfToday.getDay(); // 0=Sun
  const daysSinceMonday = day === 0 ? 6 : day - 1;
  const thisMonday = new Date(startOfToday);
  thisMonday.setDate(thisMonday.getDate() - daysSinceMonday);
  const lastMonday = new Date(thisMonday);
  lastMonday.setDate(lastMonday.getDate() - 7);
  return { fromMs: lastMonday.getTime(), toMs: thisMonday.getTime() };
}

/**
 * @param {Array<ReturnType<typeof archiveCardToClient>} cards
 */
function aggregateTpStrategyMetrics(cards) {
  const withTp = cards.filter(cardHasTpStrategy);
  return {
    ...aggregateMetrics(withTp),
    hasTpStrategy: withTp.length > 0,
    strategyCardCount: withTp.length,
  };
}

/**
 * @param {unknown[]} rows
 */
function rowsToCards(rows) {
  /** @type {ReturnType<typeof archiveCardToClient>[]} */
  const cards = [];
  for (const r of rows) {
    try {
      cards.push(archiveCardToClient(/** @type {Record<string, unknown>} */ (r)));
    } catch {
      /* ignore */
    }
  }
  return cards;
}

/**
 * @param {ReturnType<typeof archiveCardToClient>[]} cards
 */
function groupByChannel(cards) {
  /** @type {Map<string, typeof cards>} */
  const byChannel = new Map();
  for (const card of cards) {
    const cid = String(card.channelId ?? "").trim() || "_unknown";
    if (!byChannel.has(cid)) byChannel.set(cid, []);
    byChannel.get(cid)?.push(card);
  }
  return byChannel;
}

/**
 * @param {import("express").Express} app
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 */
export function registerCardEvalRoutes(app, store) {
  app.get("/api/cards/eval/summary", async (req, res) => {
    try {
      const { fromMs, toMs } = parseArchiveRangeMs(req);
      const sourceType = String(req.query.source ?? req.query.source_type ?? req.query.sourceType ?? "").trim();
      const symbol = String(req.query.symbol ?? req.query.coin ?? "").trim();
      const channelId = String(req.query.channel_id ?? req.query.channelId ?? "").trim();
      const rows = await store.listCardsForEval({
        fromMs,
        toMs,
        channelId: channelId || undefined,
        sourceType: sourceType || undefined,
        symbol: symbol || undefined,
        limit: 2000,
      });
      const cards = rowsToCards(rows);

      const byChannel = groupByChannel(cards);

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
        .filter((ch) => (ch.cardCount || 0) > 0)
        .sort((a, b) => (b.cardCount || 0) - (a.cardCount || 0));

      res.json({
        ok: true,
        fromMs,
        toMs,
        filters: { sourceType, symbol, channelId },
        note: "PnL 按 1/N 分批止盈累加（杠杆口径与回测一致）；胜率：任意 TP=赢，先 SL=输，未入场不计",
        overall: aggregateMetrics(cards),
        channels,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });

  /**
   * Show 频道列表条：当日止盈/止损笔数 + 上周胜率（仅统计策略含止盈的卡片）。
   */
  app.get("/api/cards/eval/channel-strip", async (_req, res) => {
    try {
      const today = resolveEvalRangeMs("1d");
      const lastWeek = resolveLastWeekMs();
      const [todayRows, weekRows] = await Promise.all([
        store.listCardsForEval({ fromMs: today.fromMs, toMs: today.toMs, limit: 2000 }),
        store.listCardsForEval({ fromMs: lastWeek.fromMs, toMs: lastWeek.toMs, limit: 2000 }),
      ]);
      const todayBy = groupByChannel(rowsToCards(todayRows));
      const weekBy = groupByChannel(rowsToCards(weekRows));
      const channelIds = new Set([...todayBy.keys(), ...weekBy.keys()]);

      /** @type {Array<Record<string, unknown>>} */
      const channels = [];
      for (const channelId of channelIds) {
        if (channelId === "_unknown") continue;
        const todayList = todayBy.get(channelId) || [];
        const weekList = weekBy.get(channelId) || [];
        const todayM = aggregateTpStrategyMetrics(todayList);
        const weekM = aggregateTpStrategyMetrics(weekList);
        if (!todayM.hasTpStrategy && !weekM.hasTpStrategy) continue;
        const decided = (weekM.winCount || 0) + (weekM.lossCount || 0);
        channels.push({
          channelId,
          channelName: resolveCardChannelName(
            channelId,
            todayList[0]?.channelName ?? weekList[0]?.channelName
          ),
          hasTpStrategy: true,
          today: {
            tpCount: todayM.winCount || 0,
            slCount: todayM.lossCount || 0,
            pendingCount: todayM.pendingCount || 0,
            enteredCount: todayM.cardCount || 0,
          },
          lastWeek:
            decided > 0
              ? {
                  winRate: weekM.winRate,
                  winCount: weekM.winCount || 0,
                  lossCount: weekM.lossCount || 0,
                  decided,
                }
              : null,
        });
      }
      channels.sort((a, b) => String(a.channelName).localeCompare(String(b.channelName), "zh"));

      res.json({
        ok: true,
        today: { fromMs: today.fromMs, toMs: today.toMs },
        lastWeek: { fromMs: lastWeek.fromMs, toMs: lastWeek.toMs },
        channels,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });

  app.get("/api/cards/eval/channels/:channelId", async (req, res) => {
    try {
      const { fromMs, toMs } = parseArchiveRangeMs(req);
      const sourceType = String(req.query.source ?? req.query.source_type ?? req.query.sourceType ?? "").trim();
      const symbol = String(req.query.symbol ?? req.query.coin ?? "").trim();
      let channelId = String(req.params.channelId ?? "").trim();
      if (channelId === "none" || channelId === "_unknown") channelId = "";
      const filterChannelId = String(req.query.channel_id ?? req.query.channelId ?? "").trim();
      if (filterChannelId) channelId = filterChannelId;
      const rows = await store.listCardsForEval({
        fromMs,
        toMs,
        channelId: channelId || undefined,
        sourceType: sourceType || undefined,
        symbol: symbol || undefined,
        limit: 1000,
      });
      let cards = rowsToCards(rows);
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
        fromMs,
        toMs,
        filters: { sourceType, symbol, channelId },
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
