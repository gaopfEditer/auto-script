/**
 * 卡片时间维度评估：按 Discord 频道分组的胜率 / 损益。
 */
import { archiveCardToClient, resolveCardChannelName } from "./card-archive-service.js";
import { parseProgressJson } from "./card-level-progress.js";
import { parseArchiveRangeMs, resolveArchiveListSourceTypes } from "./card-archive-api.js";
import { isCardEnteredForEval, resolveCardEvalOutcome } from "./card-eval-outcome.js";
import { runEvalPendingSettleSweep } from "./card-eval-pending-settle.js";
import { createLogger } from "./logger.js";
import {
  ensureKolvipEvalRankFromSig,
  getKolvipEvalChannelIdAliases,
  getKolvipEvalRankedChannelIds,
  getKolvipEvalRankSource,
  getKolvipEvalTopChannelCount,
  isKolvipEvalSourceFilter,
  filterKolvipEvalCards,
  groupKolvipEvalCardsByShow,
} from "./kolvip-eval-channels.js";
import { getKolvipEvalRankedChannelName } from "./kolvip-eval-rank.js";
import {
  aggregateKolvipSigForChannelIds,
  aggregateKolvipSigRankedBoard,
  applyKolvipSigToEvalChannel,
  applyKolvipSigToEvalOverall,
  buildKolvipSigEvalOverlay,
  resolveKolvipSigRangeForEval,
} from "./kolvip-sig-eval-overlay.js";
import { loadKolvipSigBlogger } from "./kolvip-sig-store.js";
import { evalCardPathQualityIssue, isCorruptEvalCard } from "./card-eval-path-quality.js";

const evalSettleLog = createLogger("card-eval-settle");

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
    const ex = card.execution && typeof card.execution === "object" ? card.execution : null;
    const exo = String(ex?.outcome ?? "").trim();
    const outcome = exo === "cancelled" ? "cancelled" : "pending";
    return {
      entered: false,
      outcome,
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
export function aggregateMetrics(cards) {
  let winCount = 0;
  let lossCount = 0;
  let pendingCount = 0;
  let totalPnlPct = 0;
  let pnlN = 0;
  let tp1Hits = 0;
  let tp2Hits = 0;
  let tp3Hits = 0;
  let cardCount = 0;
  let excludedCorrupt = 0;

  for (const card of cards) {
    const c = classifyCardEval(card);
    if (!c.entered) continue;
    if (isCorruptEvalCard(card)) {
      excludedCorrupt += 1;
      continue;
    }
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
    excludedCorrupt,
    pathAggregateReliable: excludedCorrupt === 0,
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
export function groupByChannel(cards) {
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
 * @param {ReturnType<typeof archiveCardToClient>[]} cards
 */
export function buildEvalCardListItems(cards) {
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
      sourceType: card.sourceType,
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
      execution: card.execution ?? null,
      backtest: card.backtest ?? null,
    };
  });
  items.sort((a, b) => {
    const ta = a.signalAt ? Date.parse(String(a.signalAt)) : 0;
    const tb = b.signalAt ? Date.parse(String(b.signalAt)) : 0;
    if (tb !== ta) return tb - ta;
    return Number(b.id ?? 0) - Number(a.id ?? 0);
  });
  return items;
}

/** Telegram 群组评估窗口标注时区（滚动窗口以当前时刻为右界）。 */
export const TELEGRAM_GROUP_EVAL_TZ = "Asia/Shanghai";

/** 三窗口：近 30 天滚动 / 近 7 天滚动 / 全量历史（评估口径与 /eval 一致）。 */
export function resolveTelegramGroupEvalWindows() {
  const now = Date.now();
  const month = resolveEvalRangeMs("30d");
  const week = resolveEvalRangeMs("7d");
  const toMs = Math.max(now, month.toMs, week.toMs);
  return {
    month: {
      key: "month",
      label: "近一个月",
      fromMs: month.fromMs,
      toMs,
      timezone: TELEGRAM_GROUP_EVAL_TZ,
    },
    week: {
      key: "week",
      label: "七天",
      fromMs: week.fromMs,
      toMs,
      timezone: TELEGRAM_GROUP_EVAL_TZ,
    },
    all: {
      key: "all",
      label: "总计",
      fromMs: 0,
      toMs,
      timezone: TELEGRAM_GROUP_EVAL_TZ,
      allTime: true,
    },
  };
}

/**
 * @param {import("express").Express} app
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {{ requireOpenApiKey?: import("express").RequestHandler }} [deps]
 */
export function registerCardEvalRoutes(app, store, deps = {}) {
  const openAuth = deps.requireOpenApiKey;

  async function evalSummaryHandler(req, res) {
    try {
      await ensureKolvipEvalRankFromSig();
      const { fromMs, toMs } = parseArchiveRangeMs(req);
      const sourceTypes = resolveArchiveListSourceTypes(req);
      const symbol = String(req.query.symbol ?? req.query.coin ?? "").trim();
      const channelId = String(req.query.channel_id ?? req.query.channelId ?? "").trim();
      const kolvipScope = isKolvipEvalSourceFilter(sourceTypes);
      const rows = await store.listCardsForEval({
        fromMs,
        toMs,
        channelId: channelId || undefined,
        sourceTypes: kolvipScope ? undefined : sourceTypes.length ? sourceTypes : undefined,
        symbol: symbol || undefined,
        limit: kolvipScope ? 6000 : 2000,
      });
      let cards = rowsToCards(rows);
      if (kolvipScope) cards = filterKolvipEvalCards(cards);

      const byChannel = kolvipScope ? groupKolvipEvalCardsByShow(cards) : groupByChannel(cards);

      const sigOverlay = kolvipScope ? await buildKolvipSigEvalOverlay(fromMs, toMs) : null;

      const channels = [...byChannel.entries()]
        .map(([channelId, list]) => {
          const name =
            channelId === "_unknown"
              ? "未分组"
              : resolveCardChannelName(channelId, list[0]?.channelName);
          const row = {
            channelId: channelId === "_unknown" ? "" : channelId,
            channelName: name,
            ...aggregateMetrics(list),
          };
          return sigOverlay ? applyKolvipSigToEvalChannel(row, sigOverlay) : row;
        })
        .filter((ch) => (ch.cardCount || 0) > 0)
        .sort((a, b) => (b.cardCount || 0) - (a.cardCount || 0));

      const rankedIds = getKolvipEvalRankedChannelIds();
      const todayRange = resolveEvalRangeMs("1d");
      const todayRows = await store.listCardsForEval({
        fromMs: todayRange.fromMs,
        toMs: todayRange.toMs,
        sourceTypes: kolvipScope ? undefined : sourceTypes.length ? sourceTypes : undefined,
        symbol: symbol || undefined,
        limit: 4000,
      });
      let todayCards = rowsToCards(todayRows);
      if (kolvipScope) todayCards = filterKolvipEvalCards(todayCards);
      const todayBy = kolvipScope ? groupKolvipEvalCardsByShow(todayCards) : groupByChannel(todayCards);
      const dailyTopOverview = rankedIds.map((cid, idx) => {
        const list = todayBy.get(cid) || [];
        const channelName = resolveCardChannelName(cid, list[0]?.channelName);
        return {
          rank: idx + 1,
          channelId: cid,
          channelName,
          ...aggregateMetrics(list),
        };
      });

      const localOverall = aggregateMetrics(cards);
      const overall = sigOverlay
        ? applyKolvipSigToEvalOverall(localOverall, rankedIds, sigOverlay, {
            focusChannelId: channelId || undefined,
            topN: getKolvipEvalTopChannelCount(),
          })
        : localOverall;
      const evalNote = kolvipScope
        ? `${sigOverlay?.note ?? ""}。本地卡片仅在灰字 localPath 中保留（TP/SL 5m 路径），与网页 R 无关。`
        : "PnL 按 1/N 分批止盈累加（杠杆口径与回测一致）；胜率：任意 TP=赢，先 SL=输，未入场不计";

      /** @type {Record<string, unknown>[]} */
      const sigRankRows =
        kolvipScope && sigOverlay
          ? rankedIds.map((cid, idx) => {
              const list = byChannel.get(cid) || [];
              const rankName = getKolvipEvalRankedChannelName(cid);
              const base = {
                rank: idx + 1,
                channelId: cid,
                channelName: rankName || resolveCardChannelName(cid, list[0]?.channelName) || cid,
                ...aggregateMetrics(list),
              };
              const row = applyKolvipSigToEvalChannel(base, sigOverlay);
              if (!row.channelName || row.channelName === "未分组") {
                row.channelName = rankName || row.sig?.bloggerName || cid;
              }
              return row;
            })
          : [];

      res.json({
        ok: true,
        fromMs,
        toMs,
        filters: { sourceTypes, symbol, channelId },
        note: evalNote,
        overall,
        channels,
        kolvipEval: {
          label: "巨鲸信号频道",
          topN: getKolvipEvalTopChannelCount(),
          rankSource: getKolvipEvalRankSource(),
          rankedChannelIds: rankedIds,
          dailyTopOverview,
          todayFromMs: todayRange.fromMs,
          todayToMs: todayRange.toMs,
          sigRange: sigOverlay?.range ?? null,
          sigAvailable: Boolean(sigOverlay?.available),
          sigRankRows,
          kolvipWeb: sigOverlay
            ? {
                range: sigOverlay.range,
                rangeLabel: sigOverlay.rangeLabel,
                minCount: sigOverlay.minCount,
                openTotal: sigOverlay.openTotal,
                syncedNote: sigOverlay.note,
                topNAggregate: aggregateKolvipSigForChannelIds(rankedIds, sigOverlay),
                boardAggregate: aggregateKolvipSigRankedBoard(sigOverlay),
              }
            : null,
        },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  }

  async function evalChannelStripHandler(_req, res) {
    try {
      await ensureKolvipEvalRankFromSig();
      const today = resolveEvalRangeMs("1d");
      const lastWeek = resolveLastWeekMs();
      const [todayRows, weekRows] = await Promise.all([
        store.listCardsForEval({ fromMs: today.fromMs, toMs: today.toMs, limit: 2000 }),
        store.listCardsForEval({ fromMs: lastWeek.fromMs, toMs: lastWeek.toMs, limit: 2000 }),
      ]);
      let todayCards = filterKolvipEvalCards(rowsToCards(todayRows));
      let weekCards = filterKolvipEvalCards(rowsToCards(weekRows));
      const todayBy = groupKolvipEvalCardsByShow(todayCards);
      const weekBy = groupKolvipEvalCardsByShow(weekCards);
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
      const rankOrder = getKolvipEvalRankedChannelIds();
      const rankIndex = new Map(rankOrder.map((id, i) => [id, i]));
      const filtered = channels.filter((ch) => rankIndex.has(String(ch.channelId ?? "")));
      filtered.sort(
        (a, b) =>
          (rankIndex.get(String(a.channelId)) ?? 999) - (rankIndex.get(String(b.channelId)) ?? 999),
      );

      res.json({
        ok: true,
        today: { fromMs: today.fromMs, toMs: today.toMs },
        lastWeek: { fromMs: lastWeek.fromMs, toMs: lastWeek.toMs },
        channels: filtered,
        kolvipEvalTopN: getKolvipEvalTopChannelCount(),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  }

  async function evalChannelDetailHandler(req, res) {
    try {
      await ensureKolvipEvalRankFromSig();
      const { fromMs, toMs } = parseArchiveRangeMs(req);
      const sourceTypes = resolveArchiveListSourceTypes(req);
      const kolvipScope = isKolvipEvalSourceFilter(sourceTypes);
      const symbol = String(req.query.symbol ?? req.query.coin ?? "").trim();
      let channelId = String(req.params.channelId ?? "").trim();
      if (channelId === "none" || channelId === "_unknown") channelId = "";
      const filterChannelId = String(req.query.channel_id ?? req.query.channelId ?? "").trim();
      if (filterChannelId) channelId = filterChannelId;
      /** @type {Record<string, unknown>[]} */
      let rows = [];
      if (kolvipScope && channelId) {
        const aliases = getKolvipEvalChannelIdAliases(channelId);
        const seen = new Set();
        for (const aid of aliases) {
          const part = await store.listCardsForEval({
            fromMs,
            toMs,
            channelId: aid,
            symbol: symbol || undefined,
            limit: 1000,
          });
          for (const r of part) {
            const id = Number(r.id ?? r.ID);
            if (Number.isFinite(id) && seen.has(id)) continue;
            if (Number.isFinite(id)) seen.add(id);
            rows.push(r);
          }
        }
      } else {
        rows = await store.listCardsForEval({
          fromMs,
          toMs,
          channelId: channelId || undefined,
          sourceTypes: sourceTypes.length ? sourceTypes : undefined,
          symbol: symbol || undefined,
          limit: 1000,
        });
      }
      let cards = rowsToCards(rows);
      if (kolvipScope) cards = filterKolvipEvalCards(cards);
      if (!channelId) {
        cards = cards.filter((c) => !String(c.channelId ?? "").trim());
      }

      const items = buildEvalCardListItems(cards);

      /** @type {Record<string, unknown>|null} */
      let kolvipSig = null;
      if (kolvipScope && channelId) {
        const bloggerName =
          getKolvipEvalRankedChannelName(channelId) ||
          resolveCardChannelName(channelId, cards[0]?.channelName);
        const sigRange = resolveKolvipSigRangeForEval(fromMs, toMs);
        const snap = bloggerName ? await loadKolvipSigBlogger(bloggerName, sigRange) : null;
        if (snap && typeof snap === "object") {
          const stat = /** @type {Record<string, unknown>} */ (
            /** @type {{ stat?: unknown }} */ (snap).stat ?? {}
          );
          kolvipSig = {
            range: sigRange,
            bloggerName,
            metricsSource: "kolvip_web",
            stat,
            history: Array.isArray(snap.history) ? snap.history : [],
            open: Array.isArray(snap.open) ? snap.open : [],
          };
        }
      }

      res.json({
        ok: true,
        fromMs,
        toMs,
        filters: { sourceTypes, symbol, channelId },
        channelId,
        channelName: resolveCardChannelName(channelId, cards[0]?.channelName),
        metrics: aggregateMetrics(cards),
        cards: items,
        kolvipSig,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  }

  async function evalPendingSettleSweepHandler(req, res) {
    try {
      const force =
        String(req.query.force ?? req.body?.force ?? "1").toLowerCase() !== "0" &&
        String(req.query.force ?? req.body?.force ?? "1").toLowerCase() !== "false";
      const limit = Math.min(500, Number(req.query.limit ?? req.body?.limit) || 300);
      const summary = await runEvalPendingSettleSweep(store, evalSettleLog, { force, limit });
      res.json(summary);
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  }

  app.get("/api/cards/eval/summary", evalSummaryHandler);
  app.get("/api/cards/eval/channel-strip", evalChannelStripHandler);
  app.get("/api/cards/eval/channels/:channelId", evalChannelDetailHandler);
  app.post("/api/cards/eval/pending-settle-sweep", evalPendingSettleSweepHandler);

  if (openAuth) {
    app.get("/api/v1/cards/eval/summary", openAuth, evalSummaryHandler);
    app.get("/api/v1/cards/eval/channel-strip", openAuth, evalChannelStripHandler);
    app.get("/api/v1/cards/eval/channels/:channelId", openAuth, evalChannelDetailHandler);
    app.post("/api/v1/cards/eval/pending-settle-sweep", openAuth, evalPendingSettleSweepHandler);
  }
}
