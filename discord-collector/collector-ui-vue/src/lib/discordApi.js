import { readOkJson } from "./httpJson.js";

export async function fetchGuilds() {
  const res = await fetch("/api/discord/guilds");
  const data = await readOkJson(res, "加载群组失败");
  return /** @type {Array<Record<string, unknown>>} */ (data.guilds ?? []);
}

export async function fetchDiscordContext() {
  const res = await fetch("/api/discord/context");
  const data = await readOkJson(res, "加载 Discord 上下文失败");
  return /** @type {Record<string, unknown>} */ (data.snapshot ?? {});
}

/** @param {string} guildId */
export async function fetchChannels(guildId) {
  const res = await fetch(`/api/discord/guilds/${encodeURIComponent(guildId)}/channels`);
  const data = await readOkJson(res, "加载频道失败");
  return /** @type {Array<Record<string, unknown>>} */ (data.channels ?? []);
}

/**
 * @param {{ guildId?: string, channelId: string, limit?: number, days?: number, before?: string }} q
 */
export async function fetchChannelMessages(q) {
  const params = new URLSearchParams({
    channel_id: q.channelId,
    limit: String(q.limit ?? 200),
    order: "asc",
  });
  if (q.guildId) params.set("guild_id", q.guildId);
  if (q.before) params.set("before", q.before);
  else if (q.days) params.set("days", String(q.days));
  const res = await fetch(`/api/discord/messages?${params}`);
  const data = await readOkJson(res, "加载消息失败");
  return {
    rows: /** @type {Array<Record<string, unknown>>} */ (data.rows ?? []),
    fallbackOlder: Boolean(data.fallbackOlder),
  };
}

/**
 * 服务器 MySQL 内近 N 天各频道消息（Show 首屏预热，不依赖 CDP 当前频道）。
 * @param {string} guildId
 * @param {{ days?: number, perChannel?: number }} [opts]
 */
export async function fetchGuildMessagesSnapshot(guildId, opts = {}) {
  const params = new URLSearchParams();
  if (opts.days) params.set("days", String(opts.days));
  if (opts.perChannel) params.set("per_channel", String(opts.perChannel));
  const q = params.toString();
  const res = await fetch(
    `/api/discord/guilds/${encodeURIComponent(guildId)}/messages-snapshot${q ? `?${q}` : ""}`
  );
  const data = await readOkJson(res, "加载频道消息快照失败");
  return /** @type {{ fromMs?: number, byChannel?: Record<string, Record<string, unknown>[]> }} */ (
    data
  );
}

/** @param {string} guildId @param {string} channelId */
export async function navigateDiscordChannel(guildId, channelId) {
  const res = await fetch("/api/cdp/discord-channel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ guildId, channelId }),
  });
  return readOkJson(res, "CDP 跳转失败");
}

/**
 * 驱动 CDP 内 Discord 网页向上滚动，触发历史消息 REST 采集。
 * @param {string} guildId
 * @param {string} channelId
 * @param {{ beforeMessageId?: string }} [opts]
 */
export async function scrollDiscordChannelHistory(guildId, channelId, opts = {}) {
  const beforeMessageId = String(opts.beforeMessageId ?? "").trim();
  const res = await fetch("/api/cdp/discord-channel-scroll-up", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      guildId,
      channelId,
      ...(beforeMessageId ? { beforeMessageId } : {}),
    }),
  });
  return readOkJson(res, "CDP 向上翻页失败");
}

/** @returns {Promise<{ cdpChannelId: string, cdpGuildId: string }>} */
export async function fetchCdpActiveChannel() {
  const res = await fetch("/api/discord/cdp-active");
  const data = await readOkJson(res, "读取 CDP 频道失败");
  return {
    cdpChannelId: String(data.cdpChannelId ?? ""),
    cdpGuildId: String(data.cdpGuildId ?? ""),
  };
}
