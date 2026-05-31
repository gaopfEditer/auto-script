/**
 * 频道最近 5 条文字去重（归一化后比较）。
 */
import { createHash } from "node:crypto";

/** @param {string} text */
export function normalizeSignalText(text) {
  return String(text ?? "")
    .replace(/\u200b/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** @param {string} text */
export function signalTextHash(text) {
  return createHash("sha256").update(normalizeSignalText(text)).digest("hex");
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 */
export function createChannelTextDedup(store) {
  /** @type {Map<string, string[]>} */
  const memory = new Map();
  const MAX = 5;

  async function hydrate() {
    const rows = await store.listChannelTextCaches();
    for (const row of rows) {
      const cid = String(row.channel_id ?? "");
      if (!cid) continue;
      let texts = row.recent_texts;
      if (typeof texts === "string") {
        try {
          texts = JSON.parse(texts);
        } catch {
          texts = [];
        }
      }
      if (Array.isArray(texts)) {
        memory.set(
          cid,
          texts.map((t) => normalizeSignalText(String(t))).filter(Boolean).slice(0, MAX)
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
    const norm = normalizeSignalText(text);
    if (!cid || !norm) return true;
    const recent = memory.get(cid) ?? [];
    return recent.some((t) => t === norm);
  }

  /**
   * @param {string} channelId
   * @param {string} text
   */
  async function remember(channelId, text) {
    const cid = String(channelId ?? "").trim();
    const norm = normalizeSignalText(text);
    if (!cid || !norm) return;
    const prev = memory.get(cid) ?? [];
    const next = [norm, ...prev.filter((t) => t !== norm)].slice(0, MAX);
    memory.set(cid, next);
    await store.upsertChannelTextCache(cid, next);
  }

  return { hydrate, isDuplicate, remember };
}
