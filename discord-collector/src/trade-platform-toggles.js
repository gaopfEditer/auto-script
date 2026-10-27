/**
 * 交易平台开关：Debug 页 localStorage 同步到服务端，信号建卡时决定是否向 Bitget / WEEX 下单。
 * 频道白名单：BITGET_AUTO_TRADE_CHANNEL_IDS（Discord）+ telegram/channel_profiles.json `send`（Telegram 来源群）。
 * 主流币种 BTC/ETH 不参与自动交易。
 */
import { config } from "./config.js";
import { detectSymbolTier } from "./card-backtest-policy.js";
import { readTelegramChannelProfiles } from "./telegram-channel-profiles.js";
import { isTelegramAutoTradeChannel } from "./telegram-auto-trade.js";

/** @typedef {{ bitget: boolean; weex: boolean }} TradePlatformToggles */

/** @type {TradePlatformToggles} */
let toggles = { bitget: true, weex: true };

/** @type {number} 单笔保证金 USDT（Telegram 自动开单与 Debug 模拟共用，默认 1） */
let orderSizeUsdt = 1;

/** @returns {number} */
export function getTradeOrderSizeUsdt() {
  return orderSizeUsdt;
}

/** @param {unknown} v @returns {number} */
export function setTradeOrderSizeUsdt(v) {
  const n = Number(v);
  if (Number.isFinite(n) && n > 0) orderSizeUsdt = n;
  return orderSizeUsdt;
}

/** @returns {string[]} */
export function getAutoTradeChannelIds() {
  const discord = [...config.bitgetAutoTradeChannelIds];
  const { sendChatIds } = readTelegramChannelProfiles();
  const out = [...discord];
  for (const id of sendChatIds) {
    if (!out.includes(id)) out.push(id);
  }
  return out;
}

/** @param {string} channelId */
export function isAutoTradeChannel(channelId) {
  const cid = String(channelId ?? "").trim();
  if (!cid) return false;
  if (isTelegramAutoTradeChannel(cid)) return true;
  const ids = config.bitgetAutoTradeChannelIds;
  if (!ids.length) return false;
  return ids.includes(cid);
}

/**
 * 自动交易排除主流币（BTC/ETH）；山寨才下单。
 * @param {unknown} symbol
 */
export function isAutoTradeExcludedMajorSymbol(symbol) {
  return detectSymbolTier(symbol) === "major";
}

/** @returns {TradePlatformToggles} */
export function getTradePlatformToggles() {
  return { ...toggles };
}

/**
 * @param {{ bitget?: boolean; weex?: boolean }} partial
 * @returns {TradePlatformToggles}
 */
export function setTradePlatformToggles(partial) {
  if (typeof partial.bitget === "boolean") toggles.bitget = partial.bitget;
  if (typeof partial.weex === "boolean") toggles.weex = partial.weex;
  return getTradePlatformToggles();
}

/**
 * @param {{ tradePlatforms?: Partial<TradePlatformToggles> }} [opts]
 * @returns {TradePlatformToggles}
 */
export function resolveTradePlatforms(opts) {
  const server = getTradePlatformToggles();
  const fromOpts = opts?.tradePlatforms;
  return {
    bitget: typeof fromOpts?.bitget === "boolean" ? fromOpts.bitget : server.bitget,
    weex: typeof fromOpts?.weex === "boolean" ? fromOpts.weex : server.weex,
  };
}

/**
 * @param {"bitget"|"weex"} platform
 * @param {string} channelId
 * @param {{ tradePlatforms?: Partial<TradePlatformToggles> }} [opts]
 */
export function shouldPushToTradePlatform(platform, channelId, opts) {
  if (!isAutoTradeChannel(channelId)) return false;
  const p = resolveTradePlatforms(opts);
  return platform === "bitget" ? p.bitget : p.weex;
}
