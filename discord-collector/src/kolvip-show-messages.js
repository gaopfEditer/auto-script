/**
 * Show / 频道消息列表的巨鲸源隔离（纯函数，不读 env、不连库）。
 * 前端可直接引用本文件；开关与映射由调用方传入。
 */

export const KOLVIP_SHOW_SOURCE_PREFIX = "kolvip_";
export const KOLVIP_DISCORD_SOFT_DELETE_REASON = "kolvip_primary";
const KOLVIP_SCAN_PREFIX = "kolvip-scan-";

/**
 * @param {unknown} source
 * @param {readonly string[]} [knownSources] KOLVIP_SIGNAL_CARD_SOURCES
 */
export function isKolvipMessageSource(source, knownSources = []) {
  const s = String(source ?? "").trim();
  if (!s) return false;
  if (s.startsWith(KOLVIP_SHOW_SOURCE_PREFIX)) return true;
  return knownSources.includes(s);
}

/**
 * @param {unknown} channelId
 * @returns {string} kolvip ch id，否则空
 */
export function kolvipScanVirtualChannelIdFrom(channelId) {
  const id = String(channelId ?? "").trim();
  if (!id.startsWith(KOLVIP_SCAN_PREFIX)) return "";
  const kid = id.slice(KOLVIP_SCAN_PREFIX.length);
  return /^\d+$/.test(kid) ? kid : "";
}

/**
 * @typedef {{
 *   enabled: boolean,
 *   mappedChannelIds?: readonly string[],
 *   kolvipSources?: readonly string[],
 * }} KolvipShowPolicy
 */

/**
 * @param {KolvipShowPolicy} policy
 */
export function buildKolvipShowIsolationPayload(policy) {
  return {
    enabled: Boolean(policy.enabled),
    mode: policy.enabled ? "only" : "hide",
    channelIds: [...(policy.mappedChannelIds ?? [])].map((id) => String(id)),
  };
}

/**
 * 巨鲸开：映射 Discord 频道只留 kolvip_*。
 * 巨鲸关：Show/频道接口隐藏全部 kolvip_*（Discord 原文恢复由软删回滚负责）。
 * 未映射频道（含 kolvip-scan-*）在开启时不过滤，避免备选虚拟频道被当成 Discord 侧栏频道处理。
 * @param {unknown} channelId
 * @param {unknown} source
 * @param {KolvipShowPolicy} policy
 */
export function messageVisibleForShow(channelId, source, policy) {
  const kolvip = isKolvipMessageSource(source, policy.kolvipSources);
  if (!policy.enabled) return !kolvip;
  const cid = String(channelId ?? "").trim();
  const mapped = new Set((policy.mappedChannelIds ?? []).map((id) => String(id)));
  if (mapped.has(cid)) return kolvip;
  return true;
}

/**
 * @param {unknown} channelId
 * @param {Array<Record<string, unknown>> | null | undefined} rows
 * @param {{ mode?: string, channelIds?: string[], kolvipSources?: readonly string[] } | null | undefined} isolation
 */
export function isolateShowChannelMessages(channelId, rows, isolation) {
  if (!Array.isArray(rows)) return [];
  const mode = String(isolation?.mode ?? "");
  if (mode !== "only" && mode !== "hide") return rows;
  const policy = {
    enabled: mode === "only",
    mappedChannelIds: isolation?.channelIds ?? [],
    kolvipSources: isolation?.kolvipSources,
  };
  return rows.filter((m) => messageVisibleForShow(channelId, m?.source, policy));
}

/**
 * @param {KolvipShowPolicy} policy
 * @param {string} [sourceExpr]
 * @param {string} [channelExpr]
 * @returns {{ sql: string, params: unknown[] }}
 */
export function kolvipShowMessageVisibilityWhere(policy, sourceExpr = "source", channelExpr = "channel_id") {
  const pred = sqlKolvipSourcePredicate(policy.kolvipSources, sourceExpr);
  if (!policy.enabled) {
    return { sql: `NOT ${pred.sql}`, params: pred.params };
  }
  const ids = [...new Set((policy.mappedChannelIds ?? []).map((id) => String(id).trim()).filter(Boolean))];
  if (!ids.length) return { sql: "", params: [] };
  const ph = ids.map(() => "?").join(", ");
  return {
    sql: `(${channelExpr} NOT IN (${ph}) OR ${pred.sql})`,
    params: [...ids, ...pred.params],
  };
}

/**
 * @param {readonly string[] | undefined} kolvipSources
 * @param {string} [sourceExpr]
 */
export function sqlKolvipSourcePredicate(kolvipSources, sourceExpr = "source") {
  const sources = [...(kolvipSources ?? [])].map((s) => String(s));
  if (!sources.length) {
    return { sql: `COALESCE(${sourceExpr}, '') LIKE 'kolvip_%'`, params: /** @type {unknown[]} */ ([]) };
  }
  return {
    sql: `(COALESCE(${sourceExpr}, '') LIKE 'kolvip_%' OR COALESCE(${sourceExpr}, '') IN (${sources.map(() => "?").join(", ")}))`,
    params: sources,
  };
}

/**
 * Discord 雪花翻页 / 回溯不要把 kolvip-* message_id 当成 before 游标。
 * @param {readonly string[] | undefined} kolvipSources
 * @param {string} [sourceExpr]
 */
export function sqlExcludeKolvipMessageSource(kolvipSources, sourceExpr = "source") {
  const pred = sqlKolvipSourcePredicate(kolvipSources, sourceExpr);
  return { sql: `NOT ${pred.sql}`, params: pred.params };
}

/**
 * @param {unknown} messageId
 */
export function isDiscordSnowflakeMessageId(messageId) {
  return /^\d+$/.test(String(messageId ?? "").trim());
}

/**
 * Discord 刷新按 message_id upsert，不得覆盖已有 kolvip_* 行。
 * @param {Map<string, string>} existingSourceById
 * @param {Array<Record<string, unknown>>} incoming
 * @param {readonly string[]} [kolvipSources]
 */
export function partitionDiscordMessageUpserts(existingSourceById, incoming, kolvipSources = []) {
  /** @type {Array<Record<string, unknown>>} */
  const keep = [];
  /** @type {string[]} */
  const preservedKolvip = [];
  for (const row of incoming) {
    const id = String(row?.messageId ?? row?.message_id ?? "").trim();
    if (!id) continue;
    const prev = existingSourceById.get(id);
    const incomingSource = row?.source;
    if (
      prev != null &&
      isKolvipMessageSource(prev, kolvipSources) &&
      !isKolvipMessageSource(incomingSource, kolvipSources)
    ) {
      preservedKolvip.push(id);
      continue;
    }
    keep.push(row);
  }
  return { keep, preservedKolvip };
}

/**
 * @param {unknown} channelId
 * @param {unknown} source
 * @param {KolvipShowPolicy} policy
 * @param {string | null} [nowIso]
 */
export function discordMessageSoftDeleteFields(channelId, source, policy, nowIso = null) {
  const cid = String(channelId ?? "").trim();
  const mapped = new Set((policy.mappedChannelIds ?? []).map((id) => String(id)));
  if (
    policy.enabled &&
    mapped.has(cid) &&
    !isKolvipMessageSource(source, policy.kolvipSources)
  ) {
    return {
      deletedAt: nowIso || new Date().toISOString(),
      deletedReason: KOLVIP_DISCORD_SOFT_DELETE_REASON,
    };
  }
  return { deletedAt: null, deletedReason: null };
}

/**
 * 备选虚拟频道不进 Discord 服务器侧栏；巨鲸关时 kolvip 行也不刷新侧栏预览。
 * @param {Record<string, unknown>} row
 * @param {KolvipShowPolicy} policy
 */
export function shouldIndexDiscordChannelRow(row, policy) {
  const cid = String(row?.channelId ?? row?.channel_id ?? "").trim();
  if (!cid || kolvipScanVirtualChannelIdFrom(cid)) return false;
  return messageVisibleForShow(cid, row?.source, policy);
}
