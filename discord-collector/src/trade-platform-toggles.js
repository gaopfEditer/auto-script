/**
 * 交易平台开关：Debug 页 localStorage 同步到服务端，信号建卡时决定是否向 Bitget / WEEX 下单。
 * 频道白名单（并集，任一命中即可下单）：
 * - Discord：`BITGET_AUTO_TRADE_CHANNEL_IDS` + `config/kolvip-autotrade.json`（enabled 时）
 * - Telegram：`telegram/channel_profiles.json` 的 `placeAnOrder`（`-100…` 字符串全等）
 * 平台开关：`.env` 的 `BITGET_ENABLED` / `WEEX_ENABLED` + Debug 页 bitget/weex 勾选。
 * `send` 只控制转发/CDP。主流币种 BTC/ETH 不参与自动交易。
 */
import { config } from "./config.js";
import { detectSymbolTier } from "./card-backtest-policy.js";
import {
  isTelegramGroupChatId,
  readTelegramChannelProfiles,
  telegramChatIdInExactList,
} from "./telegram-channel-profiles.js";
import { isTelegramAutoTradeChannel } from "./telegram-auto-trade.js";
import {
  listKolvipAutotradeChannelIds,
  loadKolvipBitgetAutotrade,
} from "./kolvip-bitget-autotrade.js";
import { isKolvipHistoricalIngestSource } from "./discord-signal-card-source.js";

/** @typedef {{ bitget: boolean; weex: boolean }} TradePlatformToggles */

/** @type {TradePlatformToggles} */
let toggles = { bitget: true, weex: true };

/** @type {number} 单笔保证金 USDT（Telegram 自动开单与 Debug 模拟共用，默认 2） */
let orderSizeUsdt = 2;

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

/**
 * @typedef {{
 *   profilesFile?: string,
 *   placeAnOrderIds?: readonly unknown[],
 *   discordChannelIds?: readonly unknown[],
 * }} AutoTradeChannelOverride
 */

/**
 * Discord 雪花白名单 + Telegram placeAnOrder。环境变量里的 `-100…` 群 id 会被丢掉，避免误当成 Telegram 白名单。
 * @param {AutoTradeChannelOverride} [override]
 * @returns {string[]}
 */
export function getAutoTradeChannelIds(override) {
  const envIds = override?.discordChannelIds ?? config.bitgetAutoTradeChannelIds;
  /** @type {string[]} */
  const out = [];
  for (const raw of envIds) {
    const id = String(raw ?? "").trim();
    if (!id || isTelegramGroupChatId(id) || out.includes(id)) continue;
    out.push(id);
  }
  const placeIds = Array.isArray(override?.placeAnOrderIds)
    ? override.placeAnOrderIds
    : readTelegramChannelProfiles(override?.profilesFile).placeAnOrderChatIds;
  for (const raw of placeIds) {
    const id = String(raw ?? "").trim();
    if (!id || out.includes(id)) continue;
    out.push(id);
  }
  const kolvip = loadKolvipBitgetAutotrade();
  if (kolvip.enabled) {
    for (const id of listKolvipAutotradeChannelIds()) {
      const cid = String(id ?? "").trim();
      if (!cid || out.includes(cid)) continue;
      out.push(cid);
    }
  }
  return out;
}

/**
 * Discord 雪花频道：BITGET_AUTO_TRADE_CHANNEL_IDS 与 kolvip-autotrade.json（enabled 时）并集。
 * @param {string} cid
 * @param {AutoTradeChannelOverride} [override]
 */
function isDiscordAutoTradeChannel(cid, override) {
  const ids = override?.discordChannelIds ?? config.bitgetAutoTradeChannelIds;
  if (ids.some((id) => String(id ?? "").trim() === cid)) return true;
  const kolvip = loadKolvipBitgetAutotrade();
  if (!kolvip.enabled) return false;
  const want = new Set(listKolvipAutotradeChannelIds().map(String));
  return want.has(cid);
}

/**
 * Telegram 群只看 placeAnOrder。Discord 另读 kolvip-autotrade.json，不单靠 BITGET_AUTO_TRADE_CHANNEL_IDS。
 * @param {string} channelId
 * @param {AutoTradeChannelOverride} [override]
 */
export function isAutoTradeChannel(channelId, override) {
  const cid = String(channelId ?? "").trim();
  if (!cid) return false;
  if (isTelegramGroupChatId(cid)) {
    if (Array.isArray(override?.placeAnOrderIds)) {
      return telegramChatIdInExactList(cid, override.placeAnOrderIds);
    }
    return isTelegramAutoTradeChannel(cid, override?.profilesFile);
  }
  return isDiscordAutoTradeChannel(cid, override);
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
 * @param {{ tradePlatforms?: Partial<TradePlatformToggles> } & AutoTradeChannelOverride} [opts]
 */
export function shouldPushToTradePlatform(platform, channelId, opts) {
  if (isKolvipHistoricalIngestSource(opts?.source)) return false;
  if (
    !isAutoTradeChannel(channelId, {
      profilesFile: opts?.profilesFile,
      discordChannelIds: opts?.discordChannelIds,
      placeAnOrderIds: opts?.placeAnOrderIds,
    })
  ) {
    return false;
  }
  if (platform === "bitget" && !config.bitgetEnabled) return false;
  if (platform === "weex" && !config.weexEnabled) return false;
  const p = resolveTradePlatforms(opts);
  return platform === "bitget" ? p.bitget : p.weex;
}
