/**
 * 交易平台开关：Debug 页 localStorage 同步到服务端，信号建卡时决定是否向 Bitget / WEEX 下单。
 * 频道白名单以 BITGET_AUTO_TRADE_CHANNEL_IDS 为准（必须配置）。
 */
import { config } from "./config.js";

/** @typedef {{ bitget: boolean; weex: boolean }} TradePlatformToggles */

/** @type {TradePlatformToggles} */
let toggles = { bitget: true, weex: true };

/** @returns {string[]} */
export function getAutoTradeChannelIds() {
  return [...config.bitgetAutoTradeChannelIds];
}

/** @param {string} channelId */
export function isAutoTradeChannel(channelId) {
  const ids = config.bitgetAutoTradeChannelIds;
  const cid = String(channelId ?? "").trim();
  if (!cid || !ids.length) return false;
  return ids.includes(cid);
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
