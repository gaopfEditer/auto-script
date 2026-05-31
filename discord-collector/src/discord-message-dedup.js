/**
 * 频道消息正文去重：每频道保留最近 3 条指纹。
 * - 少于 500 字：归一化全文作为指纹
 * - 超过 300 字：前 30 + 中间 30 + 后 30
 */
import { normalizeSignalText } from "./discord-signal-dedup.js";

/** 每频道缓存条数 */
export const MESSAGE_DEDUP_MAX = 3;
/** 低于此长度存全文 */
export const MESSAGE_DEDUP_FULL_MAX_LEN = 500;
/** 高于此长度用分段指纹（且 >= 500 时必用指纹） */
export const MESSAGE_DEDUP_FINGERPRINT_MIN_LEN = 300;

/**
 * 长文分段指纹（前 30 + 中间 30 + 后 30）。
 * @param {string} text
 */
export function messageDedupFingerprint(text) {
  const s = normalizeSignalText(text);
  if (!s) return "";
  if (s.length <= MESSAGE_DEDUP_FINGERPRINT_MIN_LEN) return s;
  const n = s.length;
  const midStart = Math.max(0, Math.floor((n - 30) / 2));
  return `${s.slice(0, 30)}|${s.slice(midStart, midStart + 30)}|${s.slice(-30)}`;
}

/**
 * 去重键：短消息全文，长消息分段指纹。
 * @param {string} text
 */
export function messageDedupKey(text) {
  const s = normalizeSignalText(text);
  if (!s) return "";
  if (s.length < MESSAGE_DEDUP_FULL_MAX_LEN) return s;
  return messageDedupFingerprint(s);
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 */
export function createChannelMessageDedup(store) {
  /** @type {Map<string, string[]>} */
  const memory = new Map();

  async function hydrate() {
    const rows = await store.listChannelMessageDedupCaches();
    for (const row of rows) {
      const cid = String(row.channel_id ?? "");
      if (!cid) continue;
      let keys = row.recent_keys;
      if (typeof keys === "string") {
        try {
          keys = JSON.parse(keys);
        } catch {
          keys = [];
        }
      }
      if (Array.isArray(keys)) {
        memory.set(
          cid,
          keys.map((k) => String(k)).filter(Boolean).slice(0, MESSAGE_DEDUP_MAX)
        );
      }
    }
  }

  /**
   * @param {string} channelId
   * @param {string} text
   */
  function isDuplicate(channelId, text) {
    const cid = String(channelId ?? "").trim();
    const key = messageDedupKey(text);
    if (!cid || !key) return false;
    const recent = memory.get(cid) ?? [];
    return recent.includes(key);
  }

  /**
   * @param {string} channelId
   * @param {string} text
   */
  async function remember(channelId, text) {
    const cid = String(channelId ?? "").trim();
    const key = messageDedupKey(text);
    if (!cid || !key) return;
    const prev = memory.get(cid) ?? [];
    const next = [key, ...prev.filter((k) => k !== key)].slice(0, MESSAGE_DEDUP_MAX);
    memory.set(cid, next);
    await store.upsertChannelMessageDedupCache(cid, next);
  }

  return { hydrate, isDuplicate, remember, messageDedupKey };
}
