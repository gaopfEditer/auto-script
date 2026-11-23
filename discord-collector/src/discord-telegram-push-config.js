/**
 * Discord 频道 → Telegram 推送配置。
 */
import { config } from "./config.js";
import { DEFAULT_SIGNAL_CHANNELS } from "./discord-signal-config.js";
import { getKolvipChannelMappings } from "./kolvip-cdp-config.js";
import { resolveKolvipChannelIdForShow } from "./kolvip-channel-catchup.js";
import { getKolvipEvalRankedChannelIds } from "./kolvip-eval-rank.js";
import { kolvipScanVirtualChannelId, parseKolvipScanVirtualChannelId } from "./kolvip-scan-config.js";
import {
  listKolvipAutotradeChannelIds,
  loadKolvipBitgetAutotrade,
} from "./kolvip-bitget-autotrade.js";

/** 默认推送频道（可被环境变量覆盖） */
export const DEFAULT_TELEGRAM_PUSH_CHANNEL_IDS = [
  "1444963689194192947", // 颜驰 · 🟢丨颜驰-vip
  "1444962439471955989", // 三马 · 🟢丨三马哥合约
  "1444962376066793513", // 淑琴 · 🟢丨舒琴行情分析
  "1444962339743989843", // 大镖客 · 🟢丨大镖客vip策略
  "1444963372134301827", // seven · 🟢丨seven内部策略
  "1459861535815110810", // unknown-trader · ⛳丨unknown-trader
  "1444967547169669160", // 币安杀手 · ⚜️｜币安杀手-vip
  "1444967575858581545", // 华尔街女王 · ⚜️｜华尔街女王-vip
];

/** 实时推送、不参与 2 分钟聚合的频道 */
export const DEFAULT_TELEGRAM_REALTIME_CHANNEL_IDS = [];

/** 大镖客信号频道：无法解析为卡片时，含特定关键词仍推 Telegram */
export const DABIAOKE_SIGNAL_CHANNEL_ID = "1444962339743989843"; // 大镖客

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

const KOLVIP_TOP10_DEFAULT_COUNT = 10;

/**
 * 巨鲸博主信号卡 TG 专群频道白名单。
 * 默认与 /eval 胜率榜同源（kolvip-sig，通常前 20），避免榜内 11–20 名（如胖猫）漏推。
 */
export function getKolvipTop10TelegramChannelIds() {
  const fromEnv = config.kolvipTop10TelegramChannelIds;
  if (fromEnv.length) return new Set(fromEnv.map(String));
  const ranked = getKolvipEvalRankedChannelIds();
  if (ranked.length) return new Set(ranked.map(String));
  const ids = new Set();
  const fromShow = config.discordShowSidebar?.channelIds ?? [];
  for (const id of fromShow.slice(0, KOLVIP_TOP10_DEFAULT_COUNT)) ids.add(String(id));
  for (const m of getKolvipChannelMappings()) {
    if (m.discordChannelId) ids.add(String(m.discordChannelId));
    ids.add(kolvipScanVirtualChannelId(m.kolvipChannelId));
  }
  if (loadKolvipBitgetAutotrade().enabled) {
    for (const cid of listKolvipAutotradeChannelIds()) {
      const id = String(cid ?? "").trim();
      if (!id) continue;
      ids.add(id);
      const kid =
        parseKolvipScanVirtualChannelId(id) || resolveKolvipChannelIdForShow(id);
      if (kid) {
        ids.add(kolvipScanVirtualChannelId(kid));
        for (const m of getKolvipChannelMappings()) {
          if (String(m.kolvipChannelId) === String(kid) && m.discordChannelId) {
            ids.add(String(m.discordChannelId));
          }
        }
      }
    }
  }
  return ids;
}

/** @param {string} channelId */
export function isKolvipTop10TelegramCardChannel(channelId) {
  const id = String(channelId ?? "").trim();
  if (!id) return false;
  const top = getKolvipTop10TelegramChannelIds();
  if (top.has(id)) return true;
  const scanKid = parseKolvipScanVirtualChannelId(id);
  if (!scanKid) return false;
  for (const showId of top) {
    if (resolveKolvipChannelIdForShow(showId) === scanKid) return true;
  }
  return false;
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
