/**
 * Local：当日自动跟单（Bitget / WEEX）盈亏一览，供发盈利图。
 */
import { archiveCardToClient } from "./card-archive-service.js";
import { shanghaiCalendarDayStartMs } from "./card-archive-mysql-time.js";
import { parseProgressJson, isProgressTerminal } from "./card-level-progress.js";
import { requireLocalRequest } from "./local-request.js";
import { config } from "./config.js";
import { resolveCardSourcePostUrl } from "./card-source-post-url.js";
import {
  formatTodayPnlPublishText,
  postTodayPnlToOperatePublish,
} from "./today-autotrade-pnl-publish.js";
import { executionFromParsed, normalizeExecution } from "./discord-signal-execution.js";
import { computeTodayPnlOpenMark } from "./today-autotrade-pnl-mark.js";
import {
  dedupeTodayPnlTrades,
  resolveCardAlignedDisplayOutcome,
  resolveCardAlignedDisplayPnl,
  resolveTodayPnlEntryDisplay,
  sanitizeDisplayTpsl,
  TODAY_PNL_SIGNAL_DEDUPE_MS,
} from "./today-autotrade-pnl-display.js";

const SETTLEMENT_SOURCE_TYPES = new Set(["kolvip", "telegram", "binance"]);

/** @param {string} st */
function sourceTypeLabel(st) {
  const t = String(st ?? "").toLowerCase();
  if (t === "kolvip") return "巨鲸";
  if (t === "telegram") return "Telegram";
  if (t === "binance") return "币安广场";
  return t || "—";
}

/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 */
function defaultMarginFromCard(card) {
  const pj =
    card.parsedJson && typeof card.parsedJson === "object"
      ? /** @type {Record<string, unknown>} */ (card.parsedJson)
      : {};
  const n = Number(pj.kolvipOrderSizeUsdt);
  if (Number.isFinite(n) && n > 0) return n;
  return 2;
}

/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 */
function qualifiesSettlementCard(card) {
  const st = String(card.sourceType ?? "").toLowerCase();
  if (!SETTLEMENT_SOURCE_TYPES.has(st)) return false;
  if (extractAutotradeRows(card).length) return true;
  if (!String(card.symbol ?? "").trim()) return false;
  const progress = parseProgressJson(card.progress);
  if (progress && (progress.pnlPct != null || progress.status)) return true;
  const pj = card.parsedJson;
  if (pj && typeof pj === "object") {
    const p = /** @type {Record<string, unknown>} */ (pj);
    if (p.direction || p.entry != null || p.stopLoss != null || p.takeProfit != null) return true;
  }
  return false;
}

/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 */
function extractAutotradeRows(card) {
  const pj =
    card.parsedJson && typeof card.parsedJson === "object"
      ? /** @type {Record<string, unknown>} */ (card.parsedJson)
      : {};
  const bitget =
    pj.bitgetOrder && typeof pj.bitgetOrder === "object"
      ? /** @type {Record<string, unknown>} */ (pj.bitgetOrder)
      : null;
  const weex =
    pj.weexOrder && typeof pj.weexOrder === "object"
      ? /** @type {Record<string, unknown>} */ (pj.weexOrder)
      : null;
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  const marginDefault = Number(pj.kolvipOrderSizeUsdt ?? 2);
  const progress = parseProgressJson(card.progress);
  const pnlPct =
    progress?.pnlPct != null && Number.isFinite(Number(progress.pnlPct))
      ? Number(progress.pnlPct)
      : null;

  /**
   * @param {"bitget"|"weex"} exchange
   * @param {Record<string, unknown>} rec
   */
  function pushRow(exchange, rec) {
    const plan =
      rec.plan && typeof rec.plan === "object"
        ? /** @type {Record<string, unknown>} */ (rec.plan)
        : {};
    const margin = Number(rec.orderSizeUsdt ?? plan.orderSizeUsdt ?? marginDefault);
    const m = Number.isFinite(margin) && margin > 0 ? margin : marginDefault;
    const at = String(rec.at ?? card.signalAt ?? "");
    const pnlUsdt =
      pnlPct != null && Number.isFinite(pnlPct) ? Math.round((m * pnlPct) / 100 * 100) / 100 : null;
    rows.push({
      exchange,
      status: String(rec.status ?? ""),
      orderId: String(rec.orderId ?? rec.openOrderId ?? ""),
      at,
      orderSizeUsdt: m,
      symbol: String(rec.symbol ?? rec.plan?.symbol ?? card.symbol ?? ""),
      channelId: String(rec.channelId ?? card.channelId ?? ""),
      channelName: String(rec.channelName ?? card.channelName ?? ""),
      pnlPct,
      pnlUsdt,
      progressStatus: progress?.status ? String(progress.status) : "",
      progressOutcome: progress?.outcome ? String(progress.outcome) : "",
      closed: isProgressTerminal(card.progress),
    });
  }

  if (bitget?.orderId && String(bitget.status ?? "") !== "skipped") {
    pushRow("bitget", bitget);
  }
  if (weex?.openOrderId || String(weex?.status ?? "").includes("placed")) {
    if (weex) pushRow("weex", weex);
  }
  return rows;
}

/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 * @param {number} marginDefault
 */
/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 * @param {Record<string, unknown>} trade
 */
function attachSourcePostUrl(card, trade) {
  const sourcePostUrl = resolveCardSourcePostUrl(card);
  if (sourcePostUrl) trade.sourcePostUrl = sourcePostUrl;
  return trade;
}

/** @param {string[]} prices */
function takeProfitPricesText(prices) {
  if (!Array.isArray(prices) || !prices.length) return "";
  return prices
    .map((x) => String(x ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

/**
 * 卡片原文中的止盈/止损价（execution_json + parsedJson 回填）。
 * @param {ReturnType<typeof archiveCardToClient>} card
 */
function rawTpslFromExecution(ex) {
  const stopLossPrice = String(ex.planned?.stopLossPrice ?? "").trim();
  const takeProfitPrices = Array.isArray(ex.planned?.takeProfitPrices)
    ? ex.planned.takeProfitPrices.map((x) => String(x ?? "").trim()).filter(Boolean)
    : [];
  const takeProfitText = takeProfitPricesText(takeProfitPrices);
  return {
    stopLossPrice: stopLossPrice || null,
    takeProfitPrices,
    takeProfitText: takeProfitText || null,
  };
}

function tpslMissing(tpsl) {
  return !tpsl.stopLossPrice && !(tpsl.takeProfitPrices?.length);
}

export function signalTpslFromCard(card) {
  const ex = normalizeExecution(card.execution, card.parsedJson);
  let tpsl = sanitizeDisplayTpsl(card, rawTpslFromExecution(ex));
  if (tpslMissing(tpsl) && card.parsedJson && typeof card.parsedJson === "object") {
    const fromParsed = executionFromParsed(card.parsedJson);
    tpsl = sanitizeDisplayTpsl(card, rawTpslFromExecution(fromParsed));
  }
  return tpsl;
}

/**
 * @param {ReturnType<typeof archiveCardToClient>} card
 * @param {Record<string, unknown>} trade
 */
export function attachSignalPlanFields(card, trade) {
  const tpsl = signalTpslFromCard(card);
  trade.stopLossPrice = tpsl.stopLossPrice;
  trade.takeProfitPrices = tpsl.takeProfitPrices;
  trade.takeProfitText = tpsl.takeProfitText;
  const displayPnl = resolveCardAlignedDisplayPnl(
    card,
    trade.pnlPct != null ? Number(trade.pnlPct) : null
  );
  trade.pnlPct = displayPnl;
  trade.pnlUsdt =
    displayPnl != null && Number.isFinite(Number(displayPnl))
      ? Math.round(((Number(trade.marginUsdt) || 2) * Number(displayPnl)) / 100 * 100) / 100
      : null;
  attachDisplayOutcome(card, trade, displayPnl);
  const entry = resolveTodayPnlEntryDisplay(card);
  trade.entryPrice = entry.entryPrice;
  trade.entryPriceKind = entry.entryPriceKind;
  trade.entryPriceDisplay = entry.entryPriceDisplay;
  if ("rawPnlPct" in trade) delete trade.rawPnlPct;
  if ("slPrice" in trade) delete trade.slPrice;
  return trade;
}

/**
 * @param {Record<string, unknown>} trade
 * @param {number | null | undefined} pnlPct
 */
function attachDisplayOutcome(card, trade, pnlPct) {
  trade.displayOutcome = resolveCardAlignedDisplayOutcome(card, trade.progressOutcome);
  if (!trade.displayOutcome && pnlPct != null) {
    trade.displayOutcome = pnlPct >= 0 ? "take_profit" : "stop_loss";
  }
  return trade;
}

function settlementRowWithoutLiveOrder(card, marginDefault) {
  const progress = parseProgressJson(card.progress);
  const pnlPct =
    progress?.pnlPct != null && Number.isFinite(Number(progress.pnlPct))
      ? Number(progress.pnlPct)
      : null;
  const m = marginDefault;
  const pnlUsdt =
    pnlPct != null && Number.isFinite(pnlPct) ? Math.round((m * pnlPct) / 100 * 100) / 100 : null;
  const st = String(card.sourceType ?? "").toLowerCase();
  return {
    cardId: card.id,
    uid: card.uid ?? (card.id != null ? `SC-${card.id}` : ""),
    symbol: card.symbol,
    channelId: card.channelId,
    channelName: card.channelName,
    sourceType: st,
    sourceLabel: sourceTypeLabel(st),
    signalAt: card.signalAt,
    orderAt: card.signalAt,
    marginUsdt: m,
    defaultMarginUsdt: m,
    hasLiveAutotrade: false,
    pnlPct,
    pnlUsdt,
    closed: isProgressTerminal(card.progress),
    progressStatus: progress?.status ? String(progress.status) : "",
    progressOutcome: progress?.outcome ? String(progress.outcome) : "",
    exchanges: [],
    brief:
      card.cardsByStyle?.cn_brief ??
      card.cardsByStyle?.brief ??
      String(card.rawContent ?? "").slice(0, 120),
  };
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 */
export function registerTodayAutotradePnlRoutes(app, { store }) {
  app.get("/api/local/today-autotrade-pnl", requireLocalRequest, async (_req, res) => {
    try {
      if (!store?.listSignalCards) {
        res.status(503).json({ ok: false, error: "store_unavailable" });
        return;
      }
      const fromMs = shanghaiCalendarDayStartMs();
      const toMs = Date.now();
      const rows = await store.listSignalCards({ fromMs, toMs, limit: 800, status: "active" });
      /** @type {Record<string, unknown>[]} */
      const trades = [];
      for (const row of rows ?? []) {
        const card = archiveCardToClient(row);
        if (!qualifiesSettlementCard(card)) continue;

        const slices = extractAutotradeRows(card);
        const orderTimes = slices
          .map((s) => Date.parse(String(s.at ?? "")))
          .filter((t) => Number.isFinite(t));
        const signalMs = Date.parse(String(card.signalAt ?? ""));
        const anchorMs = orderTimes.length
          ? Math.min(...orderTimes)
          : Number.isFinite(signalMs)
            ? signalMs
            : NaN;
        if (Number.isFinite(anchorMs) && (anchorMs < fromMs || anchorMs > toMs)) continue;

        const st = String(card.sourceType ?? "").toLowerCase();

        if (slices.length) {
          const margin = Math.max(...slices.map((s) => Number(s.orderSizeUsdt) || 2));
          const pnlPct = slices[0]?.pnlPct ?? null;
          const pnlUsdt = slices[0]?.pnlUsdt ?? null;

          trades.push(
            attachSignalPlanFields(
              card,
              attachSourcePostUrl(card, {
              cardId: card.id,
              uid: card.uid ?? (card.id != null ? `SC-${card.id}` : ""),
              symbol: card.symbol ?? slices[0]?.symbol,
              channelId: card.channelId,
              channelName: card.channelName,
              sourceType: st,
              sourceLabel: sourceTypeLabel(st),
              signalAt: card.signalAt,
              orderAt: slices.map((s) => s.at).filter(Boolean).sort()[0] ?? card.signalAt,
              marginUsdt: margin,
              defaultMarginUsdt: margin,
              hasLiveAutotrade: true,
              pnlPct,
              pnlUsdt,
              closed: slices.some((s) => s.closed),
              progressStatus: slices[0]?.progressStatus,
              progressOutcome: slices[0]?.progressOutcome,
              exchanges: slices.map((s) => ({
                exchange: s.exchange,
                status: s.status,
                orderId: s.orderId,
                at: s.at,
              })),
              brief:
                card.cardsByStyle?.cn_brief ??
                card.cardsByStyle?.brief ??
                String(card.rawContent ?? "").slice(0, 120),
            }),
            ),
          );
        } else {
          trades.push(
            attachSignalPlanFields(
              card,
              attachSourcePostUrl(
                card,
                settlementRowWithoutLiveOrder(card, defaultMarginFromCard(card))
              )
            )
          );
        }
      }

      const deduped = dedupeTodayPnlTrades(trades);

      let sumPnlUsdt = 0;
      let closedPnl = 0;
      let openCount = 0;
      let closedCount = 0;
      for (const t of deduped) {
        if (t.closed) closedCount += 1;
        else openCount += 1;
        if (t.pnlUsdt != null && Number.isFinite(Number(t.pnlUsdt))) {
          sumPnlUsdt += Number(t.pnlUsdt);
          if (t.closed) closedPnl += Number(t.pnlUsdt);
        }
      }
      sumPnlUsdt = Math.round(sumPnlUsdt * 100) / 100;
      closedPnl = Math.round(closedPnl * 100) / 100;

      const dayLabel = new Intl.DateTimeFormat("zh-CN", {
        timeZone: "Asia/Shanghai",
        dateStyle: "full",
      }).format(new Date(fromMs));

      res.json({
        ok: true,
        publishEnabled: config.tradeSignalAiPublishEnabled,
        dayLabel,
        fromMs,
        toMs,
        summary: {
          tradeCards: deduped.length,
          openCount,
          closedCount,
          sumPnlUsdt,
          closedPnlUsdt: closedPnl,
          dedupeWindowMs: TODAY_PNL_SIGNAL_DEDUPE_MS,
          note:
            `pnlUsdt = 自定义保证金 × progress.pnlPct / 100；含巨鲸/Telegram/币安广场当日可结算卡；路径进度非交易所账单；同源同币种信号 ${TODAY_PNL_SIGNAL_DEDUPE_MS / 60_000} 分钟内去重（仅列表展示）`,
        },
        sourceTypes: [...SETTLEMENT_SOURCE_TYPES],
        trades: deduped,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.post("/api/local/today-autotrade-pnl/mark-open", requireLocalRequest, async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const cardId = Number(body.cardId ?? req.query?.cardId);
      if (!Number.isFinite(cardId) || cardId <= 0) {
        res.status(400).json({ ok: false, error: "cardId 无效" });
        return;
      }
      if (!store?.getSignalCardById) {
        res.status(503).json({ ok: false, error: "store_unavailable" });
        return;
      }
      const row = await store.getSignalCardById(cardId);
      if (!row) {
        res.status(404).json({ ok: false, error: "card_not_found" });
        return;
      }
      const card = archiveCardToClient(row);
      const result = await computeTodayPnlOpenMark(card);
      if (result.skip) {
        res.json({ ok: false, cardId, skipped: true, reason: result.reason ?? "closed" });
        return;
      }
      if (!result.ok) {
        res.json({
          ok: false,
          cardId,
          error: result.error,
          markError: result.markError ?? result.error,
        });
        return;
      }
      res.json({
        ok: true,
        cardId,
        pnlPct: result.pnlPct,
        markPrice: result.markPrice ?? null,
        mode: result.mode ?? "",
        markAt: new Date().toISOString(),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.post("/api/local/today-autotrade-pnl/publish", requireLocalRequest, async (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const rows = Array.isArray(body.rows) ? body.rows : [];
      if (!rows.length) {
        res.status(400).json({ ok: false, error: "rows 为空" });
        return;
      }
      const sumPnlUsdt = Number(body.sumPnlUsdt);
      const text = formatTodayPnlPublishText({
        dayLabel: body.dayLabel,
        sumPnlUsdt: Number.isFinite(sumPnlUsdt) ? sumPnlUsdt : undefined,
        tradeCount: rows.length,
        rows,
      });
      const title = String(body.title ?? "").trim() || `今日跟单结算 · ${String(body.dayLabel ?? "").trim() || "今日"}`;
      const platforms = Array.isArray(body.platforms)
        ? body.platforms.map((x) => String(x ?? "").trim()).filter(Boolean)
        : undefined;
      const result = await postTodayPnlToOperatePublish({ title, text, platforms });
      if (!result.ok) {
        res.status(result.error?.includes("TRADE_SIGNAL") ? 503 : 502).json({ ok: false, ...result });
        return;
      }
      res.json({
        ok: true,
        textPreview: text.slice(0, 400),
        ...result,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });
}