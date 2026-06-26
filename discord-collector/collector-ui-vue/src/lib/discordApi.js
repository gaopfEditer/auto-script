export async function fetchGuilds() {
  const res = await fetch("/api/discord/guilds");
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "加载群组失败");
  return /** @type {Array<Record<string, unknown>>} */ (data.guilds ?? []);
}

/** @param {string} guildId */
export async function fetchChannels(guildId) {
  const res = await fetch(`/api/discord/guilds/${encodeURIComponent(guildId)}/channels`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "加载频道失败");
  return /** @type {Array<Record<string, unknown>>} */ (data.channels ?? []);
}

/**
 * @param {{ guildId?: string, channelId: string, limit?: number }} q
 */
export async function fetchChannelMessages(q) {
  const params = new URLSearchParams({
    channel_id: q.channelId,
    limit: String(q.limit ?? 200),
    order: "asc",
  });
  if (q.guildId) params.set("guild_id", q.guildId);
  const res = await fetch(`/api/discord/messages?${params}`);
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "加载消息失败");
  return /** @type {Array<Record<string, unknown>>} */ (data.rows ?? []);
}

/** @param {string} guildId @param {string} channelId */
export async function navigateDiscordChannel(guildId, channelId) {
  const res = await fetch("/api/cdp/discord-channel", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ guildId, channelId }),
  });
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "CDP 跳转失败");
  return data;
}

/** @returns {Promise<{ cdpChannelId: string, cdpGuildId: string }>} */
export async function fetchCdpActiveChannel() {
  const res = await fetch("/api/discord/cdp-active");
  const data = await res.json();
  if (!data.ok) throw new Error(data.error || "读取 CDP 频道失败");
  return {
    cdpChannelId: String(data.cdpChannelId ?? ""),
    cdpGuildId: String(data.cdpGuildId ?? ""),
  };
}
