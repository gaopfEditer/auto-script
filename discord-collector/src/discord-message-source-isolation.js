/**
 * 把巨鲸开关接到 Show 消息可见性、软删与 Discord upsert 保护。
 */
import { KOLVIP_SIGNAL_CARD_SOURCES } from "./discord-signal-card-source.js";
import { getKolvipMappedDiscordChannelIds, isKolvipSignalEnabled } from "./kolvip-cdp-config.js";
import {
  KOLVIP_DISCORD_SOFT_DELETE_REASON,
  buildKolvipShowIsolationPayload,
  discordMessageSoftDeleteFields,
  kolvipShowMessageVisibilityWhere,
  messageVisibleForShow,
  partitionDiscordMessageUpserts,
  shouldIndexDiscordChannelRow,
  sqlExcludeKolvipMessageSource,
} from "./kolvip-show-messages.js";

export { KOLVIP_DISCORD_SOFT_DELETE_REASON };

/** @returns {import("./kolvip-show-messages.js").KolvipShowPolicy} */
export function currentKolvipShowPolicy() {
  return {
    enabled: isKolvipSignalEnabled(),
    mappedChannelIds: [...getKolvipMappedDiscordChannelIds()],
    kolvipSources: KOLVIP_SIGNAL_CARD_SOURCES,
  };
}

export function kolvipShowIsolationPayload() {
  return buildKolvipShowIsolationPayload(currentKolvipShowPolicy());
}

/**
 * @param {unknown} channelId
 * @param {unknown} source
 */
export function messageVisibleForKolvipShow(channelId, source) {
  return messageVisibleForShow(channelId, source, currentKolvipShowPolicy());
}

export function kolvipShowListVisibilityWhere() {
  return kolvipShowMessageVisibilityWhere(currentKolvipShowPolicy());
}

export function sqlExcludeKolvipRows() {
  return sqlExcludeKolvipMessageSource(KOLVIP_SIGNAL_CARD_SOURCES);
}

/**
 * @param {Map<string, string>} existingSourceById
 * @param {Array<Record<string, unknown>>} incoming
 */
export function partitionIncomingDiscordMessages(existingSourceById, incoming) {
  return partitionDiscordMessageUpserts(
    existingSourceById,
    incoming,
    KOLVIP_SIGNAL_CARD_SOURCES
  );
}

/**
 * @param {unknown} channelId
 * @param {unknown} source
 * @param {string | null} [nowIso]
 */
export function softDeleteFieldsForDiscordMessage(channelId, source, nowIso = null) {
  return discordMessageSoftDeleteFields(channelId, source, currentKolvipShowPolicy(), nowIso);
}

/** @param {Record<string, unknown>} row */
export function shouldIndexDiscordChannelForMessage(row) {
  return shouldIndexDiscordChannelRow(row, currentKolvipShowPolicy());
}

/**
 * 巨鲸开：映射频道上的 Discord 原文软删（可逆）。
 * 巨鲸关：清掉 reason=kolvip_primary 的软删，Discord 消息重新可见；kolvip_* 仍留在库里，由查询隔离。
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {{ info?: (msg: string) => void, warn?: (msg: string) => void } | null} [log]
 */
export async function syncKolvipMappedDiscordMessageVisibility(store, log = null) {
  if (!store || store.offline || typeof store.applyKolvipDiscordMessageSoftDelete !== "function") {
    return { softDeleted: 0, restored: 0, skipped: true };
  }
  const policy = currentKolvipShowPolicy();
  try {
    const result = await store.applyKolvipDiscordMessageSoftDelete({
      channelIds: policy.mappedChannelIds,
      enabled: policy.enabled,
      reason: KOLVIP_DISCORD_SOFT_DELETE_REASON,
      kolvipSources: [...KOLVIP_SIGNAL_CARD_SOURCES],
    });
    const softDeleted = Number(result?.softDeleted ?? 0);
    const restored = Number(result?.restored ?? 0);
    if (softDeleted || restored) {
      log?.info?.(
        `巨鲸消息隔离 ${policy.enabled ? "开" : "关"} softDeleted=${softDeleted} restored=${restored}`
      );
    }
    return { softDeleted, restored, skipped: false };
  } catch (e) {
    log?.warn?.(`巨鲸消息隔离失败: ${/** @type {Error} */ (e).message}`);
    return { softDeleted: 0, restored: 0, skipped: false, error: /** @type {Error} */ (e).message };
  }
}
