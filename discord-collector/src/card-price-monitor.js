/**
 * 卡片价格校验（默认 3h；股票较长周期）与接近关键价位推送。
 */
import { archiveCardToClient } from "./card-archive-service.js";
import { isBacktestDue, runCardBacktest, shouldSkipCardBacktest, buildSkippedBacktestJson } from "./card-backtest-engine.js";
import { resolveCardSignalAt } from "./discord-signal-card-service.js";
import {
  evaluatePricePath,
  fetchKlinesForCard,
  fetchFuturesPrice,
} from "./card-price-fetch.js";
import {
  collectProximityLevels,
  getCardProximityPolicy,
  getCardProximityCheckIntervalMs,
  isLevelNear,
  levelKindLabel,
  proximityDistanceLabel,
  shouldCheckCardProximity,
} from "./card-proximity-policy.js";
import { getCardVerifyPlan, verifyModeLabel } from "./card-verify-policy.js";
import { config } from "./config.js";

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {ReturnType<typeof import("./discord-system-telegram.js").createSystemTelegramAlert>} systemTelegram
 * @param {(channel: string, payload: Record<string, unknown>) => void} [broadcast]
 */
export function createCardPriceMonitor(store, log, systemTelegram, broadcast) {
  let timer = null;

  /** @param {string} msg */
  function logCardPullDetail(msg) {
    if (config.cardPullForwardLog) log.info(msg);
  }

  /**
   * @param {Record<string, unknown>} row
   */
  function cardSignalMs(row) {
    const resolved = resolveCardSignalAt(row);
    if (resolved) {
      const ms = new Date(resolved).getTime();
      if (Number.isFinite(ms)) return ms;
    }
    const s = row.signal_at ?? row.signalAt ?? row.created_at ?? row.createdAt;
    const ms = new Date(String(s)).getTime();
    return Number.isFinite(ms) ? ms : Date.now();
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

  /**
   * @param {ReturnType<typeof archiveCardToClient>} card
   */
  function isVerificationDue(card, signalMs, now) {
    const { verifyMode, window } = getCardVerifyPlan(card);
    const already =
      verifyMode === "30d"
        ? card.verify1m != null
        : card.verify3h != null;
    if (already) return false;
    return now - signalMs >= window.durationMs;
  }

  /** @param {Record<string, unknown>} result */
  function formatVerifyOutcomeNote(verifyMode, result) {
    const modeLabel = verifyModeLabel(verifyMode);
    if (result.outcome === "pending") {
      return `自动校验(${modeLabel}): 窗口内未触达止盈/止损`;
    }
    const kind = result.outcome === "take_profit" ? "止盈" : "止损";
    const pnl = result.pnl100x?.pnlLabel ? ` | ${result.pnl100x.pnlLabel}` : "";
    const entry =
      result.entry != null
        ? ` | 入场均价 ${Number(result.entry).toLocaleString("en-US", { maximumFractionDigits: 2 })}`
        : "";
    return `自动校验(${modeLabel}): ${kind} @ ${result.hitLevel || "—"}${entry}${pnl}`;
  }

  async function runBacktest() {
    const rows = await store.listCardsForBacktest({ limit: 40 });
    for (const row of rows) {
      const card = archiveCardToClient(row);
      const sym = card.symbol;
      if (!sym) continue;

      const signalMs = cardSignalMs(row);
      const now = Date.now();
      const skip = shouldSkipCardBacktest(card);
      if (skip.skip && skip.reason === "user_evaluated" && !card.backtest) {
        await store.updateSignalCard(card.id, {
          backtestJson: buildSkippedBacktestJson("user_evaluated"),
        });
        log.debug(`卡片 #${card.id} 已人工评价，跳过回测`);
        continue;
      }
      if (!isBacktestDue(card, signalMs, now)) continue;

      try {
        const result = await runCardBacktest(card, signalMs);
        if (result.skipped) continue;

        await store.updateSignalCard(card.id, { backtestJson: result });
        const pnl = result.pnlLabel ? ` ${result.pnlLabel}` : "";
        const win = result.bestWindow ? ` best=${result.bestWindow}` : "";
        logCardPullDetail(
          `卡片 #${card.id} 回测 tier=${result.tier ?? "?"}${win}${pnl}${result.error ? ` err=${result.error}` : ""}`
        );
      } catch (e) {
        log.warn(`卡片 #${card.id} 回测失败: ${/** @type {Error} */ (e).message}`);
      }
    }
  }

  async function runVerification() {
    const rows = await store.listCardsForVerification({ limit: 80 });
    for (const row of rows) {
      const card = archiveCardToClient(row);
      const sym = card.symbol;
      if (!sym) continue;

      const signalMs = cardSignalMs(row);
      const now = Date.now();
      if (!isVerificationDue(card, signalMs, now)) continue;

      const { assetClass, verifyMode, window } = getCardVerifyPlan(card);

      try {
        const end = signalMs + window.durationMs;
        let result;
        try {
          const klines = await fetchKlinesForCard(sym, assetClass, signalMs, end, window.klineInterval);
          result = {
            ...evaluatePricePath(card.execution, klines),
            window: window.labelShort,
            verifyMode,
            assetClass,
            symbol: sym,
            klineCount: klines.length,
          };
        } catch (fetchErr) {
          log.warn(
            `卡片 #${card.id} ${verifyMode} 行情拉取失败（下轮重试）: ${String(/** @type {Error} */ (fetchErr).message ?? fetchErr)}`
          );
          continue;
        }

        /** @type {Record<string, unknown>} */
        const patch = {
          [window.resultField]: result,
        };
        if (!result.error) {
          patch.executionJson = {
            ...card.execution,
            outcome: result.outcome,
            outcomeNote: formatVerifyOutcomeNote(verifyMode, result),
          };
        }
        await store.updateSignalCard(card.id, patch);
        const pnl = result.pnl100x?.pnlLabel ? ` pnl=${result.pnl100x.pnlLabel}` : "";
        logCardPullDetail(
          `卡片 #${card.id} ${verifyMode} 校验 asset=${assetClass} outcome=${result.outcome}${pnl}${result.error ? ` err=${result.error}` : ""}`
        );
      } catch (e) {
        log.warn(`卡片 #${card.id} 价格校验失败: ${/** @type {Error} */ (e).message}`);
      }
    }
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

  async function tick() {
    await runVerification();
    await runBacktest();
    await runProximityCheck();
  }

  function start() {
    if (timer) return;
    const ms = config.cardPriceMonitorIntervalMs;
    timer = setInterval(() => {
      void tick().catch((e) => log.warn(`价格监控 tick: ${/** @type {Error} */ (e).message}`));
    }, ms);
    void tick().catch((e) => log.warn(`价格监控首次: ${/** @type {Error} */ (e).message}`));
    log.info(
      `卡片价格监控已启动 tick=${config.cardPriceMonitorIntervalMs}ms | ` +
        `接近推送 加密每${config.cardProximityCryptoCheckMs / 3600000}h±${config.cardProximityCryptoBandPct}% | ` +
        `股票每${config.cardProximityStockCheckMs / 86400000}d落差${config.cardProximityStockGapPct * 100}%` +
        (config.binanceProxy ? ` | Binance 代理 ${config.binanceProxy}` : "")
    );
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, tick, runVerification, runBacktest, runProximityCheck };
}
