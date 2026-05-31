/**
 * 内存缓存 Discord 服务器 / 频道名称，用于消息 enrich。
 */
import { isChannelMessagesUrl, isDiscordApiUrl, looksLikeDiscordMessage, parseGatewayFrame } from "./discord-gateway.js";

/**
 * @typedef {{ name?: string | null, icon?: string | null }} GuildInfo
 * @typedef {{ name?: string | null, guildId?: string, type?: number | null, parentId?: string | null }} ChannelInfo
 */

/** @param {unknown} v */
function strId(v) {
  return v != null && String(v).trim() ? String(v) : "";
}

/** @param {unknown} obj */
function asRecord(obj) {
  return obj != null && typeof obj === "object" && !Array.isArray(obj)
    ? /** @type {Record<string, unknown>} */ (obj)
    : null;
}

export function createDiscordContextCache() {
  /** @type {Map<string, GuildInfo>} */
  const guilds = new Map();
  /** @type {Map<string, ChannelInfo>} */
  const channels = new Map();

  /** @param {string} id @param {GuildInfo} info */
  function setGuild(id, info) {
    const key = strId(id);
    if (!key) return;
    const prev = guilds.get(key) ?? {};
    guilds.set(key, { ...prev, ...info, name: info.name ?? prev.name ?? null });
  }

  /** @param {string} id @param {ChannelInfo} info */
  function setChannel(id, info) {
    const key = strId(id);
    if (!key) return;
    const prev = channels.get(key) ?? {};
    channels.set(key, {
      ...prev,
      ...info,
      name: info.name ?? prev.name ?? null,
      guildId: info.guildId ?? prev.guildId ?? "",
    });
  }

  /** @param {unknown} g */
  function ingestGuildObject(g) {
    const o = asRecord(g);
    if (!o?.id) return;
    setGuild(String(o.id), {
      name: o.name != null ? String(o.name) : null,
      icon: o.icon != null ? String(o.icon) : null,
    });
  }

  /** @param {unknown} ch */
  function ingestChannelObject(ch) {
    const o = asRecord(ch);
    if (!o?.id) return;
    setChannel(String(o.id), {
      name: o.name != null ? String(o.name) : null,
      guildId: o.guild_id != null ? String(o.guild_id) : "",
      type: typeof o.type === "number" ? o.type : null,
      parentId: o.parent_id != null ? String(o.parent_id) : null,
    });
  }

  /** @param {unknown} m */
  function ingestMessageObject(m) {
    const o = asRecord(m);
    if (!o?.channel_id) return;
    const cid = String(o.channel_id);
    const prev = channels.get(cid) ?? {};
    setChannel(cid, {
      guildId: o.guild_id != null ? String(o.guild_id) : prev.guildId ?? "",
      name: prev.name ?? null,
    });
    if (o.guild_id) {
      const gid = String(o.guild_id);
      setGuild(gid, { name: guilds.get(gid)?.name ?? null });
    }
  }

  /** @param {unknown} parsedJson Gateway 或 REST 相关 JSON */
  function ingestGatewayFrame(parsedJson) {
    const frame = parseGatewayFrame(parsedJson);
    if (!frame) {
      if (looksLikeDiscordMessage(parsedJson)) ingestMessageObject(parsedJson);
      return;
    }

    if (frame.op === 0 && frame.t === "READY") {
      const d = asRecord(frame.d);
      if (Array.isArray(d?.guilds)) {
        for (const g of d.guilds) ingestGuildObject(g);
      }
      if (Array.isArray(d?.private_channels)) {
        for (const ch of d.private_channels) ingestChannelObject(ch);
      }
      return;
    }

    if (frame.op !== 0 || !frame.t) return;
    const d = frame.d;

    switch (frame.t) {
      case "GUILD_CREATE":
      case "GUILD_UPDATE":
        ingestGuildObject(d);
        break;
      case "CHANNEL_CREATE":
      case "CHANNEL_UPDATE":
      case "THREAD_CREATE":
      case "THREAD_UPDATE":
        ingestChannelObject(d);
        break;
      case "MESSAGE_CREATE":
      case "MESSAGE_UPDATE": {
        const m = asRecord(d);
        if (m?.guild_id) setGuild(String(m.guild_id), { name: guilds.get(String(m.guild_id))?.name ?? null });
        if (m?.channel_id) {
          const cid = String(m.channel_id);
          const prev = channels.get(cid) ?? {};
          setChannel(cid, {
            guildId: m.guild_id != null ? String(m.guild_id) : prev.guildId ?? "",
            name: prev.name ?? null,
          });
        }
        break;
      }
      default:
        break;
    }
  }

  /**
   * @param {unknown} bodyJson
   * @param {string} [requestUrl]
   */
  function ingestRestBody(bodyJson, requestUrl = "") {
    const url = String(requestUrl ?? "");

    if (Array.isArray(bodyJson) && isChannelMessagesUrl(url)) {
      for (const item of bodyJson) {
        if (looksLikeDiscordMessage(item)) ingestMessageObject(item);
      }
      return;
    }

    if (Array.isArray(bodyJson)) {
      for (const item of bodyJson) {
        const o = asRecord(item);
        if (o?.id && o.name != null && (o.guild_id != null || o.type != null)) {
          ingestChannelObject(item);
        } else if (o?.id && o.name != null && !o.channel_id) {
          ingestGuildObject(item);
        }
      }
      return;
    }

    const o = asRecord(bodyJson);
    if (!o) return;

    if (o.id && o.name != null) {
      if (/\/guilds\/\d+/i.test(url) || (o.icon != null && o.features)) {
        ingestGuildObject(o);
      } else if (o.guild_id != null || o.type != null || /\/channels\/\d+/i.test(url)) {
        ingestChannelObject(o);
      }
    }

    if (Array.isArray(o.guilds)) {
      for (const g of o.guilds) ingestGuildObject(g);
    }
    if (Array.isArray(o.channels)) {
      for (const ch of o.channels) ingestChannelObject(ch);
    }
  }

  /** @param {string} guildId */
  function getGuild(guildId) {
    const id = strId(guildId);
    return id ? guilds.get(id) ?? null : null;
  }

  /** @param {string} channelId */
  function getChannel(channelId) {
    const id = strId(channelId);
    return id ? channels.get(id) ?? null : null;
  }

  /**
   * @param {{
   *   guildId?: string;
   *   channelId?: string;
   *   guildName?: string | null;
   *   channelName?: string | null;
   *   [key: string]: unknown;
   * }} row
   */
  function enrichMessage(row) {
    const gid = strId(row.guildId);
    const cid = strId(row.channelId);

    const ch = getChannel(cid);
    const resolvedGuildId = gid || ch?.guildId || "";
    const g = getGuild(resolvedGuildId);
    const channelName = row.channelName ?? ch?.name ?? null;
    const guildName = row.guildName ?? g?.name ?? null;

    return {
      ...row,
      guildId: resolvedGuildId || row.guildId || "",
      guildName,
      channelName,
    };
  }

  function snapshot() {
    return {
      guildCount: guilds.size,
      channelCount: channels.size,
      guilds: Object.fromEntries(guilds),
      channels: Object.fromEntries(channels),
    };
  }

  return {
    ingestGatewayFrame,
    ingestRestBody,
    enrichMessage,
    getGuild,
    getChannel,
    snapshot,
    isDiscordApiUrl,
  };
}
