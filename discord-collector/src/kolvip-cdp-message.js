/**
 * 巨鲸 DOM 消息 → Discord ingest 行（纯函数，单测不依赖 Playwright）。
 */

/**
 * @param {string} kolvipChannelId
 * @param {string} dataId
 */
export function kolvipStableMessageId(kolvipChannelId, dataId) {
  return `kolvip-${String(kolvipChannelId).trim()}-${String(dataId).trim()}`;
}

/**
 * @param {string} timeText
 * @param {string} [titleAttr]
 */
export function parseKolvipMessageTimeMs(timeText, titleAttr) {
  for (const s of [titleAttr, timeText]) {
    const t = String(s ?? "").trim();
    if (!t) continue;
    const ms = Date.parse(t);
    if (Number.isFinite(ms)) return ms;
  }
  return Date.now();
}

/**
 * @typedef {{
 *   dataId: string,
 *   text: string,
 *   author: string,
 *   timeText: string,
 *   timeTitle: string,
 *   imageUrl: string,
 * }} KolvipDomMessage
 */

/**
 * @param {KolvipDomMessage} msg
 * @param {{ kolvipChannelId: string, discordChannelId: string, source?: string }} map
 */
export function kolvipMessageToDiscordRow(msg, map) {
  const messageId = kolvipStableMessageId(map.kolvipChannelId, msg.dataId);
  const createdAtMs = parseKolvipMessageTimeMs(msg.timeText, msg.timeTitle);
  const content = String(msg.text ?? "").trim();
  const source = String(map.source ?? "kolvip_cdp").trim() || "kolvip_cdp";
  /** @type {Array<{ url: string, filename: string, content_type: string }>} */
  const attachments = [];
  const imageUrl = String(msg.imageUrl ?? "").trim();
  if (imageUrl) {
    attachments.push({
      url: imageUrl,
      filename: "kolvip-image.jpg",
      content_type: "image/jpeg",
    });
  }
  return {
    messageId,
    guildId: "",
    channelId: map.discordChannelId,
    authorId: "",
    createdAtMs,
    content,
    authorUsername: String(msg.author ?? "").trim() || null,
    authorGlobalName: null,
    authorAvatar: null,
    eventType: "MESSAGE_CREATE",
    source,
    rawJson: {
      id: messageId,
      channel_id: map.discordChannelId,
      content,
      attachments,
      kolvip: {
        channelId: map.kolvipChannelId,
        dataId: msg.dataId,
        ingest: source,
      },
    },
  };
}
