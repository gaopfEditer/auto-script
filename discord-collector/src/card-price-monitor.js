/**
 * 卡片价格接近推送 + TP1/2/3 自动评价 + Bitget/WEEX TP1 保本移损。
 */
import { archiveCardToClient } from "./card-archive-service.js";
import { runCardTpSettlement, isBacktestDue } from "./card-backtest-engine.js";
import { fetchFuturesPrice } from "./card-price-fetch.js";
import {
  collectProximityLevels,
  getCardProximityPolicy,
  getCardProximityCheckIntervalMs,
  isLevelNear,
  levelKindLabel,
  proximityDistanceLabel,
  shouldCheckCardProximity,
} from "./card-proximity-policy.js";
import { getCardVerifyPlan } from "./card-verify-policy.js";
import { hasEvaluatedYield, normalizeExecution } from "./discord-signal-execution.js";
import { resolveCardSignalAt } from "./discord-signal-card-service.js";
import {
  isTp1Reached,
  needsTp1Breakeven,
  resolveStagedTp1Price,
} from "./discord-signal-staged-trade.js";
import { config } from "./config.js";

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {ReturnType<typeof import("./discord-system-telegram.js").createSystemTelegramAlert>} systemTelegram
 * @param {(channel: string, payload: Record<string, unknown>) => void} [broadcast]
 * @param {{
 *   bitgetOrder?: ReturnType<typeof import("./bitget-order-service.js").createBitgetOrderService> | null;
 *   weexOrder?: ReturnType<typeof import("./weex-order-service.js").createWeexOrderService> | null;
 * }} [deps]
 */
export function createCardPriceMonitor(store, log, systemTelegram, broadcast, deps = {}) {
  let timer = null;
  let beTimer = null;
  /** @type {Set<number>} */
  const beInFlight = new Set();

  /** @param {string} msg */
  function logCardPullDetail(msg) {
    if (config.cardPullForwardLog) log.info(msg);
  }

  /**
   * @param {Record<string, unknown>} card
   */
  function collectLevels(card) {
    return collectProximityLevels(card).map((lv) => ({
      kind: lv.kind,
      price: lv.price,
      referencePrice: lv.referencePrice,
      entryRange: lv.entryRange,
      bandPct: lv.bandPct,
    }));
  }

  async function runProximityCheck() {
    const rows = await store.listActiveCardsForProximity({ limit: 200 });
    const now = Date.now();
    /** @type {Map<string, { assetClass: string, price: number }>} */
    const priceCache = new Map();

    for (const row of rows) {
      const card = archiveCardToClient(row);
      const policy = getCardProximityPolicy(card);
      const checkIntervalMs = getCardProximityCheckIntervalMs(card);
      let proximity =
        card.proximity && typeof card.proximity === "object" ? { ...card.proximity } : {};

      if (!shouldCheckCardProximity(proximity, now, checkIntervalMs)) {
        continue;
      }

      const sym = card.symbol;
      if (!sym) continue;

      let price = priceCache.get(sym)?.price;
      if (price == null) {
        try {
          const { assetClass } = getCardVerifyPlan(card);
          if (assetClass === "stock") {
            log.debug(`股票 ${sym} 现价源未配置，跳过接近检查`);
            proximity._meta = {
              ...(proximity._meta && typeof proximity._meta === "object" ? proximity._meta : {}),
              lastCheckAt: new Date().toISOString(),
              skipped: "stock_price_feed",
            };
            await store.updateSignalCard(card.id, { proximityJson: proximity });
            continue;
          }
          const tick = await fetchFuturesPrice(sym);
          price = tick.price;
          priceCache.set(sym, { assetClass, price });
        } catch (e) {
          log.debug(`现价拉取失败 ${sym}: ${/** @type {Error} */ (e).message}`);
          continue;
        }
      }

      const levels = collectLevels(card);
      /** @type {Array<Record<string, unknown>>} */
      const alerts = [];

      for (const lv of levels) {
        const near = isLevelNear(price, lv.price, policy.assetClass, lv.referencePrice, lv);
        const key = `${lv.kind}_${lv.price}`;
        const prev = proximity[key];
        const distLabel = proximityDistanceLabel(price, lv.price, policy.assetClass, lv.referencePrice, lv);

        if (near) {
          const lastAlert = prev?.lastAlertAt ? new Date(String(prev.lastAlertAt)).getTime() : 0;
          if (now - lastAlert >= checkIntervalMs) {
            alerts.push({
              kind: lv.kind,
              kindLabel: levelKindLabel(lv.kind),
              level: lv.price,
              currentPrice: price,
              distanceLabel: distLabel,
              policy: policy.assetClass,
            });
            proximity[key] = {
              lastAlertAt: new Date().toISOString(),
              near: true,
              distanceLabel: distLabel,
              price,
            };
          }
        } else if (prev) {
          proximity[key] = { ...prev, near: false, distanceLabel: distLabel, price };
        }
      }

      proximity._meta = {
        ...(proximity._meta && typeof proximity._meta === "object" ? proximity._meta : {}),
        lastCheckAt: new Date().toISOString(),
        assetClass: policy.assetClass,
        checkIntervalMs,
      };

      await store.updateSignalCard(card.id, { proximityJson: proximity });

      if (alerts.length) {
        const rule =
          policy.assetClass === "stock"
            ? `股票 ${policy.checkLabel} · 落差 ${policy.gapLabel}`
            : `加密 ${policy.checkLabel} · 误差 ${policy.bandLabel}`;
        const lines = alerts.map(
          (a) => `· ${a.kindLabel} ${a.level} — ${a.distanceLabel}（现价 ${a.currentPrice}）`
        );
        const text = [
          `📍 价格接近警报 · ${sym}`,
          `卡片 #${card.id} · 来源 ${card.sourceType}`,
          `规则: ${rule}`,
          ...lines,
          card.cardFields?.title ? `标题: ${card.cardFields.title}` : "",
        ]
          .filter(Boolean)
          .join("\n");

        broadcast?.("meta", {
          kind: "card_price_proximity",
          cardId: card.id,
          symbol: sym,
          price,
          policy: policy.assetClass,
          alerts,
        });

        if (config.cardProximityTelegram) {
          await systemTelegram.notify(text, { kind: "card_proximity" });
        }
        logCardPullDetail(`接近推送 #${card.id} ${sym} [${policy.assetClass}] alerts=${alerts.length}`);
      }
    }
  }

  /**
   * 已产生信号、尚未人工评价：按 K 线自动判定最佳 TP / SL 结算价。
   */
  async function runAutoEval() {
    if (!config.cardAutoEvalEnabled) return;
    if (!store.listCardsForBacktest) return;

    const rows = await store.listCardsForBacktest({ limit: 30 });
    for (const row of rows) {
      const card = archiveCardToClient(row);
      const ex = normalizeExecution(card.execution);
      if (hasEvaluatedYield(ex)) continue;
      if (ex.outcome && ex.outcome !== "pending") continue;

      const signalAt = resolveCardSignalAt(row) ?? card.signalAt ?? card.createdAt;
      const signalMs = signalAt ? Date.parse(String(signalAt)) : NaN;
      if (!Number.isFinite(signalMs)) continue;
      if (!isBacktestDue(card, signalMs)) continue;

      try {
        const result = await runCardTpSettlement(card, signalMs);
        if (result.skipped || result.error === "missing_entry") {
          continue;
        }

        /** @type {Record<string, unknown>} */
        const patch = { backtestJson: result };
        if (result.outcome === "take_profit" || result.outcome === "stop_loss") {
          const settlement = Number(result.settlementPrice ?? result.optimalExitPrice);
          const entry = Number(result.entry);
          if (Number.isFinite(settlement) && settlement > 0 && Number.isFinite(entry) && entry > 0) {
            const isShort = result.direction === "short";
            patch.executionJson = {
              ...ex,
              outcome: result.outcome,
              actual: {
                ...ex.actual,
                buyPrice: isShort ? String(settlement) : String(entry),
                sellPrice: isShort ? String(entry) : String(settlement),
                takeProfitPrices: ex.actual?.takeProfitPrices ?? [],
                stopLossPrice: ex.actual?.stopLossPrice ?? "",
              },
              autoEval: {
                bestTp: result.bestTp ?? null,
                settlementPrice: settlement,
                at: result.optimalAt ?? null,
                source: "collector_auto_eval",
              },
            };
          }
        }

        await store.updateSignalCard(card.id, patch);
        broadcast?.("meta", {
          kind: "card_auto_eval",
          cardId: card.id,
          symbol: card.symbol,
          result,
        });
        log.info(
          `自动评价 #${card.id} ${card.symbol} outcome=${result.outcome} best=${result.bestTp ?? "-"} @ ${result.settlementPrice ?? result.optimalExitPrice ?? "-"}`
        );
      } catch (e) {
        log.debug(`自动评价失败 #${card.id}: ${/** @type {Error} */ (e).message}`);
      }
    }
  }

  /**
   * 卡片挂的 Bitget/WEEX 单：现价触及 TP1 → 止损移到开仓价。
   */
  async function runTp1Breakeven() {
    if (!config.cardTp1BreakevenEnabled) return;
    const bitgetOrder = deps.bitgetOrder ?? null;
    const weexOrder = deps.weexOrder ?? null;
    if (!bitgetOrder?.onTp1Breakeven && !weexOrder?.onTp1Breakeven) return;
    if (!store.listActiveCardsForProximity) return;

    const rows = await store.listActiveCardsForProximity({ limit: 200 });
    /** @type {Map<string, number>} */
    const priceCache = new Map();

    for (const row of rows) {
      const card = archiveCardToClient(row);
      const cardId = Number(card.id);
      if (!Number.isFinite(cardId) || beInFlight.has(cardId)) continue;

      const parsed =
        card.parsedJson && typeof card.parsedJson === "object"
          ? /** @type {Record<string, unknown>} */ (card.parsedJson)
          : null;
      if (!parsed) continue;

      const bitget =
        parsed.bitgetOrder && typeof parsed.bitgetOrder === "object"
          ? /** @type {Record<string, unknown>} */ (parsed.bitgetOrder)
          : null;
      const weex =
        parsed.weexOrder && typeof parsed.weexOrder === "object"
          ? /** @type {Record<string, unknown>} */ (parsed.weexOrder)
          : null;

      /** @type {Array<{ exchange: "bitget"|"weex"; order: Record<string, unknown> }>} */
      const targets = [];
      if (bitget && needsTp1Breakeven(bitget) && bitgetOrder?.onTp1Breakeven) {
        targets.push({ exchange: "bitget", order: bitget });
      }
      if (weex && needsTp1Breakeven(weex) && weexOrder?.onTp1Breakeven) {
        targets.push({ exchange: "weex", order: weex });
      }
      if (!targets.length) continue;

      const sym = String(card.symbol || targets[0].order.symbol || "").toUpperCase();
      if (!sym) continue;

      let price = priceCache.get(sym);
      if (price == null) {
        try {
          const tick = await fetchFuturesPrice(sym);
          price = tick.price;
          priceCache.set(sym, price);
        } catch (e) {
          log.debug(`TP1保本取价失败 ${sym}: ${/** @type {Error} */ (e).message}`);
          continue;
        }
      }

      beInFlight.add(cardId);
      try {
        for (const t of targets) {
          const tp1 = resolveStagedTp1Price(t.order, parsed);
          if (!tp1) continue;
          const holdSide = String(t.order.holdSide ?? (t.order.side === "buy" ? "long" : "short"));
          if (!isTp1Reached(price, tp1, holdSide)) continue;

          const svc = t.exchange === "bitget" ? bitgetOrder : weexOrder;
          const result = await svc.onTp1Breakeven({ cardId, parsed });
          if (result?.ok && !result.skipped) {
            broadcast?.("meta", {
              kind: "card_tp1_breakeven",
              cardId,
              symbol: sym,
              exchange: t.exchange,
              tp1,
              price,
              entry: result.record?.breakevenEntryPrice ?? null,
            });
            log.info(
              `TP1保本移损 #${cardId} ${sym} ${t.exchange} tp1=${tp1} price=${price} SL→${result.record?.breakevenEntryPrice ?? ""}`
            );
          }
        }
      } catch (e) {
        log.warn(`TP1保本异常 #${cardId}: ${/** @type {Error} */ (e).message}`);
      } finally {
        beInFlight.delete(cardId);
      }
    }
  }

  async function tick() {
    await runProximityCheck();
    await runAutoEval();
  }

  function start() {
    if (timer) return;
    const ms = config.cardPriceMonitorIntervalMs;
    timer = setInterval(() => {
      void tick().catch((e) => log.warn(`价格监控 tick: ${/** @type {Error} */ (e).message}`));
    }, ms);
    void tick().catch((e) => log.warn(`价格监控首次: ${/** @type {Error} */ (e).message}`));

    if (config.cardTp1BreakevenEnabled && (deps.bitgetOrder || deps.weexOrder)) {
      const beMs = Math.max(10_000, Number(config.cardTp1BreakevenIntervalMs) || 30_000);
      beTimer = setInterval(() => {
        void runTp1Breakeven().catch((e) =>
          log.warn(`TP1保本 tick: ${/** @type {Error} */ (e).message}`)
        );
      }, beMs);
      void runTp1Breakeven().catch((e) =>
        log.warn(`TP1保本首次: ${/** @type {Error} */ (e).message}`)
      );
    }

    log.info(
      `卡片监控已启动 tick=${config.cardPriceMonitorIntervalMs}ms | ` +
        `接近 每${Math.round(config.cardProximityCryptoCheckMs / 60000)}min±${config.cardProximityCryptoBandPct}% | ` +
        `自动评价=${config.cardAutoEvalEnabled ? "on" : "off"}` +
        (config.cardTp1BreakevenEnabled
          ? ` | TP1保本=${Math.round((config.cardTp1BreakevenIntervalMs || 30000) / 1000)}s`
          : " | TP1保本=off") +
        (config.binanceProxy ? ` | Binance 代理 ${config.binanceProxy}` : "")
    );
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (beTimer) {
      clearInterval(beTimer);
      beTimer = null;
    }
  }

  return { start, stop, tick, runProximityCheck, runAutoEval, runTp1Breakeven };
}
