/**
 * 卡片价格校验（3 小时 / 1 月）与接近关键价位推送。
 */
import { archiveCardToClient } from "./card-archive-service.js";
import {
  distancePct,
  evaluatePricePath,
  fetchFuturesKlines,
  fetchFuturesPrice,
  parsePrice,
} from "./card-price-fetch.js";
import { config } from "./config.js";

const VERIFY_3H_MS = 3 * 60 * 60 * 1000;
const VERIFY_1M_MS = 30 * 24 * 60 * 60 * 1000;

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {ReturnType<typeof import("./discord-system-telegram.js").createSystemTelegramAlert>} systemTelegram
 * @param {(channel: string, payload: Record<string, unknown>) => void} [broadcast]
 */
export function createCardPriceMonitor(store, log, systemTelegram, broadcast) {
  /** @type {Map<string, number>} */
  const priceCache = new Map();
  let timer = null;

  /**
   * @param {Record<string, unknown>} row
   */
  function cardSignalMs(row) {
    const s = row.signal_at ?? row.signalAt ?? row.created_at ?? row.createdAt;
    const ms = new Date(String(s)).getTime();
    return Number.isFinite(ms) ? ms : Date.now();
  }

  /**
   * @param {Record<string, unknown>} card
   */
  function collectLevels(card) {
    const ex = card.execution ?? {};
    const planned = ex.planned ?? {};
    /** @type {Array<{ kind: string, price: number }>} */
    const levels = [];
    const entry = parsePrice(planned.entryPrice);
    const sl = parsePrice(planned.stopLossPrice);
    if (entry) levels.push({ kind: "entry", price: entry });
    if (sl) levels.push({ kind: "stop_loss", price: sl });
    for (const tp of planned.takeProfitPrices ?? []) {
      const p = parsePrice(tp);
      if (p) levels.push({ kind: "take_profit", price: p });
    }
    return levels;
  }

  async function runVerification() {
    const rows = await store.listCardsForVerification({ limit: 80 });
    for (const row of rows) {
      const card = archiveCardToClient(row);
      const sym = card.symbol;
      if (!sym) continue;
      const signalMs = cardSignalMs(row);
      const now = Date.now();
      const need3h = now - signalMs >= VERIFY_3H_MS && !card.verify3h;
      const need1m = now - signalMs >= VERIFY_1M_MS && !card.verify1m;
      if (!need3h && !need1m) continue;

      try {
        if (need3h) {
          const end = signalMs + VERIFY_3H_MS;
          const klines = await fetchFuturesKlines(sym, signalMs, end, "5m");
          const result = evaluatePricePath(card.execution, klines);
          const patch = {
            verify3hJson: {
              ...result,
              window: "3h",
              symbol: sym,
            },
          };
          if (result.outcome !== "pending") {
            patch.executionJson = {
              ...card.execution,
              outcome: result.outcome,
              outcomeNote: `自动校验(3h): ${result.outcome} @ ${result.hitLevel || "—"}`,
            };
          }
          await store.updateSignalCard(card.id, patch);
          log.info(`卡片 #${card.id} 3h 校验 outcome=${result.outcome}`);
        }
        if (need1m) {
          const end = signalMs + VERIFY_1M_MS;
          const klines = await fetchFuturesKlines(sym, signalMs, end, "1h");
          const result = evaluatePricePath(card.execution, klines);
          const patch = {
            verify1mJson: {
              ...result,
              window: "30d",
              symbol: sym,
            },
          };
          if (result.outcome !== "pending" && card.execution?.outcome === "pending") {
            patch.executionJson = {
              ...card.execution,
              outcome: result.outcome,
              outcomeNote: `自动校验(30d): ${result.outcome} @ ${result.hitLevel || "—"}`,
            };
          }
          await store.updateSignalCard(card.id, patch);
          log.info(`卡片 #${card.id} 30d 校验 outcome=${result.outcome}`);
        }
      } catch (e) {
        log.warn(`卡片 #${card.id} 价格校验失败: ${/** @type {Error} */ (e).message}`);
      }
    }
  }

  async function runProximityCheck() {
    const rows = await store.listActiveCardsForProximity({ limit: 200 });
    const band = config.cardProximityBandPct;
    /** @type {Map<string, number>} */
    const symbols = new Map();
    for (const row of rows) {
      const sym = String(row.symbol ?? "").trim();
      if (sym) symbols.set(sym, 1);
    }

    for (const sym of symbols.keys()) {
      try {
        const { price } = await fetchFuturesPrice(sym);
        priceCache.set(sym, price);
      } catch (e) {
        log.debug(`现价拉取失败 ${sym}: ${/** @type {Error} */ (e).message}`);
      }
    }

    for (const row of rows) {
      const card = archiveCardToClient(row);
      const sym = card.symbol;
      const price = priceCache.get(sym);
      if (!price || !sym) continue;

      const levels = collectLevels(card);
      let proximity = card.proximity && typeof card.proximity === "object" ? { ...card.proximity } : {};
      /** @type {Array<Record<string, unknown>>} */
      const alerts = [];

      for (const lv of levels) {
        const dist = distancePct(price, lv.price);
        const key = `${lv.kind}_${lv.price}`;
        const prev = proximity[key];
        const near = dist <= band;
        if (near) {
          const lastAlert = prev?.lastAlertAt ? new Date(String(prev.lastAlertAt)).getTime() : 0;
          const cooldown = config.cardProximityCooldownMs;
          if (Date.now() - lastAlert > cooldown) {
            alerts.push({
              kind: lv.kind,
              level: lv.price,
              distancePct: dist,
              currentPrice: price,
            });
            proximity[key] = { lastAlertAt: new Date().toISOString(), distancePct: dist, price };
          }
        } else if (prev) {
          proximity[key] = { ...prev, distancePct: dist, near: false };
        }
      }

      if (alerts.length) {
        await store.updateSignalCard(card.id, { proximityJson: proximity });
        const lines = alerts.map(
          (a) =>
            `· ${a.kind} ${a.level} 距离 ${Number(a.distancePct).toFixed(2)}% (现价 ${a.currentPrice})`
        );
        const text = [
          `📍 价格接近警报 · ${sym}`,
          `卡片 #${card.id} · 来源 ${card.sourceType}`,
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
          alerts,
        });

        if (config.cardProximityTelegram) {
          await systemTelegram.notify(text, { kind: "card_proximity" });
        }
        log.info(`接近推送 #${card.id} ${sym} alerts=${alerts.length}`);
      }
    }
  }

  async function tick() {
    await runVerification();
    await runProximityCheck();
  }

  function start() {
    if (timer) return;
    const ms = config.cardPriceMonitorIntervalMs;
    timer = setInterval(() => {
      void tick().catch((e) => log.warn(`价格监控 tick: ${/** @type {Error} */ (e).message}`));
    }, ms);
    void tick().catch((e) => log.warn(`价格监控首次: ${/** @type {Error} */ (e).message}`));
    log.info(`卡片价格监控已启动 interval=${ms}ms proximity=${config.cardProximityBandPct}%`);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, tick, runVerification, runProximityCheck };
}
