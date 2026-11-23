/**
 * kolvip Show 频道 HTTP 补拉：与 Discord CDP 预热共用 discord_channels 缓存，减少打源站。
 */
import { config } from "./config.js";
import { isChannelShowHistoryFresh } from "./discord-show-history-cache.js";
import { kolvipMessageToDiscordRow } from "./kolvip-cdp-message.js";

/**
 * 是否跳过 kolvip HTTP 拉取。
 * - live 尾拉（beforeId=0、无翻页锚点）：永不因历史预热 TTL 跳过，否则会挡榜单 kolvip-scan-* 轮转补新帖。
 * - 带 beforeMessageId 的向上补历史：若缓存已覆盖该锚点且在 TTL 内，可读 MySQL 不打源站。
 *
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {string} showChannelId
 * @param {{ beforeId?: number, beforeMessageId?: string, force?: boolean }} [opts]
 */
export async function shouldSkipKolvipShowTailCatchup(store, showChannelId, opts = {}) {
  if (opts.force) return false;
  if (Math.max(0, Number(opts.beforeId) || 0) > 0) return false;
  const beforeMessageId = String(opts.beforeMessageId ?? "").trim();
  if (!beforeMessageId) return false;
  if (typeof store?.getDiscordChannelShowHistoryCache !== "function") return false;
  const cid = String(showChannelId ?? "").trim();
  if (!cid) return false;
  const cache = await store.getDiscordChannelShowHistoryCache(cid);
  return isChannelShowHistoryFresh(cache, {
    ttlMs: config.kolvipShowCatchupTtlMs,
    beforeMessageId,
  });
}

/**
 * 拉取成功后标记「近期窗口已同步」（默认 TTL 与巨鲸 30 天窗口一致）。
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {string} showChannelId
 * @param {import("./kolvip-cdp-message.js").KolvipDomMessage[]} messages API 返回（通常最新在前）
 * @param {{ kolvipChannelId: string, source?: string }} meta
 */
export async function markKolvipShowCatchupWarmed(store, showChannelId, messages, meta) {
  if (typeof store?.markDiscordChannelShowHistoryWarmed !== "function") return;
  const cid = String(showChannelId ?? "").trim();
  if (!cid || !Array.isArray(messages) || !messages.length) {
    if (cid) await store.markDiscordChannelShowHistoryWarmed(cid);
    return;
  }
  const tail = messages[messages.length - 1];
  const row = kolvipMessageToDiscordRow(tail, {
    kolvipChannelId: String(meta.kolvipChannelId),
    discordChannelId: cid,
    source: meta.source ?? "kolvip_api",
  });
  const oldestInBatch = String(row.messageId ?? "").trim();
  await store.markDiscordChannelShowHistoryWarmed(cid, oldestInBatch || undefined);
}