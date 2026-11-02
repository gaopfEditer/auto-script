/**
 * OCR 开仓指纹去重：同频道 N 分钟内相同 币对+方向+开仓价 不再出卡。
 */
import { config } from "./config.js";

/**
 * @param {number} [windowMs]
 */
export function createOcrSignalFingerprintDedup(windowMs = config.discordSignalOcrDedupWindowMs) {
  /** @type {Map<string, Array<{ fingerprint: string; atMs: number }>>} */
  const memory = new Map();
  const win = Math.max(60_000, Number(windowMs) || 5 * 60_000);

  function prune(channelId, nowMs) {
    const cid = String(channelId ?? "").trim();
    const list = memory.get(cid) ?? [];
    const kept = list.filter((x) => nowMs - x.atMs <= win);
    if (kept.length) memory.set(cid, kept);
    else memory.delete(cid);
  }

  /**
   * @param {string} channelId
   * @param {string} fingerprint
   * @param {number} [nowMs]
   */
  function isDuplicate(channelId, fingerprint, nowMs = Date.now()) {
    const cid = String(channelId ?? "").trim();
    const fp = String(fingerprint ?? "").trim();
    if (!cid || !fp) return false;
    prune(cid, nowMs);
    const list = memory.get(cid) ?? [];
    return list.some((x) => x.fingerprint === fp);
  }

  /**
   * @param {string} channelId
   * @param {string} fingerprint
   * @param {number} [nowMs]
   */
  function remember(channelId, fingerprint, nowMs = Date.now()) {
    const cid = String(channelId ?? "").trim();
    const fp = String(fingerprint ?? "").trim();
    if (!cid || !fp) return;
    prune(cid, nowMs);
    const prev = memory.get(cid) ?? [];
    memory.set(cid, [{ fingerprint: fp, atMs: nowMs }, ...prev.filter((x) => x.fingerprint !== fp)].slice(0, 32));
  }

  function clearForTests() {
    memory.clear();
  }

  return { isDuplicate, remember, clearForTests };
}
