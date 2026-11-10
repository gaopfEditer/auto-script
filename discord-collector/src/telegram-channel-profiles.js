/**
 * 读取 telegram/channel_profiles.json。
 * `send` 为 CDP / 转发白名单（来源群 id），不是频道条目，也不能单独授权下单。
 * `placeAnOrder` 为 Telegram 群 Bitget/WEEX 自动下单白名单（保留 `-100…` 前缀的字符串）。
 * Discord 雪花频道白名单是 BITGET_AUTO_TRADE_CHANNEL_IDS，与这里的群 id 无关。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TELEGRAM_DIR = path.resolve(__dirname, "..", "..", "telegram");
export const CHANNEL_PROFILES_FILE = path.join(TELEGRAM_DIR, "channel_profiles.json");

/** @type {ReadonlySet<string>} */
export const CHANNEL_PROFILE_RESERVED_KEYS = new Set(["send", "placeAnOrder"]);

/** @param {string} chatId */
export function normalizeTelegramChatIdKey(chatId) {
  const s = String(chatId ?? "").trim();
  if (!s) return "";
  if (s.startsWith("-")) return s;
  const n = Number(s);
  if (Number.isFinite(n) && n < 0) return String(n);
  return s;
}

/** @param {string} a @param {string} b */
export function telegramChatIdsMatch(a, b) {
  const x = normalizeTelegramChatIdKey(a);
  const y = normalizeTelegramChatIdKey(b);
  if (!x || !y) return false;
  if (x === y) return true;
  return x.replace(/^-/, "") === y.replace(/^-/, "");
}

/**
 * 保留调用方写下的 id 文本（含前导 `-100`）。不把负号或 `100` 前缀剥掉。
 * @param {unknown} raw
 * @returns {string}
 */
export function exactTelegramChatId(raw) {
  if (typeof raw === "string") return raw.trim();
  if (typeof raw === "bigint") return raw.toString();
  if (typeof raw === "number" && Number.isSafeInteger(raw)) return String(raw);
  return "";
}

/**
 * Bot API 超群 / 频道 id（`-100…`）以及其它负的 Telegram chat id。
 * Discord 雪花是正整数字符串，不会命中。
 * @param {unknown} chatId
 */
export function isTelegramGroupChatId(chatId) {
  return /^-\d{5,22}$/.test(exactTelegramChatId(chatId));
}

/**
 * 逐字相等。`-1001720924085` 不等于 `1001720924085`，也不等于 `-1720924085`。
 * @param {unknown} chatId
 * @param {readonly unknown[]} ids
 */
export function telegramChatIdInExactList(chatId, ids) {
  const id = exactTelegramChatId(chatId);
  if (!id) return false;
  for (const raw of ids) {
    const other = exactTelegramChatId(raw);
    if (other && other === id) return true;
  }
  return false;
}

/**
 * @param {unknown} raw
 * @param {"send"|"exact"} mode
 * @returns {string[]}
 */
function parseChatIdList(raw, mode) {
  if (!Array.isArray(raw)) return [];
  /** @type {Set<string>} */
  const seen = new Set();
  /** @type {string[]} */
  const out = [];
  for (const item of raw) {
    const id = mode === "exact" ? exactTelegramChatId(item) : normalizeTelegramChatIdKey(item);
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  return out;
}

/** @param {unknown} raw */
function isChannelProfileEntry(raw) {
  return raw != null && typeof raw === "object" && !Array.isArray(raw);
}

/**
 * @param {string} [profilesFile]
 * @returns {{
 *   ok: boolean,
 *   file: string,
 *   error?: string,
 *   sendChatIds: string[],
 *   sendSet: Set<string>,
 *   placeAnOrderChatIds: string[],
 *   placeAnOrderSet: Set<string>,
 *   channels: Array<{ chatId: string, name: string, avatar: string, main: string }>,
 * }}
 */
export function readTelegramChannelProfiles(profilesFile = CHANNEL_PROFILES_FILE) {
  const file = String(profilesFile || CHANNEL_PROFILES_FILE);
  /** @type {Array<{ chatId: string, name: string, avatar: string, main: string }>} */
  const channels = [];
  /** @param {string} error */
  const fail = (error) => ({
    ok: false,
    file,
    error,
    sendChatIds: /** @type {string[]} */ ([]),
    sendSet: new Set(),
    placeAnOrderChatIds: /** @type {string[]} */ ([]),
    placeAnOrderSet: new Set(),
    channels,
  });
  try {
    if (!fs.existsSync(file)) return fail("channel_profiles.json 不存在");
    const raw = JSON.parse(fs.readFileSync(file, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail("profiles 格式无效");

    const sendChatIds = parseChatIdList(/** @type {Record<string, unknown>} */ (raw).send, "send");
    const placeAnOrderChatIds = parseChatIdList(
      /** @type {Record<string, unknown>} */ (raw).placeAnOrder,
      "exact"
    );

    for (const [chatId, meta] of Object.entries(raw)) {
      if (CHANNEL_PROFILE_RESERVED_KEYS.has(chatId)) continue;
      if (chatId.startsWith("_comment")) continue;
      if (!isChannelProfileEntry(meta)) continue;
      const id = normalizeTelegramChatIdKey(chatId);
      if (!id || !/^-?\d{5,22}$/.test(id)) continue;
      const m = /** @type {Record<string, unknown>} */ (meta);
      channels.push({
        chatId: id,
        name: String(m.name ?? m.channelName ?? id).trim() || id,
        avatar: String(m.avatar ?? m.channelAvatar ?? "").trim(),
        main: String(m.main ?? m.mainSenders ?? "").trim(),
      });
    }

    return {
      ok: true,
      file,
      sendChatIds,
      sendSet: new Set(sendChatIds),
      placeAnOrderChatIds,
      placeAnOrderSet: new Set(placeAnOrderChatIds),
      channels,
    };
  } catch (e) {
    return fail(String(/** @type {Error} */ (e).message ?? e));
  }
}

/**
 * channel_profiles.json `send` 白名单 + 频道名称（转发 / CDP，不是下单白名单）。
 * @param {string} [profilesFile]
 * @returns {Array<{ id: string; name: string }>}
 */
export function listTelegramSendChannelsWithNames(profilesFile) {
  const { sendChatIds, channels } = readTelegramChannelProfiles(profilesFile);
  return sendChatIds.map((id) => {
    const meta = channels.find((c) => telegramChatIdsMatch(c.chatId, id));
    return { id, name: String(meta?.name ?? id).trim() || id };
  });
}

/**
 * `placeAnOrder` 白名单 + 频道名称。id 与配置逐字相同（含 `-100`）。
 * @param {string} [profilesFile]
 * @returns {Array<{ id: string; name: string }>}
 */
export function listTelegramPlaceAnOrderChannelsWithNames(profilesFile) {
  const { placeAnOrderChatIds, channels } = readTelegramChannelProfiles(profilesFile);
  return placeAnOrderChatIds.map((id) => {
    const meta = channels.find((c) => c.chatId === id);
    return { id, name: String(meta?.name ?? id).trim() || id };
  });
}

/**
 * @param {unknown} chatId
 * @param {string} [profilesFile]
 */
export function isCdpSendChannel(chatId, profilesFile) {
  const { sendChatIds, sendSet } = readTelegramChannelProfiles(profilesFile);
  if (!sendChatIds.length) return false;
  const id = normalizeTelegramChatIdKey(chatId);
  if (!id) return false;
  if (sendSet.has(id)) return true;
  for (const sid of sendChatIds) {
    if (telegramChatIdsMatch(sid, id)) return true;
  }
  return false;
}

/**
 * Telegram 自动下单白名单。只做字符串全等，不把 `-100` 前缀收成裸 id。
 * @param {unknown} chatId
 * @param {string} [profilesFile]
 */
export function isPlaceAnOrderChannel(chatId, profilesFile) {
  const { placeAnOrderChatIds } = readTelegramChannelProfiles(profilesFile);
  return telegramChatIdInExactList(chatId, placeAnOrderChatIds);
}
