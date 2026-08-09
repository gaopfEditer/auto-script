<script setup>
import { ref, reactive, computed, onMounted, watch, nextTick } from "vue";
import { RouterLink } from "vue-router";
import SignalCardRail from "../components/SignalCardRail.vue";
import { useCollectorSocket } from "../composables/useCollectorSocket.js";
import {
  fetchGuilds,
  fetchChannels,
  fetchChannelMessages,
  fetchCdpActiveChannel,
  fetchDiscordContext,
  navigateDiscordChannel,
} from "../lib/discordApi.js";
import { fetchSignalConfig, isSignalChannelId } from "../lib/discordSignalApi.js";
import {
  fetchShowLayoutFromServer,
  hasRemoteLayoutSeeded,
  isLocalShowClient,
  markRemoteLayoutSeeded,
  putShowLayoutToServer,
} from "../lib/showLayoutSync.js";
import {
  channelRowToClient,
  channelDisplayName,
  channelIdLabel,
  channelIdShort,
  countNewIncomingMessages,
  fmtMsgTime,
  groupChannelMessages,
  guildRowToClient,
  hasChannelAlias,
  isChannelPinned,
  isImageAttachment,
  isPlaceholderChannelName,
  mergeChannelMessages,
  messageContentPreview,
  messageTextContent,
  msgAttachments,
  msgAvatarUrl,
  msgDisplayName,
  upsertChannelItem,
  buildChannelListSections,
  normalizeChannelGroups,
  newChannelGroupId,
} from "../lib/discordShow.js";

defineOptions({ name: "ShowView" });

const SHOW_CACHE_KEY = "discord-collector.show.v1";
const SHOW_LAYOUT_KEY = "discord-collector.show.layout.v1";
const SHOW_CACHE_VERSION = 5;
const MAX_MSGS_PER_CHANNEL = 300;
/** 默认固定服务器（…504831）；guild-rail 隐藏时不可切换 */
const DEFAULT_SHOW_GUILD_ID = "1444959079209504831";
const SHOW_GUILD_RAIL = false;

/** @typedef {{ guildId: string, name: string, iconUrl: string, channelCount: number }} GuildItem */
/** @typedef {{ channelId: string, guildId: string, name: string, lastMessagePreview: string, lastMessageAtMs: number }} ChannelItem */

const guilds = ref(/** @type {GuildItem[]} */ ([]));
/** @type {Record<string, ChannelItem[]>} */
const channelsByGuild = reactive({});
/** @type {Record<string, Record<string, unknown>[]>} */
const messagesByChannelId = reactive({});
/** 本地频道别名（channelId → 自定义名称），仅存浏览器 */
const channelAliases = reactive(/** @type {Record<string, string>} */ ({}));
/** 各服务器内置顶频道（guildId → channelId[]，顺序即置顶顺序） */
const pinnedChannelsByGuild = reactive(/** @type {Record<string, string[]>} */ ({}));
/** 各服务器频道自定义分组（guildId → 分组列表），仅存 localStorage */
const channelGroupsByGuild = reactive(/** @type {Record<string, import('../lib/discordShow.js').ChannelGroup[]>} */ ({}));
/** 各服务器未分组频道顺序（guildId → channelId[]） */
const ungroupedOrderByGuild = reactive(/** @type {Record<string, string[]>} */ ({}));
/** channelId → 未读条数（Gateway 实时推送） */
const unreadCountByChannelId = reactive(/** @type {Record<string, number>} */ ({}));

const selectedGuildId = ref(DEFAULT_SHOW_GUILD_ID);
/** @type {import('vue').Ref<ChannelItem | null>} */
const selectedChannel = ref(null);
/** CDP Discord 页签当前频道（由 meta / WS 推送同步） */
const cdpActiveChannelId = ref("");
const cdpActiveGuildId = ref("");

const renamingChannelId = ref("");
const renameDraft = ref("");
const renamingGroupId = ref("");
const renameGroupDraft = ref("");
const renameInputEl = ref(/** @type {HTMLInputElement | null} */ (null));

const loadingGuilds = ref(true);
const loadingChannels = ref(false);
const navPending = ref(false);
const navError = ref("");
const cacheBanner = ref("");
const avatarFailed = reactive(/** @type {Record<string, true>} */ ({}));

const msgsScrollEl = ref(/** @type {HTMLElement | null} */ (null));
const signalCardRailRef = ref(/** @type {InstanceType<typeof SignalCardRail> | null} */ (null));
const highlightMessageId = ref("");
/** @type {import('vue').Ref<{ channelIds: string[] } | null>} */
const signalConfig = ref(null);
let saveTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);

const selectedGuild = computed(() => guilds.value.find((g) => g.guildId === selectedGuildId.value) ?? null);
const currentGuildChannels = computed(() => channelsByGuild[selectedGuildId.value] ?? []);
const currentPinnedIds = computed(() => pinnedChannelsByGuild[selectedGuildId.value] ?? []);
const channelSections = computed(() => {
  const gid = selectedGuildId.value;
  return buildChannelListSections(
    currentGuildChannels.value,
    currentPinnedIds.value,
    channelGroupsByGuild[gid] ?? [],
    ungroupedOrderByGuild[gid] ?? []
  );
});
const selectedMessages = computed(() => {
  const ch = selectedChannel.value?.channelId;
  if (!ch) return [];
  return messagesByChannelId[ch] ?? [];
});

const groupedMessages = computed(() => groupChannelMessages(selectedMessages.value));

const showSignalCards = computed(() => {
  const cid = selectedChannel.value?.channelId;
  if (!cid || !signalConfig.value) return false;
  return isSignalChannelId(cid, signalConfig.value);
});

/** @param {{ channelId: string, name: string }} ch */
function displayChannelName(ch) {
  return channelDisplayName(ch, channelAliases);
}

/** @param {string} channelId */
function channelAliasTitle(channelId, originalName) {
  if (!hasChannelAlias(channelId, channelAliases)) return "双击或点 ✎ 重命名";
  return `Discord 原名：${originalName}`;
}

/** @param {ChannelItem} ch */
function channelIsPinned(ch) {
  const gid = ch.guildId || selectedGuildId.value;
  return isChannelPinned(ch.channelId, pinnedChannelsByGuild[gid] ?? []);
}

/** @param {ChannelItem} ch @param {Event} [e] */
function toggleChannelPin(ch, e) {
  e?.stopPropagation();
  e?.preventDefault();
  const gid = ch.guildId || selectedGuildId.value;
  if (!gid) return;
  const list = [...(pinnedChannelsByGuild[gid] ?? [])];
  const idx = list.indexOf(ch.channelId);
  if (idx >= 0) list.splice(idx, 1);
  else list.unshift(ch.channelId);
  if (list.length) pinnedChannelsByGuild[gid] = list;
  else delete pinnedChannelsByGuild[gid];
  saveLayoutNow();
}

/** @param {string} channelId */
function channelUnreadCount(channelId) {
  return Number(unreadCountByChannelId[String(channelId ?? "").trim()] ?? 0);
}

/** @param {string} channelId @param {number} delta */
function addChannelUnread(channelId, delta) {
  const cid = String(channelId ?? "").trim();
  if (!cid || delta <= 0) return;
  unreadCountByChannelId[cid] = (unreadCountByChannelId[cid] ?? 0) + delta;
}

/** @param {string} channelId */
function clearChannelUnread(channelId) {
  const cid = String(channelId ?? "").trim();
  if (cid && unreadCountByChannelId[cid]) delete unreadCountByChannelId[cid];
}

/** @param {string} guildId */
function guildUnreadCount(guildId) {
  const gid = String(guildId ?? "").trim();
  if (!gid) return 0;
  return (channelsByGuild[gid] ?? []).reduce((sum, ch) => sum + channelUnreadCount(ch.channelId), 0);
}

/** @param {string} channelId */
function formatUnreadBadge(channelId) {
  const n = channelUnreadCount(channelId);
  if (n <= 0) return "";
  return n > 99 ? "99+" : String(n);
}

function createChannelGroup() {
  const gid = selectedGuildId.value;
  if (!gid) return;
  const newGroup = {
    id: newChannelGroupId(),
    name: "新分组",
    channelIds: [],
    collapsed: false,
  };
  channelGroupsByGuild[gid] = [newGroup, ...(channelGroupsByGuild[gid] ?? [])];
  void nextTick(() => startRenameGroup(newGroup));
  saveLayoutNow();
}

/** @param {{ id: string, name: string, channelIds?: string[], collapsed?: boolean }} group */
function toggleGroupCollapsed(group) {
  if (suppressGroupClick.value) return;
  const gid = selectedGuildId.value;
  if (!gid) return;
  const groups = channelGroupsByGuild[gid] ?? [];
  channelGroupsByGuild[gid] = groups.map((g) =>
    g.id === group.id ? { ...g, collapsed: !g.collapsed } : g
  );
  saveLayoutNow();
}

/** @param {{ id: string }} group */
function deleteChannelGroup(group) {
  const gid = selectedGuildId.value;
  if (!gid) return;
  const list = channelGroupsByGuild[gid];
  if (!list) return;
  const next = list.filter((g) => g.id !== group.id);
  if (next.length) channelGroupsByGuild[gid] = next;
  else delete channelGroupsByGuild[gid];
  if (renamingGroupId.value === group.id) cancelRenameGroup();
  saveLayoutNow();
}

/** @param {{ id: string, name: string }} group */
function startRenameGroup(group) {
  renamingGroupId.value = group.id;
  renameGroupDraft.value = group.name;
  void nextTick(() => renameInputEl.value?.focus());
}

function cancelRenameGroup() {
  renamingGroupId.value = "";
  renameGroupDraft.value = "";
}

function commitRenameGroup() {
  const gid = selectedGuildId.value;
  const id = renamingGroupId.value;
  if (!gid || !id) return;
  const next = String(renameGroupDraft.value ?? "").trim();
  const groups = channelGroupsByGuild[gid] ?? [];
  channelGroupsByGuild[gid] = groups.map((g) => (g.id === id && next ? { ...g, name: next } : g));
  cancelRenameGroup();
  saveLayoutNow();
}

/** @param {ChannelItem} ch @param {string} groupId @param {{ beforeChannelId?: string }} [opts] */
function moveChannelToGroup(ch, groupId, opts = {}) {
  const gid = selectedGuildId.value;
  if (!gid) return;
  const cid = String(ch.channelId ?? "").trim();
  if (!cid) return;
  const groups = channelGroupsByGuild[gid] ?? [];
  const nextGroups = groups.map((g) => ({
    ...g,
    channelIds: (g.channelIds ?? []).filter((id) => id !== cid),
  }));
  if (groupId) {
    const idx = nextGroups.findIndex((g) => g.id === groupId);
    if (idx >= 0) {
      const target = nextGroups[idx];
      const ids = (target.channelIds ?? []).filter((id) => id !== cid);
      const before = String(opts.beforeChannelId ?? "").trim();
      if (before && ids.includes(before)) {
        ids.splice(ids.indexOf(before), 0, cid);
      } else {
        ids.push(cid);
      }
      nextGroups[idx] = { ...target, channelIds: ids, collapsed: false };
    }
  }
  channelGroupsByGuild[gid] = nextGroups;
  saveLayoutNow();
}

/** @param {string} gid */
function getUngroupedChannelIds(gid) {
  const channels = channelsByGuild[gid] ?? [];
  const pinned = new Set(pinnedChannelsByGuild[gid] ?? []);
  const inGroup = new Set();
  for (const g of channelGroupsByGuild[gid] ?? []) {
    for (const id of g.channelIds ?? []) inGroup.add(String(id));
  }
  return channels
    .filter((c) => !pinned.has(c.channelId) && !inGroup.has(c.channelId))
    .map((c) => c.channelId);
}

/** @param {string[]} currentIds @param {string[]} orderIds */
function mergeOrderIds(currentIds, orderIds) {
  const set = new Set(currentIds);
  /** @type {string[]} */
  const result = [];
  for (const id of orderIds) {
    if (set.has(id)) {
      result.push(id);
      set.delete(id);
    }
  }
  for (const id of currentIds) {
    if (set.has(id)) result.push(id);
  }
  return result;
}

/** @param {string} dragCid @param {string} [beforeCid] */
function reorderUngroupedChannel(dragCid, beforeCid = "") {
  const gid = selectedGuildId.value;
  if (!gid || !dragCid) return;
  const current = getUngroupedChannelIds(gid);
  let order = mergeOrderIds(current, ungroupedOrderByGuild[gid] ?? []);
  order = order.filter((id) => id !== dragCid);
  if (beforeCid) {
    const idx = order.indexOf(beforeCid);
    if (idx >= 0) order.splice(idx, 0, dragCid);
    else order.push(dragCid);
  } else {
    order.push(dragCid);
  }
  ungroupedOrderByGuild[gid] = order;
  saveLayoutNow();
}

/** @param {string} dragCid @param {string} beforeCid */
function reorderPinnedChannel(dragCid, beforeCid) {
  const gid = selectedGuildId.value;
  if (!gid || !dragCid) return;
  const list = [...(pinnedChannelsByGuild[gid] ?? [])];
  if (!list.includes(dragCid)) return;
  const next = list.filter((id) => id !== dragCid);
  const idx = next.indexOf(beforeCid);
  if (idx >= 0) next.splice(idx, 0, dragCid);
  else next.push(dragCid);
  pinnedChannelsByGuild[gid] = next;
  saveLayoutNow();
}

const dragChannelId = ref("");
/** @type {import('vue').Ref<string>} '' | '__ungrouped__' | groupId */
const dropHighlightTarget = ref("");
const dropBeforeChannelId = ref("");
const suppressGroupClick = ref(false);

/** @param {ChannelItem} ch @param {DragEvent} e */
function onChannelDragStart(ch, e) {
  const cid = String(ch.channelId ?? "").trim();
  if (!cid) return;
  if (renamingChannelId.value === cid) {
    e.preventDefault();
    return;
  }
  dragChannelId.value = cid;
  dropHighlightTarget.value = "";
  dropBeforeChannelId.value = "";
  e.dataTransfer?.setData("text/plain", cid);
  if (e.dataTransfer) e.dataTransfer.effectAllowed = "move";
}

function onChannelDragEnd() {
  dragChannelId.value = "";
  dropHighlightTarget.value = "";
  dropBeforeChannelId.value = "";
}

/** @param {DragEvent} e @param {string} target */
function onDropZoneDragOver(e, target) {
  if (!dragChannelId.value) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  dropHighlightTarget.value = target;
}

/** @param {string} target */
function onDropZoneDragLeave(target) {
  if (dropHighlightTarget.value === target) dropHighlightTarget.value = "";
}

/** @param {DragEvent} e @param {string} groupId */
function onDropToGroup(e, groupId) {
  e.preventDefault();
  e.stopPropagation();
  const cid = dragChannelId.value || e.dataTransfer?.getData("text/plain") || "";
  if (!cid) return;
  const ch = currentGuildChannels.value.find((c) => c.channelId === cid);
  if (ch) moveChannelToGroup(ch, groupId);
  suppressGroupClick.value = true;
  onChannelDragEnd();
  requestAnimationFrame(() => {
    suppressGroupClick.value = false;
  });
}

/** @param {DragEvent} e */
function onDropToUngrouped(e) {
  e.preventDefault();
  e.stopPropagation();
  const cid = dragChannelId.value || e.dataTransfer?.getData("text/plain") || "";
  if (!cid) return;
  const ch = currentGuildChannels.value.find((c) => c.channelId === cid);
  if (ch) {
    moveChannelToGroup(ch, "");
    reorderUngroupedChannel(cid);
  }
  onChannelDragEnd();
}

/** @param {ChannelItem} targetCh */
function onChannelDragLeave(targetCh) {
  const tid = String(targetCh.channelId ?? "").trim();
  if (dropBeforeChannelId.value === tid) dropBeforeChannelId.value = "";
}

/**
 * @param {DragEvent} e
 * @param {ChannelItem} targetCh
 * @param {{ groupId?: string, pinned?: boolean }} [ctx]
 */
function onChannelDragOver(e, targetCh, ctx = {}) {
  const cid = dragChannelId.value;
  const tid = String(targetCh.channelId ?? "").trim();
  if (!cid || cid === tid) return;
  e.preventDefault();
  if (e.dataTransfer) e.dataTransfer.dropEffect = "move";
  dropBeforeChannelId.value = tid;
  const groupId = ctx.groupId ?? "";
  dropHighlightTarget.value = ctx.pinned ? "__pinned__" : groupId || "__ungrouped__";
}

/**
 * @param {DragEvent} e
 * @param {ChannelItem} targetCh
 * @param {{ groupId?: string, pinned?: boolean }} [ctx]
 */
function onDropOnChannel(e, targetCh, ctx = {}) {
  e.preventDefault();
  e.stopPropagation();
  const cid = dragChannelId.value || e.dataTransfer?.getData("text/plain") || "";
  const tid = String(targetCh.channelId ?? "").trim();
  if (!cid || cid === tid) return;
  const ch = currentGuildChannels.value.find((c) => c.channelId === cid);
  if (!ch) return;
  const groupId = ctx.groupId ?? "";
  if (ctx.pinned) {
    reorderPinnedChannel(cid, tid);
  } else if (groupId) {
    moveChannelToGroup(ch, groupId, { beforeChannelId: tid });
  } else {
    moveChannelToGroup(ch, "");
    reorderUngroupedChannel(cid, tid);
  }
  onChannelDragEnd();
}

/** @param {{ kind: string, ch?: ChannelItem, group?: { id: string } }} item */
function sectionItemKey(item) {
  if (item.kind === "pinned-label") return "pinned-label";
  if (item.kind === "ungrouped-label") return "ungrouped-label";
  if (item.kind === "group-label" && item.group) return `group-${item.group.id}`;
  if (item.kind === "channel" && item.ch) return `ch-${item.ch.channelId}`;
  return `x-${Math.random()}`;
}

/** @returns {Record<string, unknown>} */
function buildLayoutPayload() {
  return {
    v: 1,
    savedAt: Date.now(),
    channelAliases: { ...channelAliases },
    pinnedChannelsByGuild: JSON.parse(JSON.stringify(pinnedChannelsByGuild)),
    channelGroupsByGuild: JSON.parse(JSON.stringify(channelGroupsByGuild)),
    ungroupedOrderByGuild: { ...ungroupedOrderByGuild },
    selectedGuildId: selectedGuildId.value,
    selectedChannel: selectedChannel.value,
  };
}

/** 本地客户端才回写后台（域名客户端只改 localStorage） */
const canWriteShowLayoutServer = isLocalShowClient();
/** @type {ReturnType<typeof setTimeout> | null} */
let serverLayoutSaveTimer = null;

function scheduleServerLayoutSave() {
  if (!canWriteShowLayoutServer) return;
  if (serverLayoutSaveTimer) clearTimeout(serverLayoutSaveTimer);
  serverLayoutSaveTimer = setTimeout(() => {
    serverLayoutSaveTimer = null;
    const payload = buildLayoutPayload();
    void putShowLayoutToServer(payload).catch(() => {
      /* 后台暂不可用时忽略，本地已保存 */
    });
  }, 600);
}

/** 布局（置顶 / 分组 / 别名 / 排序）立即写入独立 localStorage；本机再同步后台 */
function saveLayoutNow() {
  try {
    localStorage.setItem(SHOW_LAYOUT_KEY, JSON.stringify(buildLayoutPayload()));
  } catch {
    /* quota */
  }
  scheduleServerLayoutSave();
}

/**
 * 初始化布局：域名首次读后台一次；本机读 localStorage，空则拉后台。
 */
async function initShowLayout() {
  if (!canWriteShowLayoutServer) {
    // 域名：只在从未 seeded 时拉一次后台，之后只信 localStorage
    if (!hasRemoteLayoutSeeded()) {
      try {
        const remote = await fetchShowLayoutFromServer();
        if (remote.ok && remote.layout) {
          applyLayoutFromObject(remote.layout);
          try {
            localStorage.setItem(
              SHOW_LAYOUT_KEY,
              JSON.stringify({ ...remote.layout, savedAt: Date.now(), v: 1 })
            );
          } catch {
            /* quota */
          }
        } else {
          loadLayoutCache();
        }
      } catch {
        loadLayoutCache();
      }
      markRemoteLayoutSeeded();
      return;
    }
    loadLayoutCache();
    return;
  }

  // 本机：优先本地；若无置顶布局再拉后台种子
  const hadLocal = loadLayoutCache();
  const pinKeys = Object.keys(pinnedChannelsByGuild);
  if (hadLocal && pinKeys.length) return;
  try {
    const remote = await fetchShowLayoutFromServer();
    if (remote.ok && remote.layout && Object.keys(remote.layout.pinnedChannelsByGuild || {}).length) {
      applyLayoutFromObject(remote.layout);
      try {
        localStorage.setItem(
          SHOW_LAYOUT_KEY,
          JSON.stringify({ ...remote.layout, savedAt: Date.now(), v: 1 })
        );
      } catch {
        /* quota */
      }
    }
  } catch {
    /* ignore */
  }
}

/** @param {Record<string, unknown>} o */
function applyLayoutFromObject(o) {
  if (o.channelAliases && typeof o.channelAliases === "object") {
    for (const [k, v] of Object.entries(o.channelAliases)) {
      if (typeof v === "string" && v.trim()) channelAliases[k] = v.trim();
    }
  }
  if (o.pinnedChannelsByGuild && typeof o.pinnedChannelsByGuild === "object") {
    for (const [k, v] of Object.entries(o.pinnedChannelsByGuild)) {
      if (!Array.isArray(v)) continue;
      const ids = v.map((id) => String(id ?? "").trim()).filter(Boolean);
      if (ids.length) pinnedChannelsByGuild[k] = ids;
    }
  }
  if (o.channelGroupsByGuild && typeof o.channelGroupsByGuild === "object") {
    for (const [k, v] of Object.entries(o.channelGroupsByGuild)) {
      const groups = normalizeChannelGroups(v);
      if (groups.length) channelGroupsByGuild[k] = groups;
    }
  }
  if (o.ungroupedOrderByGuild && typeof o.ungroupedOrderByGuild === "object") {
    for (const [k, v] of Object.entries(o.ungroupedOrderByGuild)) {
      if (!Array.isArray(v)) continue;
      const ids = v.map((id) => String(id ?? "").trim()).filter(Boolean);
      if (ids.length) ungroupedOrderByGuild[k] = ids;
    }
  }
  if (o.selectedGuildId) selectedGuildId.value = String(o.selectedGuildId);
  if (o.selectedChannel) selectedChannel.value = /** @type {ChannelItem} */ (o.selectedChannel);
  if (!SHOW_GUILD_RAIL) {
    selectedGuildId.value = DEFAULT_SHOW_GUILD_ID;
    if (
      selectedChannel.value &&
      String(selectedChannel.value.guildId || "") !== DEFAULT_SHOW_GUILD_ID
    ) {
      selectedChannel.value = null;
    }
  }
}

function loadLayoutCache() {
  try {
    const layoutRaw = localStorage.getItem(SHOW_LAYOUT_KEY);
    if (layoutRaw) {
      applyLayoutFromObject(JSON.parse(layoutRaw));
      return true;
    }
    const mainRaw = localStorage.getItem(SHOW_CACHE_KEY);
    if (!mainRaw) return false;
    const o = JSON.parse(mainRaw);
    if (
      o.pinnedChannelsByGuild ||
      o.channelGroupsByGuild ||
      o.channelAliases ||
      o.ungroupedOrderByGuild
    ) {
      applyLayoutFromObject(o);
      saveLayoutNow();
      return true;
    }
    return false;
  } catch {
    return false;
  }
}

function saveCache() {
  try {
    /** @type {Record<string, Record<string, unknown>[]>} */
    const msgs = {};
    for (const [k, arr] of Object.entries(messagesByChannelId)) {
      if (Array.isArray(arr) && arr.length) {
        msgs[k] = arr.slice(-MAX_MSGS_PER_CHANNEL);
      }
    }
    localStorage.setItem(
      SHOW_CACHE_KEY,
      JSON.stringify({
        v: SHOW_CACHE_VERSION,
        savedAt: Date.now(),
        guilds: guilds.value,
        channelsByGuild: { ...channelsByGuild },
        messagesByChannelId: msgs,
        channelAliases: { ...channelAliases },
        pinnedChannelsByGuild: { ...pinnedChannelsByGuild },
        channelGroupsByGuild: { ...channelGroupsByGuild },
        ungroupedOrderByGuild: { ...ungroupedOrderByGuild },
        unreadCountByChannelId: { ...unreadCountByChannelId },
        selectedGuildId: selectedGuildId.value,
        selectedChannel: selectedChannel.value,
      })
    );
    saveLayoutNow();
  } catch {
    /* quota — 布局仍可通过 saveLayoutNow 单独保存 */
    saveLayoutNow();
  }
}

function scheduleSave() {
  if (saveTimer) clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    saveTimer = null;
    saveCache();
  }, 400);
}

function loadCache() {
  try {
    const raw = localStorage.getItem(SHOW_CACHE_KEY);
    if (!raw) return false;
    const o = JSON.parse(raw);
    if (Number(o.v) !== SHOW_CACHE_VERSION && Number(o.v) !== 4 && Number(o.v) !== 3 && Number(o.v) !== 2) return false;
    if (Array.isArray(o.guilds) && o.guilds.length) guilds.value = o.guilds;
    if (o.channelsByGuild && typeof o.channelsByGuild === "object") {
      for (const [k, v] of Object.entries(o.channelsByGuild)) {
        if (Array.isArray(v)) channelsByGuild[k] = /** @type {ChannelItem[]} */ (v);
      }
    }
    if (o.messagesByChannelId && typeof o.messagesByChannelId === "object") {
      for (const [k, v] of Object.entries(o.messagesByChannelId)) {
        if (Array.isArray(v)) messagesByChannelId[k] = v;
      }
    }
    if (o.unreadCountByChannelId && typeof o.unreadCountByChannelId === "object") {
      for (const [k, v] of Object.entries(o.unreadCountByChannelId)) {
        const n = Number(v);
        if (k && Number.isFinite(n) && n > 0) unreadCountByChannelId[k] = n;
      }
    }
    const t = Number(o.savedAt);
    if (t) {
      cacheBanner.value = `已恢复本地缓存（${new Date(t).toLocaleString("zh-CN")}）`;
      setTimeout(() => {
        cacheBanner.value = "";
      }, 5000);
    }
    return guilds.value.length > 0;
  } catch {
    return false;
  }
}

async function reloadGuilds() {
  loadingGuilds.value = true;
  try {
    const rows = await fetchGuilds();
    guilds.value = rows.map((r) => guildRowToClient(r));
    if (!guilds.value.length) {
      await inferGuildsFromContext();
    }
    if (!SHOW_GUILD_RAIL) {
      selectedGuildId.value = DEFAULT_SHOW_GUILD_ID;
    } else if (!selectedGuildId.value && guilds.value.length) {
      selectedGuildId.value = guilds.value[0].guildId;
    }
    scheduleSave();
  } finally {
    loadingGuilds.value = false;
  }
}

async function inferGuildsFromContext() {
  try {
    const snapshot = await fetchDiscordContext();
    const rawGuilds = snapshot.guilds;
    if (rawGuilds && typeof rawGuilds === "object") {
      const inferred = Object.entries(/** @type {Record<string, Record<string, unknown>>} */ (rawGuilds)).map(
        ([guildId, g]) => ({
          guildId,
          name: String(g?.name ?? `Server ${guildId.slice(-6)}`),
          iconUrl: g?.iconUrl ? String(g.iconUrl) : null,
        })
      );
      if (inferred.length) {
        guilds.value = inferred;
        return;
      }
    }
  } catch {
    /* ignore */
  }
  const cachedIds = Object.keys(channelsByGuild).filter(Boolean);
  if (cachedIds.length) {
    guilds.value = cachedIds.map((guildId) => ({
      guildId,
      name: `Server ${guildId.slice(-6)}`,
      iconUrl: null,
    }));
  }
}

/** @param {string} guildId */
async function loadChannelsForGuild(guildId, { force = false } = {}) {
  if (!guildId) return;
  const existing = channelsByGuild[guildId] ?? [];
  if (!force && existing.length) return;
  // 仅首次空列表时显示「加载频道…」；WS/强制刷新做静默合并，避免闪屏
  const showLoading = existing.length === 0;
  if (showLoading) loadingChannels.value = true;
  try {
    const rows = await fetchChannels(guildId);
    const mapped = rows.map((r) => channelRowToClient(r));
    if (!mapped.length && existing.length) return;
    if (!existing.length) {
      channelsByGuild[guildId] = mapped;
    } else {
      for (const ch of mapped) {
        upsertChannelItem(channelsByGuild[guildId], ch);
      }
    }
    scheduleSave();
  } finally {
    if (showLoading) loadingChannels.value = false;
  }
}

/** @param {ChannelItem} ch */
async function loadMessagesForChannel(ch) {
  const rows = await fetchChannelMessages({
    channelId: ch.channelId,
    guildId: ch.guildId || selectedGuildId.value,
    limit: 200,
  });
  const prev = messagesByChannelId[ch.channelId] ?? [];
  messagesByChannelId[ch.channelId] = mergeChannelMessages(prev, rows);
  scheduleSave();
  await nextTick();
  scrollMsgsBottom();
}

/** @param {string} channelId @param {string} [guildId] */
function updateCdpActive(channelId, guildId = "") {
  const cid = String(channelId ?? "").trim();
  const gid = String(guildId ?? "").trim();
  if (cid) cdpActiveChannelId.value = cid;
  if (gid) cdpActiveGuildId.value = gid;
}

/**
 * 更新侧边栏频道元数据，可选是否接管当前选中项。
 * @param {Record<string, unknown>} m
 * @param {{ adoptSelection?: boolean }} [opts]
 */
async function syncViewToIncomingMessage(m, opts = {}) {
  const adoptSelection = opts.adoptSelection !== false;
  const cid = String(m.channelId ?? m.channel_id ?? "");
  if (!cid) return;
  let gid = String(m.guildId ?? m.guild_id ?? "");

  if (!gid) {
    for (const [g, list] of Object.entries(channelsByGuild)) {
      if (list.some((c) => c.channelId === cid)) {
        gid = g;
        break;
      }
    }
  }

  const bucket = gid || selectedGuildId.value;

  if (adoptSelection && gid && gid !== selectedGuildId.value) {
    if (!SHOW_GUILD_RAIL) {
      // 固定单服：其它服务器消息不切换视图
      return;
    }
    selectedGuildId.value = gid;
    await loadChannelsForGuild(gid, { force: true });
  }

  if (bucket) {
    if (!SHOW_GUILD_RAIL && bucket !== DEFAULT_SHOW_GUILD_ID) return;
    let ch = channelsByGuild[bucket]?.find((c) => c.channelId === cid);
    if (!ch) {
      ch = {
        channelId: cid,
        guildId: bucket,
        name: resolveChannelName(m, cid),
        lastMessagePreview: messageContentPreview(m),
        lastMessageAtMs: Number(m.createdAtMs ?? m.created_at_ms ?? 0),
      };
      if (!channelsByGuild[bucket]) channelsByGuild[bucket] = [];
      upsertChannelItem(channelsByGuild[bucket], ch);
    }
    if (adoptSelection) {
      selectedChannel.value = ch;
    }
    return;
  }

  if (!adoptSelection) return;

  selectedChannel.value = {
    channelId: cid,
    guildId: "",
    name: resolveChannelName(m, cid),
    lastMessagePreview: messageContentPreview(m),
    lastMessageAtMs: Number(m.createdAtMs ?? m.created_at_ms ?? 0),
  };
}

/** @param {GuildItem} g */
async function selectGuild(g) {
  selectedGuildId.value = g.guildId;
  selectedChannel.value = null;
  await loadChannelsForGuild(g.guildId);
}

/** 选频道序号：快速连点时丢弃过期的二次拉库 */
let selectChannelSeq = 0;
/** 同一频道短时间重复点击：跳过 CDP（部署后尤其重要） */
const CDP_SAME_CHANNEL_DEBOUNCE_MS = 12_000;
const DB_RELOAD_SAME_CHANNEL_MS = 2_000;
let lastSelectChannelId = "";
let lastDbReloadAt = 0;
let lastCdpNavChannelId = "";
let lastCdpNavAt = 0;

/** @param {ChannelItem} ch */
async function selectChannel(ch) {
  if (renamingChannelId.value && renamingChannelId.value !== ch.channelId) {
    commitRename();
  }
  const seq = ++selectChannelSeq;
  const sameChannel = lastSelectChannelId === ch.channelId;
  lastSelectChannelId = ch.channelId;
  selectedChannel.value = ch;
  clearChannelUnread(ch.channelId);
  const cached = messagesByChannelId[ch.channelId] ?? [];
  if (cached.length) {
    await nextTick();
    scrollMsgsBottom();
  }
  const now = Date.now();
  const skipDb =
    sameChannel && cached.length > 0 && now - lastDbReloadAt < DB_RELOAD_SAME_CHANNEL_MS;
  const skipCdp =
    sameChannel &&
    ch.channelId === lastCdpNavChannelId &&
    now - lastCdpNavAt < CDP_SAME_CHANNEL_DEBOUNCE_MS;
  if (skipDb && skipCdp) return;
  try {
    if (!skipDb) {
      await loadMessagesForChannel(ch);
      lastDbReloadAt = Date.now();
    }
    if (seq !== selectChannelSeq || skipCdp) return;
    const gid = ch.guildId || selectedGuildId.value;
    if (!gid) return;
    lastCdpNavChannelId = ch.channelId;
    lastCdpNavAt = Date.now();
    // CDP 打开频道触发 Discord 拉历史，稍后再拉一次库
    void (async () => {
      try {
        await navigateDiscordChannel(gid, ch.channelId);
      } catch (e) {
        if (seq === selectChannelSeq) {
          navError.value = String(/** @type {Error} */ (e).message ?? e);
        }
        return;
      }
      await new Promise((r) => setTimeout(r, 2500));
      if (seq !== selectChannelSeq || selectedChannel.value?.channelId !== ch.channelId) return;
      try {
        await loadMessagesForChannel(ch);
        lastDbReloadAt = Date.now();
      } catch {
        /* ignore */
      }
    })();
  } catch (e) {
    if (seq === selectChannelSeq) {
      navError.value = String(/** @type {Error} */ (e).message ?? e);
    }
  }
}

/** @param {ChannelItem} ch @param {Event} [e] */
async function startRenameChannel(ch, e) {
  e?.stopPropagation();
  e?.preventDefault();
  renamingChannelId.value = ch.channelId;
  renameDraft.value = displayChannelName(ch);
  await nextTick();
  renameInputEl.value?.focus();
  renameInputEl.value?.select();
}

function commitRename() {
  const id = renamingChannelId.value;
  if (!id) return;
  const next = renameDraft.value.trim();
  const ch =
    Object.values(channelsByGuild)
      .flat()
      .find((c) => c.channelId === id) ??
    (selectedChannel.value?.channelId === id ? selectedChannel.value : null);
  const original = String(ch?.name ?? "").trim();

  if (!next || next === original) {
    delete channelAliases[id];
  } else {
    channelAliases[id] = next;
  }

  renamingChannelId.value = "";
  renameDraft.value = "";
  saveLayoutNow();
}

function cancelRename() {
  renamingChannelId.value = "";
  renameDraft.value = "";
}

/** @param {ChannelItem} ch @param {Event} e */
function resetChannelAlias(ch, e) {
  e.stopPropagation();
  delete channelAliases[ch.channelId];
  if (renamingChannelId.value === ch.channelId) cancelRename();
  saveLayoutNow();
}

function scrollMsgsBottom() {
  const el = msgsScrollEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

/** @param {string} messageId */
async function scrollToSignalMessage(messageId) {
  const mid = String(messageId ?? "").trim();
  if (!mid) return;
  navError.value = "";
  await nextTick();
  const root = msgsScrollEl.value;
  if (!root) return;
  let el = root.querySelector(`[data-message-id="${CSS.escape(mid)}"]`);
  if (!el && selectedChannel.value) {
    try {
      await loadMessagesForChannel(selectedChannel.value);
      await nextTick();
      el = root.querySelector(`[data-message-id="${CSS.escape(mid)}"]`);
    } catch {
      /* ignore */
    }
  }
  if (!el) {
    navError.value = "未找到该信号对应的消息，可能尚未采集到本地。";
    return;
  }
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  highlightMessageId.value = mid;
  window.setTimeout(() => {
    if (highlightMessageId.value === mid) highlightMessageId.value = "";
  }, 2800);
}

/** @param {import('../lib/discordSignalApi.js').SignalCard} card */
function onSignalCardUpdated(card) {
  signalCardRailRef.value?.upsertCard(card);
}

/** @param {Record<string, unknown>} m */
function messageDomId(m) {
  return String(m.messageId ?? m.message_id ?? "");
}

/** @param {Record<string, unknown>} m */
function isHighlightedMessage(m) {
  const mid = messageDomId(m);
  return mid && highlightMessageId.value === mid;
}

/** 向上翻页插入旧消息后保持视口位置 */
function preserveScrollAfterPrepend(prevHeight, prevTop) {
  const el = msgsScrollEl.value;
  if (!el) return;
  el.scrollTop = prevTop + (el.scrollHeight - prevHeight);
}

/** @param {string} id */
function onAvatarError(id) {
  if (id) avatarFailed[id] = true;
}

/** @param {Record<string, unknown>} m */
function avatarErrorKey(m) {
  return String(m.authorId ?? m.author_id ?? m.messageId ?? m.message_id ?? "");
}

/** @param {string} guildId */
function guildInitial(guildId, name) {
  const n = String(name ?? "").trim();
  if (n) return n.slice(0, 2).toUpperCase();
  return String(guildId).slice(-2);
}

/** @param {string} channelId @param {string} [guildId] */
function resolveGuildBucket(channelId, guildId = "") {
  const gid = String(guildId ?? "").trim();
  if (gid) return gid;
  const cid = String(channelId ?? "").trim();
  if (cid) {
    for (const [g, list] of Object.entries(channelsByGuild)) {
      if (list.some((c) => c.channelId === cid)) return g;
    }
  }
  return selectedGuildId.value || "";
}

/** @param {Record<string, unknown>} row @param {string} channelId */
function resolveChannelName(row, channelId) {
  const cid = String(channelId ?? "").trim();
  const raw = String(row.name ?? row.channelName ?? row.channel_name ?? "").trim();
  if (raw && !isPlaceholderChannelName(raw, cid)) return raw;
  for (const list of Object.values(channelsByGuild)) {
    const hit = list.find((c) => c.channelId === cid);
    if (hit?.name && !isPlaceholderChannelName(hit.name, cid)) return hit.name;
  }
  return "";
}

/** @param {Record<string, unknown>} row */
function applyChannelUpdate(row) {
  const cid = String(row.channelId ?? row.channel_id ?? "").trim();
  const gid = String(row.guildId ?? row.guild_id ?? "").trim();
  if (!cid) return;
  const preview = String(row.lastMessagePreview ?? row.last_message_preview ?? "");
  const item = {
    channelId: cid,
    guildId: gid,
    name: resolveChannelName(row, cid),
    lastMessagePreview: preview,
    lastMessageAtMs: Number(row.lastMessageAtMs ?? row.last_message_at_ms ?? 0),
  };
  const bucket = resolveGuildBucket(cid, gid);
  if (!bucket) return;
  if (!channelsByGuild[bucket]) channelsByGuild[bucket] = [];
  upsertChannelItem(channelsByGuild[bucket], item);
}

/** @param {Array<Record<string, unknown>>} rows */
function sortMessagesByTime(rows) {
  return [...rows].sort(
    (a, b) => Number(a.createdAtMs ?? a.created_at_ms ?? 0) - Number(b.createdAtMs ?? b.created_at_ms ?? 0)
  );
}

/** @param {Record<string, unknown>} msg */
function onSocketMsg(msg) {
  if (msg.channel === "meta") {
    if (msg.kind === "guilds_updated") void reloadGuilds();
    if (msg.kind === "channels_updated" && msg.guildId) {
      void loadChannelsForGuild(String(msg.guildId), { force: true });
    }
    if (msg.kind === "cdp_active_channel") {
      updateCdpActive(String(msg.channelId ?? ""), String(msg.guildId ?? ""));
    }
    if (msg.kind === "signal_card_created" && msg.card && typeof msg.card === "object") {
      const card = /** @type {Record<string, unknown>} */ (msg.card);
      const cid = String(card.channelId ?? "");
      if (selectedChannel.value?.channelId === cid) {
        signalCardRailRef.value?.upsertCard(/** @type {import("../lib/discordSignalApi.js").SignalCard} */ (card));
      }
    }
    return;
  }
  if (msg.channel !== "message" || msg.kind !== "discord_message_batch") return;

  if (msg.cdpChannelId) {
    updateCdpActive(String(msg.cdpChannelId ?? ""), String(msg.cdpGuildId ?? ""));
  }

  const batch = Array.isArray(msg.rows) ? msg.rows : [];
  const channelUpdates = Array.isArray(msg.channels) ? msg.channels : [];
  const isRestBatch = msg.source === "rest_api";
  const restQuery = msg.restQuery && typeof msg.restQuery === "object"
    ? /** @type {{ channelId?: string, before?: string, after?: string, limit?: number }} */ (msg.restQuery)
    : null;
  const isBeforePagination = Boolean(restQuery?.before);
  const restChannelId = String(
    restQuery?.channelId ?? batch[0]?.channelId ?? batch[0]?.channel_id ?? ""
  );
  const scrollEl =
    isBeforePagination && selectedChannel.value?.channelId === restChannelId
      ? msgsScrollEl.value
      : null;
  const prevScrollHeight = isBeforePagination && scrollEl ? scrollEl.scrollHeight : 0;
  const prevScrollTop = isBeforePagination && scrollEl ? scrollEl.scrollTop : 0;

  for (const ch of channelUpdates) {
    applyChannelUpdate(ch);
  }

  /** @type {Map<string, Record<string, unknown>[]>} */
  const batchByChannel = new Map();
  for (const m of batch) {
    if (isRestBatch && restChannelId) {
      m.channelId = restChannelId;
      m.channel_id = restChannelId;
    }
    const cid = String(m.channelId ?? m.channel_id ?? restChannelId ?? "");
    if (!cid) continue;
    if (!batchByChannel.has(cid)) batchByChannel.set(cid, []);
    batchByChannel.get(cid).push(m);
  }

  let needReloadGuilds = false;
  for (const [cid, rows] of batchByChannel) {
    const prev = messagesByChannelId[cid] ?? [];
    if (!isRestBatch) {
      const newCount = countNewIncomingMessages(prev, rows);
      const isActive = selectedChannel.value?.channelId === cid;
      if (newCount > 0) {
        if (isActive) clearChannelUnread(cid);
        else addChannelUnread(cid, newCount);
      }
    }
    if (isRestBatch && !isBeforePagination) {
      messagesByChannelId[cid] = sortMessagesByTime(rows);
    } else {
      messagesByChannelId[cid] = mergeChannelMessages(prev, rows);
    }

    const latest = rows.reduce((a, b) =>
      Number(a.createdAtMs ?? a.created_at_ms ?? 0) >= Number(b.createdAtMs ?? b.created_at_ms ?? 0)
        ? a
        : b
    );
    const chMeta = channelUpdates.find((c) => String(c.channelId ?? c.channel_id ?? "") === cid);
    const gid = String(latest.guildId ?? latest.guild_id ?? chMeta?.guildId ?? chMeta?.guild_id ?? "");
    if (!isBeforePagination) {
      applyChannelUpdate({
        channelId: cid,
        guildId: gid,
        name: latest.channelName ?? latest.channel_name,
        lastMessagePreview: messageContentPreview(latest),
        lastMessageAtMs: Number(latest.createdAtMs ?? latest.created_at_ms ?? 0),
      });
    }

    if (gid && !guilds.value.some((g) => g.guildId === gid)) {
      needReloadGuilds = true;
    }
  }

  if (needReloadGuilds) void reloadGuilds();

  if (isRestBatch) {
    if (!isBeforePagination && restChannelId) {
      const chUp = channelUpdates.find(
        (c) => String(c.channelId ?? c.channel_id ?? "") === restChannelId
      );
      const rows = batchByChannel.get(restChannelId) ?? [];
      const latest =
        rows.length > 0
          ? rows.reduce((a, b) =>
              Number(a.createdAtMs ?? a.created_at_ms ?? 0) >= Number(b.createdAtMs ?? b.created_at_ms ?? 0)
                ? a
                : b
            )
          : null;
      const gid = String(
        chUp?.guildId ??
          chUp?.guild_id ??
          latest?.guildId ??
          latest?.guild_id ??
          resolveGuildBucket(restChannelId, "") ??
          ""
      );
      void syncViewToIncomingMessage(
        {
          channelId: restChannelId,
          guildId: gid,
          channelName: chUp?.name ?? latest?.channelName ?? latest?.channel_name,
          content: latest ? messageContentPreview(latest) : String(chUp?.lastMessagePreview ?? ""),
          createdAtMs: latest
            ? Number(latest.createdAtMs ?? latest.created_at_ms ?? 0)
            : Number(chUp?.lastMessageAtMs ?? chUp?.last_message_at_ms ?? 0),
        },
        { adoptSelection: false }
      ).then(() => {
        if (selectedChannel.value?.channelId === restChannelId) {
          void nextTick(() => scrollMsgsBottom());
        }
      });
    } else if (selectedChannel.value?.channelId === restChannelId) {
      void nextTick(() => preserveScrollAfterPrepend(prevScrollHeight, prevScrollTop));
    }
    scheduleSave();
    return;
  }

  if (!isRestBatch) {
    const activeCid = selectedChannel.value?.channelId ?? "";
    if (activeCid && batchByChannel.has(activeCid)) {
      void nextTick(() => scrollMsgsBottom());
    }
    scheduleSave();
    return;
  }
}

useCollectorSocket(onSocketMsg);

watch([guilds, selectedGuildId, selectedChannel], scheduleSave, { deep: true });
watch([selectedGuildId, selectedChannel], saveLayoutNow, { deep: true });
watch(
  () => JSON.stringify(channelAliases),
  saveLayoutNow
);
watch(
  () => JSON.stringify(pinnedChannelsByGuild),
  saveLayoutNow
);
watch(
  () => JSON.stringify(messagesByChannelId),
  () => scheduleSave()
);

watch(
  () => JSON.stringify(unreadCountByChannelId),
  () => scheduleSave()
);

watch(
  () => JSON.stringify(channelGroupsByGuild),
  saveLayoutNow
);
watch(
  () => JSON.stringify(ungroupedOrderByGuild),
  saveLayoutNow
);
watch(selectedGuildId, (gid) => {
  if (gid) void loadChannelsForGuild(gid);
});

watch(selectedChannel, (ch) => {
  if (ch && showSignalCards.value) {
    void nextTick(() => signalCardRailRef.value?.reload());
  }
});

onMounted(async () => {
  try {
    signalConfig.value = await fetchSignalConfig();
  } catch {
    signalConfig.value = { channelIds: [] };
  }
  const hadCache = loadCache();
  await initShowLayout();
  if (!SHOW_GUILD_RAIL) selectedGuildId.value = DEFAULT_SHOW_GUILD_ID;
  await reloadGuilds();
  if (selectedGuildId.value) {
    await loadChannelsForGuild(selectedGuildId.value, { force: !hadCache });
  }
  try {
    const cdp = await fetchCdpActiveChannel();
    if (cdp.cdpChannelId && !selectedChannel.value) {
      updateCdpActive(cdp.cdpChannelId, cdp.cdpGuildId);
      const cdpGid = String(cdp.cdpGuildId ?? "");
      if (SHOW_GUILD_RAIL || !cdpGid || cdpGid === DEFAULT_SHOW_GUILD_ID) {
        await syncViewToIncomingMessage({
          channelId: cdp.cdpChannelId,
          guildId: cdp.cdpGuildId,
        });
      }
    }
  } catch {
    /* CDP 未就绪 */
  }
  if (selectedChannel.value) {
    const cached = messagesByChannelId[selectedChannel.value.channelId] ?? [];
    if (!cached.length) {
      try {
        await loadMessagesForChannel(selectedChannel.value);
      } catch {
        /* ignore */
      }
    }
  }
});
</script>

<template>
  <div
    class="show-app"
    :class="{ 'has-signal-cards': showSignalCards, 'no-guild-rail': !SHOW_GUILD_RAIL }"
  >
    <aside v-if="SHOW_GUILD_RAIL" class="guild-rail">
      <button
        v-for="g in guilds"
        :key="g.guildId"
        type="button"
        class="guild-icon-btn"
        :class="{ active: g.guildId === selectedGuildId, 'has-unread': guildUnreadCount(g.guildId) > 0 }"
        :title="g.name"
        @click="selectGuild(g)"
      >
        <img v-if="g.iconUrl" :src="g.iconUrl" :alt="g.name" referrerpolicy="no-referrer" />
        <span v-else>{{ guildInitial(g.guildId, g.name) }}</span>
        <span v-if="guildUnreadCount(g.guildId)" class="guild-unread-dot" aria-hidden="true" />
      </button>
      <p v-if="!loadingGuilds && !guilds.length" class="kook-wait">
        等待 READY / GUILD_CREATE…（若已有消息，请刷新页面或确认 MySQL 已连接）
      </p>
    </aside>

    <aside class="channel-panel">
      <div v-if="cacheBanner" class="kook-cache-banner">{{ cacheBanner }}</div>
      <div v-if="selectedGuild" class="channel-panel-toolbar">
        <span class="channel-panel-guild-name" :title="selectedGuild.name">{{ selectedGuild.name }}</span>
        <button type="button" class="channel-group-add-btn" title="新建分组" @click="createChannelGroup">+ 分组</button>
      </div>
      <div class="guild-channel-scroll">
        <p v-if="loadingChannels" class="kook-wait">加载频道…</p>
        <p v-else-if="selectedGuildId && !currentGuildChannels.length" class="kook-wait">
          暂无文本频道；请在 Discord 网页打开该服务器以同步频道列表。
        </p>
        <template v-for="item in channelSections" :key="sectionItemKey(item)">
          <div v-if="item.kind === 'pinned-label'" class="channel-section-label">置顶</div>
          <div
            v-else-if="item.kind === 'group-label'"
            class="channel-group-head"
            :class="{ 'drop-target': dropHighlightTarget === item.group.id }"
            @click="toggleGroupCollapsed(item.group)"
            @dragover="onDropZoneDragOver($event, item.group.id)"
            @dragleave="onDropZoneDragLeave(item.group.id)"
            @drop="onDropToGroup($event, item.group.id)"
          >
            <span class="channel-group-chevron">{{ item.group.collapsed ? "▸" : "▾" }}</span>
            <input
              v-if="renamingGroupId === item.group.id"
              v-model="renameGroupDraft"
              class="channel-group-rename-input"
              @click.stop
              @keydown.enter.prevent="commitRenameGroup"
              @keydown.escape.prevent="cancelRenameGroup"
              @blur="commitRenameGroup"
            />
            <span
              v-else
              class="channel-group-name"
              :title="item.group.name"
              @dblclick.stop="startRenameGroup(item.group)"
            >{{ item.group.name }}</span>
            <span class="channel-group-count">{{ (item.group.channelIds ?? []).length }}</span>
            <button
              type="button"
              class="channel-group-rename-btn"
              title="重命名分组"
              @click.stop="startRenameGroup(item.group)"
            >✎</button>
            <button
              type="button"
              class="channel-group-del-btn"
              title="删除分组"
              @click.stop="deleteChannelGroup(item.group)"
            >×</button>
          </div>
          <div
            v-else-if="item.kind === 'ungrouped-label'"
            class="channel-section-label channel-ungrouped-drop"
            :class="{ 'drop-target': dropHighlightTarget === '__ungrouped__' }"
            @dragover="onDropZoneDragOver($event, '__ungrouped__')"
            @dragleave="onDropZoneDragLeave('__ungrouped__')"
            @drop="onDropToUngrouped"
          >未分组</div>
          <button
            v-else-if="item.kind === 'channel'"
            type="button"
            class="channel-row"
            draggable="true"
            :class="{
              active: selectedChannel?.channelId === item.ch.channelId,
              renaming: renamingChannelId === item.ch.channelId,
              pinned: item.pinned,
              unread: channelUnreadCount(item.ch.channelId) > 0 && selectedChannel?.channelId !== item.ch.channelId,
              dragging: dragChannelId === item.ch.channelId,
              'drop-before': dropBeforeChannelId === item.ch.channelId && dragChannelId !== item.ch.channelId,
            }"
            @click="selectChannel(item.ch)"
            @dblclick="startRenameChannel(item.ch, $event)"
            @contextmenu.prevent="startRenameChannel(item.ch, $event)"
            @dragstart="onChannelDragStart(item.ch, $event)"
            @dragend="onChannelDragEnd"
            @dragover="onChannelDragOver($event, item.ch, { groupId: item.groupId ?? '', pinned: item.pinned })"
            @dragleave="onChannelDragLeave(item.ch)"
            @drop="onDropOnChannel($event, item.ch, { groupId: item.groupId ?? '', pinned: item.pinned })"
          >
            <span
              v-if="renamingChannelId === item.ch.channelId && selectedChannel?.channelId !== item.ch.channelId"
              class="title-line rename-line"
              @click.stop
            >
              <span class="hash">#</span>
              <input
                ref="renameInputEl"
                v-model="renameDraft"
                class="channel-rename-input"
                placeholder="输入自定义名称"
                @keydown.enter.prevent="commitRename"
                @keydown.escape.prevent="cancelRename"
                @blur="commitRename"
              />
            </span>
            <span
              v-else-if="renamingChannelId !== item.ch.channelId || selectedChannel?.channelId === item.ch.channelId"
              class="title-line"
            >
              <span class="hash">#</span>
              <span
                class="channel-name"
                :title="channelAliasTitle(item.ch.channelId, item.ch.name)"
              >{{ displayChannelName(item.ch) }}</span>
              <span
                v-if="channelIdLabel(item.ch)"
                class="channel-id-tag"
                :title="channelIdLabel(item.ch)"
              >{{ channelIdShort(item.ch) }}</span>
              <span
                v-if="formatUnreadBadge(item.ch.channelId)"
                class="channel-unread-badge"
              >{{ formatUnreadBadge(item.ch.channelId) }}</span>
              <button
                type="button"
                class="channel-pin-btn"
                :class="{ active: item.pinned }"
                :title="item.pinned ? '取消置顶' : '置顶'"
                @click.stop="toggleChannelPin(item.ch, $event)"
              >📌</button>
              <button
                type="button"
                class="channel-rename-btn"
                title="重命名"
                @click.stop="startRenameChannel(item.ch, $event)"
              >✎</button>
              <button
                v-if="hasChannelAlias(item.ch.channelId, channelAliases)"
                type="button"
                class="channel-reset-alias-btn"
                title="恢复 Discord 原名"
                @click="resetChannelAlias(item.ch, $event)"
              >↺</button>
            </span>
            <span
              v-if="item.ch.lastMessagePreview && renamingChannelId !== item.ch.channelId"
              class="preview"
            >{{ item.ch.lastMessagePreview }}</span>
          </button>
        </template>
      </div>
    </aside>

    <section class="main">
      <header class="main-header">
        <template v-if="selectedChannel">
          <span class="main-hash">#</span>
          <template v-if="renamingChannelId === selectedChannel.channelId">
            <input
              ref="renameInputEl"
              v-model="renameDraft"
              class="channel-rename-input header-rename"
              placeholder="输入自定义名称"
              @keydown.enter.prevent="commitRename"
              @keydown.escape.prevent="cancelRename"
              @blur="commitRename"
            />
          </template>
          <template v-else>
            <span
              class="main-title"
              :title="channelAliasTitle(selectedChannel.channelId, selectedChannel.name)"
              @dblclick="startRenameChannel(selectedChannel, $event)"
            >{{ displayChannelName(selectedChannel) }}</span>
            <button
              type="button"
              class="channel-pin-btn header"
              :class="{ active: channelIsPinned(selectedChannel) }"
              :title="channelIsPinned(selectedChannel) ? '取消置顶' : '置顶'"
              @click="toggleChannelPin(selectedChannel, $event)"
            >📌</button>
            <button
              type="button"
              class="channel-rename-btn header"
              title="重命名频道"
              @click="startRenameChannel(selectedChannel, $event)"
            >✎</button>
            <button
              v-if="hasChannelAlias(selectedChannel.channelId, channelAliases)"
              type="button"
              class="channel-reset-alias-btn header"
              title="恢复 Discord 原名"
              @click="resetChannelAlias(selectedChannel, $event)"
            >↺</button>
          </template>
        </template>
        <template v-else>
          <span class="main-sub">从左侧选择服务器与频道；信号统计见</span>
          <RouterLink to="/signals" class="main-sub">概览</RouterLink>
          <span class="main-sub">；原始 WS 见</span>
          <RouterLink to="/debug" class="main-sub">Debug</RouterLink>
        </template>
      </header>

      <div v-if="navError" class="kook-nav-alert err">{{ navError }}</div>
      <div v-else-if="navPending" class="kook-nav-alert pending">正在驱动 CDP 浏览器跳转…</div>

      <div ref="msgsScrollEl" class="msg-scroll">
        <template v-if="selectedChannel">
          <article
            v-for="g in groupedMessages"
            :key="String(g.head.messageId ?? g.head.message_id)"
            class="msg-group"
            :class="{ 'msg-highlight': isHighlightedMessage(g.head) }"
            :data-message-id="messageDomId(g.head)"
          >
            <div class="msg-row msg-row-head">
              <img
                v-if="msgAvatarUrl(g.head) && !avatarFailed[avatarErrorKey(g.head)]"
                :src="msgAvatarUrl(g.head)"
                class="msg-av"
                width="40"
                height="40"
                alt=""
                referrerpolicy="no-referrer"
                loading="lazy"
                @error="onAvatarError(avatarErrorKey(g.head))"
              />
              <div v-else class="msg-av ph" aria-hidden="true" />
              <div class="msg-body">
                <div class="msg-meta">
                  <span class="msg-name">{{ msgDisplayName(g.head) }}</span>
                  <span
                    v-if="(g.head.authorUsername ?? g.head.author_username) && (g.head.authorUsername ?? g.head.author_username) !== msgDisplayName(g.head)"
                    class="msg-user"
                  >@{{ g.head.authorUsername ?? g.head.author_username }}</span>
                  <span class="msg-time">{{ fmtMsgTime(g.head.createdAtMs ?? g.head.created_at_ms) }}</span>
                </div>
                <div v-if="messageTextContent(g.head)" class="msg-content">{{ messageTextContent(g.head) }}</div>
                <div v-if="msgAttachments(g.head).length" class="msg-attachments">
                  <template v-for="(att, i) in msgAttachments(g.head)" :key="`${g.head.messageId ?? g.head.message_id}-${i}`">
                    <a
                      v-if="isImageAttachment(att)"
                      :href="att.url"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="msg-image-link"
                    >
                      <img
                        :src="att.url"
                        :alt="att.filename || '图片'"
                        class="msg-image"
                        loading="lazy"
                        referrerpolicy="no-referrer"
                      />
                    </a>
                    <a
                      v-else
                      :href="att.url"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="msg-file-link"
                    >{{ att.filename || "下载附件" }}</a>
                  </template>
                </div>
                <div
                  v-if="!messageTextContent(g.head) && !msgAttachments(g.head).length"
                  class="msg-content muted"
                >（无文本）</div>
              </div>
            </div>
            <div
              v-for="m in g.tail"
              :key="String(m.messageId ?? m.message_id)"
              class="msg-row msg-row-continued"
              :class="{ 'msg-highlight-row': isHighlightedMessage(m) }"
              :data-message-id="messageDomId(m)"
            >
              <div class="msg-av-gap" aria-hidden="true" />
              <div class="msg-body">
                <div v-if="messageTextContent(m)" class="msg-content">{{ messageTextContent(m) }}</div>
                <div v-if="msgAttachments(m).length" class="msg-attachments">
                  <template v-for="(att, i) in msgAttachments(m)" :key="`${m.messageId ?? m.message_id}-${i}`">
                    <a
                      v-if="isImageAttachment(att)"
                      :href="att.url"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="msg-image-link"
                    >
                      <img
                        :src="att.url"
                        :alt="att.filename || '图片'"
                        class="msg-image"
                        loading="lazy"
                        referrerpolicy="no-referrer"
                      />
                    </a>
                    <a
                      v-else
                      :href="att.url"
                      target="_blank"
                      rel="noopener noreferrer"
                      class="msg-file-link"
                    >{{ att.filename || "下载附件" }}</a>
                  </template>
                </div>
                <div
                  v-if="!messageTextContent(m) && !msgAttachments(m).length"
                  class="msg-content muted"
                >（无文本）</div>
              </div>
            </div>
          </article>
          <p v-if="!selectedMessages.length" class="kook-wait">该频道暂无已采集消息。</p>
        </template>
        <p v-else class="kook-wait">选择左侧频道查看消息（含头像、昵称、时间）。</p>
      </div>
    </section>

    <SignalCardRail
      v-if="showSignalCards"
      ref="signalCardRailRef"
      :channel-id="selectedChannel?.channelId ?? ''"
      :guild-id="selectedGuildId"
      @scroll-to-message="scrollToSignalMessage"
      @card-updated="onSignalCardUpdated"
    />
  </div>
</template>

<style scoped>
@import "../styles/show-theme.css";
a.main-sub {
  color: #5865f2;
  text-decoration: none;
  margin-left: 0.25rem;
}
</style>
