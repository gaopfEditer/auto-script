/**
 * 卡片价格接近关价位推送（不再做延时自动校验 / 分层回测）。
 */
import { archiveCardToClient } from "./card-archive-service.js";
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

  async function tick() {
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
      `卡片接近推送已启动 tick=${config.cardPriceMonitorIntervalMs}ms | ` +
        `加密每${config.cardProximityCryptoCheckMs / 3600000}h±${config.cardProximityCryptoBandPct}% | ` +
        `股票每${config.cardProximityStockCheckMs / 86400000}d落差${config.cardProximityStockGapPct * 100}%` +
        `（已关闭延时自动校验/回测）` +
        (config.binanceProxy ? ` | Binance 代理 ${config.binanceProxy}` : "")
    );
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, tick, runProximityCheck };
}
