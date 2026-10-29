/**
 * MAIN_CARD_TELEGRAM_CHAT_ID 群卡片推送 — 按上海自然日汇总胜率（与 /eval 口径一致）。
 *
 * 识别：`discord_signal_cards.telegram_sent_at` 落在窗口内（collect:ui 归档推送 TELEGRAM_PUSH_CHAT_ID 成功）。
 * 默认窗口：上一上海自然日（适合每日 12:00 推送前一日推送信号的结算情况）。
 */
import { config } from "./config.js";
import { archiveCardToClient } from "./card-archive-service.js";
import { aggregateMetrics } from "./card-eval-api.js";
import { telegramChatIdsMatch } from "./telegram-channel-profiles.js";

const TZ = "Asia/Shanghai";

/**
 * @param {number} dayOffset 相对「当前上海日期」的偏移（0=今天，-1=昨天）
 */
export function shanghaiCalendarDayBounds(dayOffset = 0) {
  const anchor = Date.now() + dayOffset * 86400000;
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: TZ }).format(new Date(anchor));
  const fromMs = Date.parse(`${ymd}T00:00:00+08:00`);
  const toMs = Date.parse(`${ymd}T23:59:59.999+08:00`);
  if (!Number.isFinite(fromMs) || !Number.isFinite(toMs)) {
    throw new Error(`invalid Shanghai day bounds for ${ymd}`);
  }
  return { ymd, fromMs, toMs, timezone: TZ };
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {{
 *   chatId?: string,
 *   dayOffset?: number,
 *   window?: 'yesterday' | 'today' | 'last_shanghai_day',
 *   limit?: number,
 * }} [opts]
 */
export async function buildMainCardTelegramDigest(store, opts = {}) {
  if (store?.offline) {
    return {
      ok: false,
      error: "MySQL 离线，无法统计卡片推送胜率",
      hint: "请启动 collect:ui 并配置 MYSQL_*",
    };
  }

  const chatId = String(
    opts.chatId ?? config.mainCardTelegramChatId ?? config.telegramPushChatId ?? ""
  ).trim();
  const pushChatId = String(config.telegramPushChatId ?? "").trim();

  let dayOffset = Number(opts.dayOffset);
  if (!Number.isFinite(dayOffset)) {
    const w = String(opts.window ?? "last_shanghai_day").trim().toLowerCase();
    if (w === "today") dayOffset = 0;
    else if (w === "yesterday" || w === "last_shanghai_day") dayOffset = -1;
    else dayOffset = -1;
  }

  const { ymd, fromMs, toMs, timezone } = shanghaiCalendarDayBounds(dayOffset);

  /** @type {string[]} */
  const warnings = [];
  if (!chatId) {
    warnings.push("未配置 MAIN_CARD_TELEGRAM_CHAT_ID / TELEGRAM_PUSH_CHAT_ID");
  }
  if (chatId && pushChatId && !telegramChatIdsMatch(chatId, pushChatId)) {
    warnings.push(
      `TELEGRAM_PUSH_CHAT_ID(${pushChatId}) 与 MAIN_CARD_TELEGRAM_CHAT_ID(${chatId}) 不一致；` +
        "统计仍按 telegram_sent_at（归档推送成功）计数，请确认推送群与主群一致"
    );
  }

  const rows = await store.listCardsForEval({
    telegramPushedFromMs: fromMs,
    telegramPushedToMs: toMs,
    limit: Math.min(2000, Number(opts.limit) || 2000),
  });

  /** @type {ReturnType<typeof archiveCardToClient>[]} */
  const cards = [];
  for (const row of rows) {
    try {
      cards.push(archiveCardToClient(/** @type {Record<string, unknown>} */ (row)));
    } catch {
      /* skip */
    }
  }

  const metrics = aggregateMetrics(cards);
  const pushedCount = cards.length;
  const decided = (metrics.winCount || 0) + (metrics.lossCount || 0);
  const notEntered = pushedCount - (metrics.cardCount || 0);

  const summaryZh = formatMainCardDigestZh({
    ymd,
    chatId: chatId || pushChatId || "—",
    pushedCount,
    metrics,
    decided,
    notEntered,
    timezone,
  });

  return {
    ok: true,
    chatId: chatId || pushChatId || null,
    telegramPushChatId: pushChatId || null,
    window: {
      timezone,
      day: ymd,
      dayOffset,
      fromMs,
      toMs,
      pushFilter: "telegram_sent_at",
      settleNote:
        "胜率仅统计已入场且 outcome 为 take_profit/stop_loss；与 GET /api/cards/eval/summary 一致（任意 TP=赢，先 SL=输）",
    },
    pushedCount,
    metrics,
    decidedCount: decided,
    notEnteredCount: Math.max(0, notEntered),
    pendingSettleCount: metrics.pendingCount ?? 0,
    summaryZh,
    warnings,
  };
}

/**
 * @param {{
 *   ymd: string,
 *   chatId: string,
 *   pushedCount: number,
 *   metrics: ReturnType<typeof aggregateMetrics>,
 *   decided: number,
 *   notEntered: number,
 *   timezone: string,
 * }} p
 */
export function formatMainCardDigestZh(p) {
  const { ymd, chatId, pushedCount, metrics, decided, notEntered, timezone } = p;
  const win = metrics.winCount ?? 0;
  const loss = metrics.lossCount ?? 0;
  const entered = metrics.cardCount ?? 0;
  const pending = metrics.pendingCount ?? 0;
  const wr =
    metrics.winRate != null && Number.isFinite(Number(metrics.winRate))
      ? `${Number(metrics.winRate).toFixed(2)}%`
      : "—";
  const avgPnl =
    metrics.avgPnlPct != null && Number.isFinite(Number(metrics.avgPnlPct))
      ? `${Number(metrics.avgPnlPct) >= 0 ? "+" : ""}${Number(metrics.avgPnlPct).toFixed(2)}%`
      : "—";

  const lines = [
    `【主群卡片胜率日报】${ymd}（${timezone}）`,
    `目标群：${chatId}`,
    `推送成功：${pushedCount} 张`,
    `已入场：${entered} 张 · 已结算：${decided}（胜 ${win} / 负 ${loss}）· 待结算：${pending}`,
    `胜率：${wr}（仅已结算）`,
  ];
  if (metrics.avgPnlPct != null && decided > 0) {
    lines.push(`平均仓位盈亏（已结算样本）：${avgPnl}`);
  }
  if (notEntered > 0) {
    lines.push(`未入场（不计胜率）：${notEntered} 张`);
  }
  lines.push("口径：推送时刻=telegram_sent_at；结算来自 progress/backtest/execution，与 /eval 相同");
  return lines.join("\n");
}

/**
 * @param {import("express").Express} app
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {{ requireOpenApiKey?: import("express").RequestHandler }} [deps]
 */
export function registerMainCardTelegramDigestRoutes(app, store, deps = {}) {
  const openAuth = deps.requireOpenApiKey;

  async function handler(req, res) {
    try {
      const q = req.query ?? {};
      const dayOffsetRaw = q.dayOffset ?? q.day_offset;
      const dayOffset =
        dayOffsetRaw != null && String(dayOffsetRaw).trim() !== ""
          ? Number(dayOffsetRaw)
          : undefined;
      const window = String(q.window ?? q.period ?? "").trim() || undefined;
      const chatId = String(q.chatId ?? q.chat_id ?? "").trim() || undefined;
      const result = await buildMainCardTelegramDigest(store, {
        chatId,
        dayOffset: Number.isFinite(dayOffset) ? dayOffset : undefined,
        window,
      });
      if (!result.ok) {
        res.status(503).json(result);
        return;
      }
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  }

  app.get("/api/cards/digest/main-telegram", handler);
  if (openAuth) {
    app.get("/api/v1/cards/digest/main-telegram", openAuth, handler);
  }
}
