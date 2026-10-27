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

/** 大镖客信号频道：无法解析为卡片时，含特定关键词仍推 Telegram */
export const DABIAOKE_SIGNAL_CHANNEL_ID = "1444962339743989843";

/**
 * @param {string} channelId
 * @param {unknown} content
 */
export function shouldTelegramPushSignalChannelComment(channelId, content) {
  const cid = String(channelId ?? "").trim();
  const text = String(content ?? "").trim();
  if (cid !== DABIAOKE_SIGNAL_CHANNEL_ID || !text) return false;
  return /时间太久/.test(text);
}

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

/** Telegram 句柄：字母开头 + 4–31 位字母数字下划线 */
const TG_USER_IN_PARENS = String.raw`@?[A-Za-z][A-Za-z0-9_]{4,31}`;

/**
 * 去掉文案中的 Telegram 用户名括号标记。
 *
 * 半角：(hysqxx) / (@hysqxx)；全角：（hysqxx）/（@hysqxx）
 *
 * @param {string} text
 */
export function stripTelegramAtUsernameMentions(text) {
  return String(text ?? "")
    .replace(new RegExp(String.raw`\s*\(${TG_USER_IN_PARENS}\)`, "g"), "")
    .replace(new RegExp(String.raw`\s*（${TG_USER_IN_PARENS}）`, "g"), "")
    .replace(/【([^】]*?)】/g, (_, inner) => `【${inner.replace(/\s{2,}/g, " ").trim()}】`)
    .replace(/[ \t]{2,}/g, " ")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

/**
 * 判断消息是否疑似"引导私聊/转账"类垃圾内容，
 * 这类消息不应推送到 Telegram。
 *
 * 典型特征：
 *   - 带 Telegram 句柄 (@username) 的用户名标记
 *   - 包含"私信"、"进群"、"DM"、"无任何资金往来" 等引导词
 *
 * @param {string} text
 * @returns {boolean} true = 疑似垃圾，应过滤
 */
export function isSpamMessage(text) {
  const t = String(text ?? "");
  // 全角/半角括号用户名标记（任意位置出现）
  if (/\([（]?@[A-Za-z][A-Za-z0-9_]{4,31}[）]?\)/.test(t)) {
    // 若同时含引导词 → 垃圾
    if (/私信|DM|进.*群|无.*资金|跟我|带单|开户|入群/.test(t)) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} text
 * @param {string} [channelId]
 * @param {string} [fallbackName]
 */
export function formatTelegramWithChannelLabel(text, channelId, fallbackName = "") {
  let body = stripTelegramAtUsernameMentions(String(text ?? "").trim());
  if (!body) return "";
  const id = String(channelId ?? "").trim();
  if (!id) return body;
  const label = stripTelegramAtUsernameMentions(
    telegramPushChannelLabel(id, fallbackName),
  );
  if (!label) return body;

  const headerRe = /^【([^】]+)】\s*\n?/;
  const headerMatch = body.match(headerRe);
  if (headerMatch) {
    const inner = stripTelegramAtUsernameMentions(headerMatch[1].trim());
    if (inner === label) {
      const rest = body.slice(headerMatch[0].length).trimStart();
      return rest ? `【${label}】\n${rest}` : `【${label}】`;
    }
  }

  if (body.startsWith(`【${label}】`)) return body;
  return `【${label}】\n${body}`;
}
