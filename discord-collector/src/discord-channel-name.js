/**
 * Discord 频道显示名：区分真名与占位（含客户端 ___hidden___）。
 */

/**
 * @param {unknown} name
 * @param {unknown} [channelId]
 */
export function isPlaceholderDiscordChannelName(name, channelId) {
  const n = String(name ?? "").trim();
  if (!n) return true;
  const lower = n.toLowerCase();
  if (
    n === "___hidden___" ||
    lower === "hidden" ||
    n === "#hidden" ||
    lower === "(hidden)" ||
    lower === "unknown" ||
    n === "未命名频道"
  ) {
    return true;
  }
  const id = String(channelId ?? "").trim();
  if (id && (n === id || n === id.slice(-6))) return true;
  return false;
}

/**
 * upsert 时是否应用新 name。
 * - 空/占位名不得覆盖已有真名
 * - 真名可覆盖占位名
 * - 真名可更新为新真名
 * @param {unknown} incoming
 * @param {unknown} existing
 * @param {unknown} [channelId]
 */
export function shouldApplyDiscordChannelName(incoming, existing, channelId) {
  const next = String(incoming ?? "").trim();
  if (!next) return false;
  if (isPlaceholderDiscordChannelName(next, channelId)) {
    const cur = String(existing ?? "").trim();
    // 仅当库里也没有真名时才写入占位，避免空白行永远无名
    return !cur || isPlaceholderDiscordChannelName(cur, channelId);
  }
  return true;
}
