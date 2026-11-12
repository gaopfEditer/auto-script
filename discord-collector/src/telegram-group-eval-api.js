/**
 * Telegram 群组页：按 channel_profiles 展示三窗口总盈利率与单子明细（MySQL 评估口径）。
 */
import { archiveCardToClient, resolveCardChannelName } from "./card-archive-service.js";
import {
  aggregateMetrics,
  buildEvalCardListItems,
  resolveTelegramGroupEvalWindows,
} from "./card-eval-api.js";
import {
  normalizeTelegramChatIdKey,
  readTelegramChannelProfiles,
  telegramChatIdsMatch,
} from "./telegram-channel-profiles.js";

const EVAL_NOTE =
  "总盈利率为窗口内已入场且已决/分批止盈卡片的 pnlPct 累加（与 /eval 一致）；未入场不计入胜率与盈利率";

/** @type {ReadonlySet<string>} */
const WINDOW_KEYS = new Set(["month", "week", "all"]);

/**
 * @param {unknown} raw
 * @returns {ReturnType<typeof archiveCardToClient>[]}
 */
function rowsToCards(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {ReturnType<typeof archiveCardToClient>[]} */
  const cards = [];
  for (const r of raw) {
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
 * @param {string} chatId
 */
function filterCardsForChat(cards, chatId) {
  const id = normalizeTelegramChatIdKey(chatId);
  if (!id) return [];
  return cards.filter((c) => telegramChatIdsMatch(c.channelId, id));
}

/**
 * @param {string} windowKey
 */
function resolveWindowRange(windowKey) {
  const key = String(windowKey ?? "").trim();
  if (!WINDOW_KEYS.has(key)) return null;
  const windows = resolveTelegramGroupEvalWindows();
  return windows[/** @type {"month"|"week"|"all"} */ (key)] ?? null;
}

/**
 * @param {import("express").Express} app
 * @param {ReturnType<typeof import("./store.js").openStore>} cardStore
 */
export function registerTelegramGroupEvalRoutes(app, cardStore) {
  app.get("/api/telegram/live/group-eval", async (_req, res) => {
    try {
      if (!cardStore?.listCardsForEval) {
        res.json({
          ok: true,
          offline: true,
          note: EVAL_NOTE,
          windows: resolveTelegramGroupEvalWindows(),
          groups: [],
        });
        return;
      }

      const windows = resolveTelegramGroupEvalWindows();
      const profiles = readTelegramChannelProfiles();

      const [monthRows, weekRows, allRows] = await Promise.all([
        cardStore.listCardsForEval({
          fromMs: windows.month.fromMs,
          toMs: windows.month.toMs,
          sourceTypes: ["telegram"],
          limit: 2000,
        }),
        cardStore.listCardsForEval({
          fromMs: windows.week.fromMs,
          toMs: windows.week.toMs,
          sourceTypes: ["telegram"],
          limit: 2000,
        }),
        cardStore.listCardsForEval({
          toMs: windows.all.toMs,
          sourceTypes: ["telegram"],
          limit: 2000,
        }),
      ]);

      const monthCards = rowsToCards(monthRows);
      const weekCards = rowsToCards(weekRows);
      const allCards = rowsToCards(allRows);

      /** @param {ReturnType<typeof aggregateMetrics>} m */
      const packMetrics = (m) => ({
        cardCount: m.cardCount || 0,
        winCount: m.winCount || 0,
        lossCount: m.lossCount || 0,
        pendingCount: m.pendingCount || 0,
        winRate: m.winRate,
        totalPnlPct: m.totalPnlPct ?? 0,
        decidedCount: (m.winCount || 0) + (m.lossCount || 0),
      });

      const groups = profiles.channels.map((ch) => {
        const chatId = normalizeTelegramChatIdKey(ch.chatId);
        const monthM = aggregateMetrics(filterCardsForChat(monthCards, chatId));
        const weekM = aggregateMetrics(filterCardsForChat(weekCards, chatId));
        const allM = aggregateMetrics(filterCardsForChat(allCards, chatId));
        return {
          chatId,
          name: String(ch.name || chatId).trim() || chatId,
          month: packMetrics(monthM),
          week: packMetrics(weekM),
          all: packMetrics(allM),
        };
      });

      res.json({
        ok: true,
        note: EVAL_NOTE,
        windows,
        groups,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });

  app.get("/api/telegram/live/group-eval/:chatId/cards", async (req, res) => {
    try {
      const chatId = normalizeTelegramChatIdKey(req.params.chatId);
      if (!chatId) {
        res.status(400).json({ ok: false, error: "缺少 chatId" });
        return;
      }
      const windowKey = String(req.query.window ?? "week").trim();
      const win = resolveWindowRange(windowKey);
      if (!win) {
        res.status(400).json({ ok: false, error: "window 须为 month | week | all" });
        return;
      }

      if (!cardStore?.listCardsForEval) {
        res.json({
          ok: true,
          offline: true,
          chatId,
          window: win,
          metrics: aggregateMetrics([]),
          cards: [],
        });
        return;
      }

      const listOpts = {
        toMs: win.toMs,
        sourceTypes: ["telegram"],
        limit: 2000,
      };
      if (win.key !== "all" && Number(win.fromMs) > 0) {
        listOpts.fromMs = win.fromMs;
      }
      const rows = await cardStore.listCardsForEval(listOpts);
      const cards = filterCardsForChat(rowsToCards(rows), chatId);
      const profiles = readTelegramChannelProfiles();
      const prof = profiles.channels.find((c) => telegramChatIdsMatch(c.chatId, chatId));

      res.json({
        ok: true,
        note: EVAL_NOTE,
        chatId,
        name: prof?.name || resolveCardChannelName(chatId, cards[0]?.channelName),
        window: win,
        fromMs: win.fromMs,
        toMs: win.toMs,
        metrics: aggregateMetrics(cards),
        cards: buildEvalCardListItems(cards),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });
}
