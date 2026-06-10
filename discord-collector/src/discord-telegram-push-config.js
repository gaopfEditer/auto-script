/**
 * Discord 频道 → Telegram 推送配置。
 */
import { config } from "./config.js";
import { DEFAULT_SIGNAL_CHANNELS } from "./discord-signal-config.js";

/** 默认推送频道（可被环境变量覆盖） */
export const DEFAULT_TELEGRAM_PUSH_CHANNEL_IDS = [
  "1444963689194192947",
  "1444962439471955989",
  "1444962376066793513",
  "1444962339743989843",
  "1444963372134301827",
  "1459861535815110810",
  "1444967547169669160",
  "1444967575858581545",
];

/** 实时推送、不参与 2 分钟聚合的频道 */
export const DEFAULT_TELEGRAM_REALTIME_CHANNEL_IDS = [];

/** @returns {Set<string>} */
export function getTelegramPushChannelIds() {
  const fromEnv = config.discordTelegramPushChannelIds;
  const ids = fromEnv.length ? fromEnv : DEFAULT_TELEGRAM_PUSH_CHANNEL_IDS;
  return new Set(ids.map(String));
}

/** @returns {Set<string>} */
export function getTelegramRealtimeChannelIds() {
  const fromEnv = config.discordTelegramRealtimeChannelIds;
  const ids = fromEnv.length ? fromEnv : DEFAULT_TELEGRAM_REALTIME_CHANNEL_IDS;
  return new Set(ids.map(String));
}

/** @param {string} channelId */
export function isTelegramPushChannel(channelId) {
  return getTelegramPushChannelIds().has(String(channelId ?? "").trim());
}

/** @param {string} channelId */
export function isTelegramRealtimeChannel(channelId) {
  return getTelegramRealtimeChannelIds().has(String(channelId ?? "").trim());
}

/** @param {string} channelId @param {string} [fallbackName] */
export function telegramPushChannelLabel(channelId, fallbackName = "") {
  const id = String(channelId ?? "").trim();
  const fromSignal = DEFAULT_SIGNAL_CHANNELS[id]?.name;
  if (fromSignal) return fromSignal;
  const fb = String(fallbackName ?? "").trim();
  if (fb) return fb;
  return id ? `#${id.slice(-6)}` : "频道";
}

/**
 * @param {string} text
 * @param {string} [channelId]
 * @param {string} [fallbackName]
 */
export function formatTelegramWithChannelLabel(text, channelId, fallbackName = "") {
  const body = String(text ?? "").trim();
  if (!body) return "";
  const id = String(channelId ?? "").trim();
  if (!id) return body;
  const label = telegramPushChannelLabel(id, fallbackName);
  if (!label || body.startsWith(`【${label}】`)) return body;
  return `【${label}】\n${body}`;
}
