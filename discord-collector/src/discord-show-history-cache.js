/**
 * Show 频道历史 CDP 预热缓存：多前端共享 MySQL 元数据，避免每个浏览器都驱动 CDP 上滚。
 */

/** @param {string | number | null | undefined} a @param {string | number | null | undefined} b */
export function compareDiscordSnowflake(a, b) {
  try {
    const ba = BigInt(String(a ?? "0").trim() || "0");
    const bb = BigInt(String(b ?? "0").trim() || "0");
    if (ba < bb) return -1;
    if (ba > bb) return 1;
    return 0;
  } catch {
    return 0;
  }
}

/**
 * @param {{ warmedAtMs?: number, oldestMessageId?: string | null }} cache
 * @param {{ ttlMs: number, beforeMessageId?: string }} opts
 */
export function isChannelShowHistoryFresh(cache, opts) {
  const warmedAtMs = Number(cache?.warmedAtMs ?? 0);
  if (!Number.isFinite(warmedAtMs) || warmedAtMs <= 0) return false;
  if (Date.now() - warmedAtMs > opts.ttlMs) return false;

  const before = String(opts.beforeMessageId ?? "").trim();
  const oldestSynced = String(cache?.oldestMessageId ?? "").trim();
  if (!before) return true;
  if (!oldestSynced) return false;
  return compareDiscordSnowflake(oldestSynced, before) <= 0;
}

/**
 * @param {string | null | undefined} a
 * @param {string | null | undefined} b
 */
export function minDiscordSnowflakeId(a, b) {
  const sa = String(a ?? "").trim();
  const sb = String(b ?? "").trim();
  if (!sa) return sb;
  if (!sb) return sa;
  return compareDiscordSnowflake(sa, sb) <= 0 ? sa : sb;
}
