/**
 * 从 Gateway / REST 解析群组、频道并写入 MySQL。
 */
import { resolveGuildIconUrl } from "./discord-avatar.js";
import { parseChannelIdFromMessagesUrl, parseGatewayFrame } from "./discord-gateway.js";

/** @param {unknown} v */
function asRecord(v) {
  return v != null && typeof v === "object" && !Array.isArray(v)
    ? /** @type {Record<string, unknown>} */ (v)
    : null;
}

/** 文本频道 type：0=GUILD_TEXT, 5=GUILD_ANNOUNCEMENT, 15=GUILD_FORUM */
const TEXT_CHANNEL_TYPES = new Set([0, 5, 15]);

/** Discord 频道对象也有 id+name，须与 guild 区分 */
function looksLikeChannel(o) {
  if (o.guild_id != null) return true;
  if (o.channel_id != null) return true;
  const type = o.type;
  if (typeof type === "number" && type >= 0 && type <= 16) return true;
  return false;
}

/**
 * @param {unknown} ch
 * @returns {{ channelId: string, guildId: string, name: string, type: number } | null}
 */
export function normalizeChannelRow(ch) {
  const o = asRecord(ch);
  if (!o?.id) return null;
  const type = typeof o.type === "number" ? o.type : 0;
  if (!TEXT_CHANNEL_TYPES.has(type)) return null;
  const name = o.name != null ? String(o.name) : "";
  if (!name) return null;
  return {
    channelId: String(o.id),
    guildId: o.guild_id != null ? String(o.guild_id) : "",
    name: name || guildId,
    type,
  };
}

/**
 * @param {unknown} g
 * @returns {{ guildId: string, name: string, icon: string | null, iconUrl: string } | null}
 */
export function normalizeGuildRow(g) {
  const o = asRecord(g);
  if (!o?.id) return null;
  if (looksLikeChannel(o)) return null;
  const guildId = String(o.id);
  const name = o.name != null ? String(o.name) : "";
  const icon = o.icon != null ? String(o.icon) : null;
  return {
    guildId,
    name: name || guildId,
    icon,
    iconUrl: resolveGuildIconUrl(guildId, icon),
  };
}

/**
 * @param {unknown} parsedJson
 * @returns {{ guilds: ReturnType<typeof normalizeGuildRow>[], channels: ReturnType<typeof normalizeChannelRow>[] }}
 */
export function extractGuildChannelFromGateway(parsedJson) {
  /** @type {ReturnType<typeof normalizeGuildRow>[]} */
  const guilds = [];
  /** @type {ReturnType<typeof normalizeChannelRow>[]} */
  const channels = [];

  const pushGuild = (g) => {
    const row = normalizeGuildRow(g);
    if (row) guilds.push(row);
    const o = asRecord(g);
    if (Array.isArray(o?.channels)) {
      for (const ch of o.channels) {
        const c = normalizeChannelRow(ch);
        if (c) {
          if (!c.guildId) c.guildId = row?.guildId ?? "";
          channels.push(c);
        }
      }
    }
  };

  const frame = parseGatewayFrame(parsedJson);
  if (frame?.op === 0 && frame.t === "READY") {
    const d = asRecord(frame.d);
    if (Array.isArray(d?.guilds)) {
      for (const g of d.guilds) pushGuild(g);
    }
    if (Array.isArray(d?.private_channels)) {
      for (const ch of d.private_channels) {
        const c = normalizeChannelRow(ch);
        if (c) channels.push(c);
      }
    }
    return { guilds, channels };
  }

  if (frame?.op === 0 && frame.t) {
    const d = frame.d;
    switch (frame.t) {
      case "GUILD_CREATE":
      case "GUILD_UPDATE":
        pushGuild(d);
        break;
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE":
      case "THREAD_CREATE":
      case "THREAD_UPDATE": {
        const c = normalizeChannelRow(d);
        if (c) channels.push(c);
        break;
      }
      default:
        break;
    }
  }

  return { guilds, channels };
}

/**
 * @param {unknown} bodyJson
 * @param {string} url
 */
export function extractGuildChannelFromRest(bodyJson, url = "") {
  /** @type {ReturnType<typeof normalizeGuildRow>[]} */
  const guilds = [];
  /** @type {ReturnType<typeof normalizeChannelRow>[]} */
  const channels = [];
  const u = String(url ?? "");

  const msgChannelId = parseChannelIdFromMessagesUrl(u);
  if (msgChannelId && Array.isArray(bodyJson)) {
    // 消息列表由 ingest 单独处理；不在此处写入无 guild 的占位频道
    return { guilds, channels };
  }

  const pushArr = (arr) => {
    if (!Array.isArray(arr)) return;
    for (const item of arr) {
      const c = normalizeChannelRow(item);
      if (c) {
        channels.push(c);
        continue;
      }
      const g = normalizeGuildRow(item);
      if (g) guilds.push(g);
    }
  };

  if (Array.isArray(bodyJson)) {
    pushArr(bodyJson);
    return { guilds, channels };
  }

  const o = asRecord(bodyJson);
  if (!o) return { guilds, channels };

  if (o.id && o.name != null) {
    const c = normalizeChannelRow(o);
    if (c) {
      channels.push(c);
    } else if (/\/guilds\/\d+/i.test(u) && !/\/channels/i.test(u)) {
      const g = normalizeGuildRow(o);
      if (g) guilds.push(g);
    }
  }

  if (Array.isArray(o.guilds)) pushArr(o.guilds);
  if (Array.isArray(o.channels)) pushArr(o.channels);

  return { guilds, channels };
}
