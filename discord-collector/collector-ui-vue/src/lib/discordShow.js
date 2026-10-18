/** @param {string} userId */
export function defaultAvatarUrl(userId) {
  try {
    const idx = Number((BigInt(userId) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
  } catch {
    return "https://cdn.discordapp.com/embed/avatars/0.png";
  }
}

/** @param {Record<string, unknown>} m */
export function msgAvatarUrl(m) {
  const url = String(m.authorAvatar ?? m.author_avatar ?? "").trim();
  if (url) return url;
  const uid = String(m.authorId ?? m.author_id ?? "");
  return uid ? defaultAvatarUrl(uid) : "";
}

/** @param {Record<string, unknown>} m */
export function msgDisplayName(m) {
  return (
    m.authorGlobalName ??
    m.author_global_name ??
    m.authorUsername ??
    m.author_username ??
    m.authorId ??
    m.author_id ??
    "?"
  );
}

/** @param {number | string | null | undefined} ms */
export function fmtMsgTime(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n) || n <= 0) return "";
  try {
    return new Date(n).toLocaleString("zh-CN", {
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
  } catch {
    return "";
  }
}

/** @param {Record<string, unknown>} m */
function messageRowId(m) {
  return String(m.messageId ?? m.message_id ?? "");
}

/** @param {Record<string, unknown>} m */
function messageRowMergeSignature(m) {
  const att = msgAttachments(m);
  const attSig = att.length
    ? att.map((a) => `${a.url}|${a.filename}|${a.contentType}`).join(";")
    : "";
  return [
    messageRowId(m),
    String(m.content ?? ""),
    String(m.authorId ?? m.author_id ?? ""),
    String(m.authorAvatar ?? m.author_avatar ?? ""),
    String(m.authorUsername ?? m.author_username ?? ""),
    String(m.authorGlobalName ?? m.author_global_name ?? ""),
    String(m.eventType ?? m.event_type ?? ""),
    Number(m.createdAtMs ?? m.created_at_ms ?? 0),
    attSig,
  ].join("\u001f");
}

/** @param {Record<string, unknown>} a @param {Record<string, unknown>} b */
function sameMessageForMerge(a, b) {
  return messageRowMergeSignature(a) === messageRowMergeSignature(b);
}

/** @param {Array<Record<string, unknown>>} messages */
function isSortedByTimeAsc(messages) {
  for (let i = 1; i < messages.length; i += 1) {
    if (msgTimeMs(messages[i]) < msgTimeMs(messages[i - 1])) return false;
  }
  return true;
}

/**
 * @param {Array<Record<string, unknown>>} prev
 * @param {Array<Record<string, unknown>>} incoming
 * @returns {Array<Record<string, unknown>>} 无实质变化时返回 prev 同一引用，避免消息列表整表重绘
 */
export function mergeChannelMessages(prev, incoming) {
  if (!incoming.length) return prev;
  const map = new Map();
  for (const m of prev) {
    const id = messageRowId(m);
    if (id) map.set(id, m);
  }
  let changed = false;
  for (const m of incoming) {
    const id = messageRowId(m);
    if (!id) continue;
    const existing = map.get(id);
    if (!existing) {
      map.set(id, m);
      changed = true;
      continue;
    }
    if (msgAttachments(m).length > msgAttachments(existing).length) {
      map.set(id, m);
      changed = true;
      continue;
    }
    if (!sameMessageForMerge(existing, m)) {
      map.set(id, m);
      changed = true;
    }
  }
  if (!changed) return prev;
  const next = [...map.values()].sort((a, b) => msgTimeMs(a) - msgTimeMs(b));
  if (prev.length === next.length && prev.every((p, i) => next[i] === p)) {
    return prev;
  }
  return next;
}

/** @param {Record<string, unknown>} row */
export function guildRowToClient(row) {
  return {
    guildId: String(row.guildId ?? row.guild_id ?? ""),
    name: String(row.name ?? ""),
    iconUrl: String(row.iconUrl ?? row.icon_url ?? ""),
    channelCount: Number(row.channelCount ?? row.channel_count ?? 0),
  };
}

/** @param {string} raw @param {{ preserveLines?: boolean }} [opts] */
export function normalizeMessageContent(raw, { preserveLines = true } = {}) {
  let text = String(raw ?? "");
  if (!text) return "";
  text = text
    .replace(/\\r\\n/g, "\n")
    .replace(/\\n/g, "\n")
    .replace(/\\r/g, "")
    .replace(/\\t/g, "\t");
  if (!preserveLines) {
    return text.replace(/\s+/g, " ").trim();
  }
  return text
    .split("\n")
    .map((line) => line.replace(/[^\S\n]+/g, " ").trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** @param {Record<string, unknown>} m */
export function messageContentPreview(m) {
  const text = normalizeMessageContent(m.content ?? "", { preserveLines: false });
  if (text) return text.length > 120 ? `${text.slice(0, 120)}…` : text;
  const attachments = msgAttachments(m);
  if (attachments.length) {
    const first = attachments[0];
    if (isImageAttachment(first)) return "（图片）";
    return first.filename ? `[附件] ${first.filename}` : "（附件）";
  }
  return "（无文本）";
}

/** @param {unknown} item */
function normalizeAttachment(item) {
  if (item == null || typeof item !== "object" || Array.isArray(item)) return null;
  const a = /** @type {Record<string, unknown>} */ (item);
  const url = String(a.url ?? "").trim();
  const proxyUrl = String(a.proxy_url ?? a.proxyUrl ?? "").trim();
  const pick = url || proxyUrl;
  if (!pick) return null;
  return {
    url: pick,
    proxyUrl: proxyUrl || undefined,
    filename: String(a.filename ?? "").trim(),
    contentType: String(a.content_type ?? a.contentType ?? "").trim(),
    width: typeof a.width === "number" ? a.width : undefined,
    height: typeof a.height === "number" ? a.height : undefined,
  };
}

/** @param {unknown} raw */
function embedImagesFromRaw(raw) {
  if (raw == null || typeof raw !== "object" || Array.isArray(raw)) return [];
  const embeds = /** @type {Record<string, unknown>} */ (raw).embeds;
  if (!Array.isArray(embeds)) return [];

  /** @type {ReturnType<typeof normalizeAttachment>[]} */
  const out = [];
  const seen = new Set();
  for (const embed of embeds) {
    if (embed == null || typeof embed !== "object" || Array.isArray(embed)) continue;
    const e = /** @type {Record<string, unknown>} */ (embed);
    for (const key of ["image", "thumbnail"]) {
      const img = e[key];
      if (img == null || typeof img !== "object" || Array.isArray(img)) continue;
      const url = String(/** @type {Record<string, unknown>} */ (img).url ?? "").trim();
      if (!url || seen.has(url)) continue;
      seen.add(url);
      out.push({
        url,
        filename: "",
        contentType: "image/*",
      });
    }
  }
  return out;
}

/** v-memo / 列表差分：附件数量或 URL 变化时需重绘 */
/** @param {Record<string, unknown>} m */
export function messageAttachmentsMemoKey(m) {
  const att = msgAttachments(m);
  if (!att.length) return "0";
  return att
    .map((a, i) => `${i}:${attachmentDisplayUrl(a)}:${a.filename ?? ""}`)
    .join("|");
}

/** @param {Record<string, unknown>} m */
export function msgAttachments(m) {
  if (Array.isArray(m.attachments)) {
    const list = m.attachments.map(normalizeAttachment).filter(Boolean);
    if (list.length) return list;
  }
  const raw = m.rawJson ?? m.raw_json;
  if (raw != null && typeof raw === "object" && !Array.isArray(raw)) {
    const r = /** @type {Record<string, unknown>} */ (raw);
    const list = Array.isArray(r.attachments)
      ? r.attachments.map(normalizeAttachment).filter(Boolean)
      : [];
    if (list.length) return list;
    return embedImagesFromRaw(raw);
  }
  return [];
}

/** 展示用 URL：优先 proxy（部分环境直连 cdn 会 403） */
export function attachmentDisplayUrl(att) {
  if (!att || typeof att !== "object") return "";
  const proxy = String(att.proxyUrl ?? "").trim();
  const direct = String(att.url ?? "").trim();
  return proxy || direct;
}

/** @param {{ contentType?: string, filename?: string }} att */
export function isImageAttachment(att) {
  const ct = String(att.contentType ?? "").toLowerCase();
  if (ct.startsWith("image/")) return true;
  const fn = String(att.filename ?? "").toLowerCase();
  return /\.(png|jpe?g|gif|webp|bmp|svg)$/i.test(fn);
}

/** @param {Record<string, unknown>} m */
export function messageTextContent(m) {
  const text = normalizeMessageContent(m.content ?? "", { preserveLines: true });
  if (!text) return "";
  return text.length > 4000 ? `${text.slice(0, 4000)}…` : text;
}

/** @param {Record<string, unknown>} m */
export function msgAuthorId(m) {
  return String(m.authorId ?? m.author_id ?? "");
}

/** @param {Record<string, unknown>} m */
export function msgTimeMs(m) {
  return Number(m.createdAtMs ?? m.created_at_ms ?? 0);
}

export const MESSAGE_GROUP_GAP_MS = 10 * 60 * 1000;

/**
 * 同一作者、相邻消息间隔 ≤ gapMs 的合并为一组（仅首条显示头像/昵称/时间）。
 * @param {Array<Record<string, unknown>>} messages
 * @param {number} [gapMs]
 * @returns {Array<{ head: Record<string, unknown>, tail: Record<string, unknown>[] }>}
 */
export function groupChannelMessages(messages, gapMs = MESSAGE_GROUP_GAP_MS) {
  const sorted = isSortedByTimeAsc(messages)
    ? messages
    : [...messages].sort((a, b) => msgTimeMs(a) - msgTimeMs(b));
  /** @type {Array<{ head: Record<string, unknown>, tail: Record<string, unknown>[] }>} */
  const groups = [];
  for (const m of sorted) {
    const lastGroup = groups[groups.length - 1];
    const prevInGroup = lastGroup
      ? lastGroup.tail.length
        ? lastGroup.tail[lastGroup.tail.length - 1]
        : lastGroup.head
      : null;
    if (lastGroup && canMergeWithPrevious(prevInGroup, m, gapMs)) {
      lastGroup.tail.push(m);
    } else {
      groups.push({ head: m, tail: [] });
    }
  }
  return groups;
}

/** @param {Record<string, unknown> | null | undefined} prev @param {Record<string, unknown>} curr @param {number} gapMs */
function canMergeWithPrevious(prev, curr, gapMs) {
  if (!prev) return false;
  const pa = msgAuthorId(prev);
  const ca = msgAuthorId(curr);
  if (!pa || pa !== ca) return false;
  const pt = msgTimeMs(prev);
  const ct = msgTimeMs(curr);
  if (!Number.isFinite(pt) || !Number.isFinite(ct) || pt <= 0 || ct <= 0) return false;
  return ct - pt <= gapMs;
}

/**
 * @param {Array<Record<string, unknown>>} prev
 * @param {Array<Record<string, unknown>>} incoming
 */
export function countNewIncomingMessages(prev, incoming) {
  const seen = new Set(
    prev.map((m) => String(m.messageId ?? m.message_id ?? "")).filter(Boolean)
  );
  let n = 0;
  for (const m of incoming) {
    const id = String(m.messageId ?? m.message_id ?? "");
    if (!id || seen.has(id)) continue;
    const et = String(m.eventType ?? m.event_type ?? "MESSAGE_CREATE");
    if (et === "MESSAGE_UPDATE") continue;
    n += 1;
  }
  return n;
}

/**
 * @param {Array<{ channelId: string, guildId: string, name: string, lastMessagePreview: string, lastMessageAtMs: number }>} list
 * @param {{ channelId: string, guildId: string, name: string, lastMessagePreview: string, lastMessageAtMs: number }} ch
 */
export function upsertChannelItem(list, ch) {
  const idx = list.findIndex((c) => c.channelId === ch.channelId);
  if (idx >= 0) {
    const prev = list[idx];
    const prevMs = Number(prev.lastMessageAtMs ?? 0);
    const nextMs = Number(ch.lastMessageAtMs ?? prevMs);
    const nextPreview = String(ch.lastMessagePreview ?? prev.lastMessagePreview ?? "");
    const prevPreview = String(prev.lastMessagePreview ?? "");
    const nextName = ch.name || prev.name;
    const nextGuild = ch.guildId || prev.guildId;
    const settledMs = Number.isFinite(nextMs) && nextMs > 0 ? nextMs : prevMs;
    if (
      nextPreview === prevPreview &&
      settledMs <= prevMs + 500 &&
      nextName === prev.name &&
      nextGuild === prev.guildId
    ) {
      return;
    }
    list[idx] = {
      ...prev,
      ...ch,
      name: nextName,
      guildId: nextGuild,
      lastMessageAtMs: settledMs,
      lastMessagePreview: nextPreview,
    };
    // 仅在新消息时间更晚或预览变化明显时再重排，避免 REST/WS 重复推送导致侧栏抖动
    if (nextMs > prevMs + 500) {
      list.sort(
        (a, b) =>
          Number(b.lastMessageAtMs ?? 0) - Number(a.lastMessageAtMs ?? 0) ||
          a.name.localeCompare(b.name)
      );
    }
  } else {
    list.push(ch);
    list.sort(
      (a, b) =>
        Number(b.lastMessageAtMs ?? 0) - Number(a.lastMessageAtMs ?? 0) || a.name.localeCompare(b.name)
    );
  }
}

/** @param {Record<string, unknown>} row */
export function channelRowToClient(row) {
  return {
    channelId: String(row.channelId ?? row.channel_id ?? ""),
    guildId: String(row.guildId ?? row.guild_id ?? ""),
    name: String(row.name ?? ""),
    lastMessagePreview: String(row.lastMessagePreview ?? row.last_message_preview ?? ""),
    lastMessageAtMs: Number(row.lastMessageAtMs ?? row.last_message_at_ms ?? 0),
  };
}

/** @param {string} name @param {string} channelId */
export function isPlaceholderChannelName(name, channelId) {
  const n = String(name ?? "").trim();
  const id = String(channelId ?? "").trim();
  if (!n || !id) return false;
  return n === id || n === id.slice(-6);
}

/**
 * @param {{ channelId?: string, name?: string }} ch
 * @param {Record<string, string> | undefined} aliases
 */
export function channelDisplayName(ch, aliases) {
  const id = String(ch.channelId ?? "").trim();
  const alias = id && aliases?.[id]?.trim();
  if (alias) return alias;
  const name = String(ch.name ?? "").trim();
  if (name && !isPlaceholderChannelName(name, id)) return name;
  return "未命名频道";
}

/** @param {{ channelId?: string }} ch @param {number} [tailLen] */
export function channelIdShort(ch, tailLen = 5) {
  const id = String(ch.channelId ?? "").trim();
  if (!id) return "";
  return id.length > tailLen ? id.slice(-tailLen) : id;
}

/** @param {{ channelId?: string }} ch */
export function channelIdLabel(ch) {
  return String(ch.channelId ?? "").trim();
}

/** @param {string} channelId @param {Record<string, string>} aliases */
export function hasChannelAlias(channelId, aliases) {
  return Boolean(String(channelId ?? "").trim() && aliases[channelId]?.trim());
}

/**
 * @param {Array<{ channelId: string }>} channels
 * @param {string[]} pinnedIds
 */
export function splitPinnedChannels(channels, pinnedIds) {
  if (!pinnedIds?.length) {
    return { pinned: [], rest: channels.slice() };
  }
  const pinSet = new Set(pinnedIds);
  const byId = new Map(channels.map((c) => [c.channelId, c]));
  const pinned = pinnedIds.map((id) => byId.get(id)).filter(Boolean);
  const rest = channels.filter((c) => !pinSet.has(c.channelId));
  return { pinned, rest };
}

/** @typedef {{ id: string, name: string, channelIds: string[], collapsed?: boolean }} ChannelGroup */

/**
 * @param {Array<{ channelId: string }>} channels
 * @param {string[]} [orderIds]
 */
export function orderChannelsByIds(channels, orderIds = []) {
  if (!orderIds?.length) return channels.slice();
  const byId = new Map(channels.map((c) => [c.channelId, c]));
  /** @type {typeof channels} */
  const ordered = [];
  const seen = new Set();
  for (const id of orderIds) {
    const ch = byId.get(String(id));
    if (ch && !seen.has(ch.channelId)) {
      ordered.push(ch);
      seen.add(ch.channelId);
    }
  }
  for (const ch of channels) {
    if (!seen.has(ch.channelId)) ordered.push(ch);
  }
  return ordered;
}

/**
 * @param {Array<{ channelId: string }>} channels
 * @param {string[]} pinnedIds
 * @param {ChannelGroup[]} [groups]
 * @param {string[]} [ungroupedOrderIds]
 */
export function buildChannelListSections(channels, pinnedIds, groups = [], ungroupedOrderIds = []) {
  const { pinned, rest } = splitPinnedChannels(channels, pinnedIds);
  const byId = new Map(channels.map((c) => [c.channelId, c]));
  const inGroup = new Set();
  /** @type {Array<
   *   | { kind: "pinned-label" }
   *   | { kind: "group-label", group: ChannelGroup }
   *   | { kind: "ungrouped-label" }
   *   | { kind: "channel", ch: { channelId: string }, pinned?: boolean, groupId?: string }
   * >} */
  const items = [];

  if (pinned.length) {
    items.push({ kind: "pinned-label" });
    for (const ch of pinned) {
      items.push({ kind: "channel", ch, pinned: true });
    }
  }

  for (const group of groups) {
    if (!group?.id) continue;
    items.push({ kind: "group-label", group });
    if (group.collapsed) continue;
    for (const cid of group.channelIds ?? []) {
      const ch = byId.get(String(cid));
      if (!ch || inGroup.has(ch.channelId)) continue;
      inGroup.add(ch.channelId);
      items.push({ kind: "channel", ch, groupId: group.id });
    }
  }

  const ungrouped = rest.filter((c) => !inGroup.has(c.channelId));
  const sortedUngrouped = orderChannelsByIds(ungrouped, ungroupedOrderIds);
  if (groups.length && sortedUngrouped.length) {
    items.push({ kind: "ungrouped-label" });
  }
  for (const ch of groups.length ? sortedUngrouped : orderChannelsByIds(rest, ungroupedOrderIds)) {
    items.push({ kind: "channel", ch, pinned: false });
  }

  return items;
}

/** @param {unknown} raw */
export function normalizeChannelGroups(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {ChannelGroup[]} */
  const out = [];
  for (const item of raw) {
    if (item == null || typeof item !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (item);
    const id = String(o.id ?? "").trim();
    const name = String(o.name ?? "").trim() || "未命名分组";
    const channelIds = Array.isArray(o.channelIds)
      ? o.channelIds.map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];
    if (!id) continue;
    out.push({
      id,
      name,
      channelIds,
      collapsed: Boolean(o.collapsed),
    });
  }
  return out;
}

/** @returns {string} */
export function newChannelGroupId() {
  return `grp_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
}

/** @param {string} channelId @param {string[]} pinnedIds */
export function isChannelPinned(channelId, pinnedIds) {
  return pinnedIds.includes(String(channelId ?? ""));
}
