#!/usr/bin/env node
/**
 * 按已入库信号卡回放 Bitget / WEEX 跟单（默认 WEEX 强制 dryRun，避免误实盘）。
 *
 *   node scripts/simulate-card-autotrade.mjs 3018
 *   node scripts/simulate-card-autotrade.mjs 3018 --weex-live   # 危险：WEEX 实盘
 */
import "../src/load-env.js";
import { config } from "../src/config.js";
import { openStore } from "../src/store.js";
import { createLogger } from "../src/logger.js";
import { createBitgetOrderService } from "../src/bitget-order-service.js";
import { createWeexOrderService } from "../src/weex-order-service.js";
import { signalCardToClient } from "../src/discord-signal-card-service.js";
import { loadWeexTradeConfig } from "../src/weex-trade-config.js";
import { loadBitgetTradeConfig } from "../src/bitget-trade-config.js";

const cardId = Number(process.argv[2] ?? 0);
const weexLive = process.argv.includes("--weex-live");
if (!Number.isFinite(cardId) || cardId <= 0) {
  console.error("用法: node scripts/simulate-card-autotrade.mjs <cardId>");
  process.exit(1);
}

const log = createLogger("simulate-autotrade");
const store = await openStore(config.mysql, log);
const bitget = createBitgetOrderService(store, log);
const weex = createWeexOrderService(store, log);

const row = await store.getSignalCardById(cardId);
if (!row) {
  console.error(`卡片 #${cardId} 不存在`);
  process.exit(1);
}
const card = signalCardToClient(row);
const parsed = card.parsedJson && typeof card.parsedJson === "object" ? card.parsedJson : {};
const executionJson = card.execution ?? parsed.execution ?? null;

const input = {
  cardId,
  channelId: card.channelId,
  channelName: "华尔街女王",
  parsed,
  executionJson,
  symbol: card.symbol ?? parsed.symbol,
};

const bgCfg = loadBitgetTradeConfig();
const wxCfg = loadWeexTradeConfig();

console.log(
  JSON.stringify(
    {
      cardId,
      uid: card.uid,
      channelId: card.channelId,
      symbol: input.symbol,
      direction: parsed.direction,
      entry: parsed.entry,
      stopLoss: parsed.stopLoss,
      takeProfits: parsed.takeProfits,
      bitget: { enabled: bgCfg.enabled, dryRun: bgCfg.dryRun },
      weex: { enabled: wxCfg.enabled, dryRun: weexLive ? wxCfg.dryRun : true, note: weexLive ? "按配置" : "本脚本强制 dryRun" },
    },
    null,
    2
  )
);

if (!weexLive) {
  process.env.WEEX_DRY_RUN = "1";
  process.env.BITGET_DRY_RUN = process.env.BITGET_DRY_RUN ?? "1";
  bitget.reloadConfig();
  weex.reloadConfig();
}

/** @type {Record<string, unknown>} */
const out = { cardId, results: {} };

try {
  out.results.bitget = await bitget.onSignalCardCreated(input);
} catch (e) {
  out.results.bitget = { error: String(/** @type {Error} */ (e).message ?? e) };
}

try {
  out.results.weex = await weex.onSignalCardCreated(input);
} catch (e) {
  out.results.weex = { error: String(/** @type {Error} */ (e).message ?? e) };
}

const refreshed = await store.getSignalCardById(cardId);
const pj = refreshed?.parsed_json ?? refreshed?.parsedJson;
let bitgetOrder = null;
let weexOrder = null;
if (pj && typeof pj === "object") {
  bitgetOrder = pj.bitgetOrder ?? null;
  weexOrder = pj.weexOrder ?? null;
} else if (typeof pj === "string") {
  try {
    const o = JSON.parse(pj);
    bitgetOrder = o.bitgetOrder;
    weexOrder = o.weexOrder;
  } catch {
    /* ignore */
  }
}

out.parsedOrders = { bitgetOrder, weexOrder };
console.log(JSON.stringify(out, null, 2));

try {
  await store.close?.();
} catch {
  /* ignore */
}