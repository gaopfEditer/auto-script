/**
 * Discord 信号频道配置：解析器、语言风格、Telegram 默认风格。
 */
import { config } from "./config.js";

/** @typedef {"binance_killers"|"btc_cn"|"streak_cn"|"tw_opg"|"dabiaoke"|"feiyang"|"fengge"|"yanchi"|"biquan_suozhang"|"unknown_trader"|"altcoin_king"|"junzhang"|"generic"} ParserKind */

/**
 * @typedef {{
 *   name: string;
 *   parser: ParserKind;
 *   styles: string[];
 *   telegramStyle: string;
 * }} SignalChannelConfig
 */

/** @type {Record<string, SignalChannelConfig>} */
export const DEFAULT_SIGNAL_CHANNELS = {
  "1444962339743989843": {
    name: "大镖客",
    parser: "dabiaoke",
    styles: ["cn_formal", "cn_brief"],
    telegramStyle: "cn_brief",
  },
  "1444962376066793513": {
    name: "淑琴",
    parser: "btc_cn",
    styles: ["cn_formal", "cn_brief", "tw_formal"],
    telegramStyle: "cn_brief",
  },
  "1444962410002911396": {
    name: "飞扬",
    parser: "feiyang",
    styles: ["cn_formal", "cn_brief"],
    telegramStyle: "cn_brief",
  },
  "1444962439471955989": {
    name: "三马",
    parser: "streak_cn",
    styles: ["cn_formal", "cn_brief", "tw_formal"],
    telegramStyle: "cn_brief",
  },
  "1444963372134301827": {
    name: "seven",
    parser: "tw_opg",
    styles: ["tw_formal", "cn_formal", "cn_brief"],
    telegramStyle: "tw_formal",
  },
  "1444963929393729686": {
    name: "峰哥",
    parser: "fengge",
    styles: ["cn_formal", "cn_brief"],
    telegramStyle: "cn_brief",
  },
  "1444963689194192947": {
    name: "颜驰",
    parser: "yanchi",
    styles: ["cn_formal", "cn_brief"],
    telegramStyle: "cn_brief",
  },
  "1444967547169669160": {
    name: "币安杀手",
    parser: "binance_killers",
    styles: ["cn_formal", "cn_brief", "en_brief"],
    telegramStyle: "cn_brief",
  },
  "1459861535815110810": {
    name: "unknown-trader",
    parser: "unknown_trader",
    styles: ["cn_formal", "cn_brief", "en_brief"],
    telegramStyle: "cn_brief",
  },
  "1444963506431463474": {
    name: "山寨之王",
    parser: "altcoin_king",
    styles: ["cn_formal", "cn_brief", "tw_formal"],
    telegramStyle: "cn_brief",
  },
  "1444963405185159238": {
    name: "币圈所长",
    parser: "biquan_suozhang",
    styles: ["cn_formal", "cn_brief"],
    telegramStyle: "cn_brief",
  },
  "1444963474718462085": {
    name: "军长",
    parser: "junzhang",
    styles: ["cn_formal", "cn_brief"],
    telegramStyle: "cn_brief",
  },
};

/** YouTube paste coin-action 卡片暂归颜驰（/signals 频道概览） */
export const COIN_ACTION_SIGNAL_CHANNEL_ID = "1444963689194192947";

/** @type {Record<string, { label: string, promptHint: string }>} */
export const SIGNAL_STYLE_META = {
  cn_formal: { label: "简体·正式", promptHint: "简体中文，正式完整，条理清晰" },
  cn_brief: { label: "简体·极简", promptHint: "简体中文，极简 Telegram 风格，≤80字" },
  tw_formal: { label: "繁体·正式", promptHint: "繁体中文，正式完整" },
  en_brief: { label: "English", promptHint: "Concise English for traders, ≤100 chars" },
};

/** @returns {Set<string>} */
export function getSignalChannelIds() {
  const fromEnv = config.discordSignalChannelIds;
  if (fromEnv.length) return new Set(fromEnv);
  return new Set(Object.keys(DEFAULT_SIGNAL_CHANNELS));
}

/** @param {string} channelId */
export function getSignalChannelConfig(channelId) {
  const id = String(channelId ?? "").trim();
  if (!id) return null;
  return DEFAULT_SIGNAL_CHANNELS[id] ?? null;
}

/** @param {string} channelId */
export function isSignalChannel(channelId) {
  return getSignalChannelIds().has(String(channelId ?? "").trim());
}

/** @param {string} channelId @returns {string} */
export function signalChannelDisplayName(channelId) {
  return getSignalChannelConfig(channelId)?.name ?? channelId;
}
