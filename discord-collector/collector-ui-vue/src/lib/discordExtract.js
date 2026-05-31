/**
 * Discord Gateway / REST JSON → UI 展示（debug 全量 / 精简）。
 */

/** @param {unknown} obj */
function asRecord(obj) {
  return obj != null && typeof obj === "object" && !Array.isArray(obj)
    ? /** @type {Record<string, unknown>} */ (obj)
    : null;
}

/**
 * @param {unknown} obj
 * @param {boolean} [debugMode=true]
 */
export function extractDiscordDisplay(obj, debugMode = true) {
  if (obj == null || typeof obj !== "object") {
    return {
      author: "system",
      typeLabel: "raw",
      text: String(obj),
      guildLabel: "",
      channelLabel: "",
      raw: obj,
    };
  }

  const o = /** @type {Record<string, unknown>} */ (obj);

  if (debugMode) {
    let text;
    try {
      text = JSON.stringify(o, null, 0);
    } catch {
      text = String(o);
    }
    const t = typeof o.t === "string" ? o.t : o.op != null ? `op:${o.op}` : "json";
    return {
      author: "gateway",
      typeLabel: t,
      text,
      guildLabel: "",
      channelLabel: "",
      raw: o,
    };
  }

  if (typeof o.t === "string" && o.d && typeof o.d === "object") {
    const d = /** @type {Record<string, unknown>} */ (o.d);
    const authorObj = asRecord(d.author);
    const author = String(authorObj?.global_name || authorObj?.username || d.author_id || "user");
    const content = String(d.content ?? "");
    const guildId = d.guild_id != null ? String(d.guild_id) : "";
    const channelId = d.channel_id != null ? String(d.channel_id) : "";
    return {
      author,
      typeLabel: o.t,
      text: content || `[${o.t}]`,
      guildLabel: guildId ? `guild:${guildId}` : "",
      channelLabel: channelId ? `#${channelId}` : "",
      raw: o,
    };
  }

  if (o.content != null || o.channel_id != null) {
    const authorObj = asRecord(o.author);
    const author = String(authorObj?.global_name || authorObj?.username || "user");
    const guildId = o.guild_id != null ? String(o.guild_id) : "";
    const channelId = o.channel_id != null ? String(o.channel_id) : "";
    return {
      author,
      typeLabel: "MESSAGE",
      text: String(o.content ?? ""),
      guildLabel: guildId ? `guild:${guildId}` : "",
      channelLabel: channelId ? `#${channelId}` : "",
      raw: o,
    };
  }

  let text;
  try {
    text = JSON.stringify(o);
  } catch {
    text = "[object]";
  }
  return {
    author: "event",
    typeLabel: String(o.t ?? o.op ?? "json"),
    text: text.slice(0, 500),
    guildLabel: "",
    channelLabel: "",
    raw: o,
  };
}

/**
 * @param {Record<string, unknown>} row API/WS 消息行（camelCase 或 snake_case）
 */
export function formatMessageCardTitle(row) {
  const guildName = row.guildName ?? row.guild_name;
  const guildId = row.guildId ?? row.guild_id;
  const channelName = row.channelName ?? row.channel_name;
  const channelId = row.channelId ?? row.channel_id;
  const guild = guildName
    ? `${guildName} (${guildId || "?"})`
    : guildId
      ? `服务器 ${guildId}`
      : "私信/未知服务器";
  const channel = channelName
    ? `#${channelName} (${channelId || "?"})`
    : channelId
      ? `#${channelId}`
      : "#?";
  return `${guild} / ${channel}`;
}

/** @param {Record<string, unknown>} row */
export function authorLabel(row) {
  return (
    row.authorGlobalName ??
    row.author_global_name ??
    row.authorUsername ??
    row.author_username ??
    row.authorId ??
    row.author_id ??
    "?"
  );
}
