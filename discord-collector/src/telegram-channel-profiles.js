/**
 * 读取 telegram/channel_profiles.json。
 * `send` 为 CDP 发布白名单（来源群 id），不是频道条目。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TELEGRAM_DIR = path.resolve(__dirname, "..", "..", "telegram");
export const CHANNEL_PROFILES_FILE = path.join(TELEGRAM_DIR, "channel_profiles.json");

/** @type {ReadonlySet<string>} */
export const CHANNEL_PROFILE_RESERVED_KEYS = new Set(["send"]);

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

/** @param {unknown} raw */
function isChannelProfileEntry(raw) {
  return raw != null && typeof raw === "object" && !Array.isArray(raw);
}

/**
 * @returns {{
 *   ok: boolean,
 *   file: string,
 *   error?: string,
 *   sendChatIds: string[],
 *   sendSet: Set<string>,
 *   channels: Array<{ chatId: string, name: string, avatar: string, main: string }>,
 * }}
 */
export function readTelegramChannelProfiles() {
  /** @type {string[]} */
  const sendChatIds = [];
  /** @type {Array<{ chatId: string, name: string, avatar: string, main: string }>} */
  const channels = [];
  try {
    if (!fs.existsSync(CHANNEL_PROFILES_FILE)) {
      return {
        ok: false,
        file: CHANNEL_PROFILES_FILE,
        error: "channel_profiles.json 不存在",
        sendChatIds,
        sendSet: new Set(),
        channels,
      };
    }
    const raw = JSON.parse(fs.readFileSync(CHANNEL_PROFILES_FILE, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return {
        ok: false,
        file: CHANNEL_PROFILES_FILE,
        error: "profiles 格式无效",
        sendChatIds,
        sendSet: new Set(),
        channels,
      };
    }

    const sendRaw = /** @type {unknown} */ (raw.send);
    if (Array.isArray(sendRaw)) {
      const seen = new Set();
      for (const item of sendRaw) {
        const id = normalizeTelegramChatIdKey(item);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        sendChatIds.push(id);
      }
    }

    for (const [chatId, meta] of Object.entries(raw)) {
      if (CHANNEL_PROFILE_RESERVED_KEYS.has(chatId)) continue;
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

    const sendSet = new Set(sendChatIds);
    return { ok: true, file: CHANNEL_PROFILES_FILE, sendChatIds, sendSet, channels };
  } catch (e) {
    return {
      ok: false,
      file: CHANNEL_PROFILES_FILE,
      error: String(/** @type {Error} */ (e).message ?? e),
      sendChatIds,
      sendSet: new Set(),
      channels,
    };
  }
}

/**
 * channel_profiles.json `send` 白名单 + 频道名称（Debug / 自动开单展示）。
 * @returns {Array<{ id: string; name: string }>}
 */
export function listTelegramSendChannelsWithNames() {
  const { sendChatIds, channels } = readTelegramChannelProfiles();
  return sendChatIds.map((id) => {
    const meta = channels.find((c) => telegramChatIdsMatch(c.chatId, id));
    return { id, name: String(meta?.name ?? id).trim() || id };
  });
}

/** @param {unknown} chatId */
export function isCdpSendChannel(chatId) {
  const { sendChatIds, sendSet } = readTelegramChannelProfiles();
  if (!sendChatIds.length) return false;
  const id = normalizeTelegramChatIdKey(chatId);
  if (!id) return false;
  if (sendSet.has(id)) return true;
  for (const sid of sendChatIds) {
    if (telegramChatIdsMatch(sid, id)) return true;
  }
  return false;
}
