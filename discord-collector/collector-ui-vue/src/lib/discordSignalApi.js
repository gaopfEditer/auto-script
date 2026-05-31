/** @typedef {{ id: number, messageId: string, channelId: string, guildId: string, rawContent: string, parsedJson: Record<string, unknown>, cardsByStyle: Record<string, string>, status: string, expiresAt: string | null, telegramSentAt: string | null, createdAt: string, updatedAt: string }} SignalCard */

let cachedConfig = /** @type {{ channelIds: string[], styles: Record<string, { label: string }>, channels: Record<string, unknown> } | null} */ (
  null
);

export async function fetchSignalConfig() {
  if (cachedConfig) return cachedConfig;
  const r = await fetch("/api/discord/signal-config");
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "signal-config failed");
  cachedConfig = {
    channelIds: Array.isArray(j.channelIds) ? j.channelIds.map(String) : [],
    styles: j.styles ?? {},
    channels: j.channels ?? {},
  };
  return cachedConfig;
}

/** @param {string} channelId */
export function isSignalChannelId(channelId, config) {
  return config.channelIds.includes(String(channelId ?? ""));
}

/** @param {string} channelId @param {{ status?: string, limit?: number }} [opts] */
export async function fetchSignalCards(channelId, opts = {}) {
  const q = new URLSearchParams({ channel_id: channelId, limit: String(opts.limit ?? 50) });
  if (opts.status) q.set("status", opts.status);
  const r = await fetch(`/api/discord/signal-cards?${q}`);
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "fetch cards failed");
  return /** @type {SignalCard[]} */ (j.cards ?? []);
}

/**
 * @param {number} id
 * @param {{ status?: string, expiresAt?: string | null, cardsByStyle?: Record<string, string> }} patch
 */
export async function updateSignalCard(id, patch) {
  const r = await fetch(`/api/discord/signal-cards/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(patch),
  });
  const j = await r.json();
  if (!j.ok) throw new Error(j.error || "update card failed");
  return /** @type {SignalCard} */ (j.card);
}

/** @param {number} id @param {string} [styleId] */
export async function resendSignalTelegram(id, styleId) {
  const r = await fetch(`/api/discord/signal-cards/${id}/telegram`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(styleId ? { styleId } : {}),
  });
  const j = await r.json();
  if (!j.ok && !j.skipped) throw new Error(j.error || "telegram failed");
  return j;
}
