/**
 * 需要对 Discord 附件图片做 OCR 的信号频道（非全局）。
 */
import { config } from "./config.js";

/** 胖猫社区（与 DEFAULT_SIGNAL_CHANNELS 一致） */
export const PANGMAO_SIGNAL_CHANNEL_ID = "1562351038277619783";

/** env 未配置 DISCORD_SIGNAL_OCR_CHANNEL_IDS 时的默认列表 */
export const DEFAULT_DISCORD_SIGNAL_OCR_CHANNEL_IDS = [PANGMAO_SIGNAL_CHANNEL_ID];

/** @returns {Set<string>} */
export function getDiscordSignalOcrChannelIds() {
  const fromEnv = config.discordSignalOcrChannelIds;
  if (Array.isArray(fromEnv) && fromEnv.length > 0) return new Set(fromEnv);
  return new Set(DEFAULT_DISCORD_SIGNAL_OCR_CHANNEL_IDS);
}

/** @param {string} channelId */
export function isDiscordSignalOcrChannel(channelId) {
  const id = String(channelId ?? "").trim();
  return id.length > 0 && getDiscordSignalOcrChannelIds().has(id);
}
