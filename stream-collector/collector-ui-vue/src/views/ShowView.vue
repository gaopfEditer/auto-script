<script setup>
import { ref, computed, reactive, onMounted, watch, nextTick } from "vue";
import { RouterLink } from "vue-router";
import { useCollectorSocket } from "../composables/useCollectorSocket.js";
import {
  isGuildViewApiUrl,
  getGuildViewChannelsArray,
  buildGuildSidebarTree,
  parseGuildIdFromViewUrl,
} from "../lib/kookGuildView.js";
import {
  isKookChannelMessagesUrl,
  extractChannelIdFromMessagesUrl,
  parseKookMessagesResponseBody,
  mergeKookChannelMessages,
  resolveKookAvatarUrl,
} from "../lib/kookMessages.js";
import {
  isKookMessagesUnreadApiUrl,
  parseKookMessagesUnreadBody,
  mergeKookUnreadByChannel,
  bumpChannelUnread,
  clearChannelUnread,
} from "../lib/kookUnread.js";
import { tryExtractDesktopNotificationFromWsFrameJson, tryExtractChannelIdFromGatewayFrame } from "../lib/kookGatewayWs.js";
import { queueKookMessagesForPersist } from "../lib/kookMessagePersist.js";
import { maybeNotifyCompleteTradeSignal } from "../lib/kookTradeSignalNotify.js";
import {
  fetchSignals,
  fetchSignalSummariesByGuild,
  markSignal,
  unmarkSignal,
  saveSignalReview,
  reviewStatusLabel,
  normalizeSignalRow,
} from "../lib/kookSignalApi.js";
import { KOOK_ENTRY_TYPE_OPTIONS } from "../lib/kookSignalConstants.js";

defineOptions({ name: "ShowView" });

/** localStorage 缓存键；结构变更时递增版本号以免读到脏数据 */
const SHOW_CACHE_KEY = "stream-collector.show.v1";
const SHOW_CACHE_VERSION = 2;
/** 每频道最多缓存条数（控制体积） */
const MAX_MSGS_PER_CHANNEL_CACHE = 300;

/** @type {Record<string, string>} */
const reqUrlByRequestId = reactive({});
const MAX_REQ_TRACK = 600;

function pruneReqMap() {
  const keys = Object.keys(reqUrlByRequestId);
  if (keys.length > MAX_REQ_TRACK) return;
  for (let i = 0; i < keys.length - 400; i += 1) {
    delete reqUrlByRequestId[keys[i]];
  }
}

const guildCategories = ref([]);
const guildIdLabel = ref("");

/** @type {Record<string, import('../lib/kookMessages.js').KookHistMsg[]>} */
const messagesByChannelId = reactive({});

/** @type {Record<string, import('../lib/kookUnread.js').KookChannelUnread>} */
const unreadByChannelId = reactive({});

/** @type {{ id: string, name: string, last_msg: string, guildId: string } | null} */
const selectedChannel = ref(null);

const navPending = ref(false);
const navError = ref("");
const cacheBanner = ref("");

/** 头像加载失败（如 CDN 拒本地 Referer）时回退占位 */
const avatarLoadFailed = reactive(/** @type {Record<string, true>} */ ({}));

/** @param {import('../lib/kookMessages.js').KookHistMsg} m */
function avatarUrlForMsg(m) {
  const raw = m.raw;
  if (raw && typeof raw === "object") {
    const aut = /** @type {Record<string, unknown>} */ (raw).author;
    if (aut && typeof aut === "object" && !Array.isArray(aut)) {
      const u = resolveKookAvatarUrl(aut);
      if (u) return u;
    }
  }
  return (m.authorAvatar || "").trim();
}

/** @param {string} id */
function onKookAvatarError(id) {
  if (id) avatarLoadFailed[id] = true;
}

let saveCacheTimer = /** @type {ReturnType<typeof setTimeout> | null} */ (null);

/** @param {import('../lib/kookMessages.js').KookHistMsg} m */
function shrinkMsgForCache(m) {
  const { raw: _r, ...rest } = m;
  return rest;
}

function saveShowCache() {
  try {
    /** @type {Record<string, ReturnType<typeof shrinkMsgForCache>[]>} */
    const msgs = {};
    for (const k of Object.keys(messagesByChannelId)) {
      const arr = messagesByChannelId[k];
      if (!Array.isArray(arr) || arr.length === 0) continue;
      const tail = arr.slice(-MAX_MSGS_PER_CHANNEL_CACHE).map((m) => shrinkMsgForCache(m));
      msgs[k] = tail;
    }
    const payload = {
      v: SHOW_CACHE_VERSION,
      savedAt: Date.now(),
      guildIdLabel: guildIdLabel.value,
      guildCategories: guildCategories.value,
      messagesByChannelId: msgs,
      unreadByChannelId: { ...unreadByChannelId },
      selectedChannel: selectedChannel.value,
    };
    localStorage.setItem(SHOW_CACHE_KEY, JSON.stringify(payload));
  } catch (e) {
    const err = /** @type {Error & { name?: string }} */ (e);
    if (err?.name === "QuotaExceededError") {
      try {
        localStorage.removeItem(SHOW_CACHE_KEY);
      } catch {
        /* ignore */
      }
    }
  }
}

function scheduleSaveShowCache() {
  if (saveCacheTimer) clearTimeout(saveCacheTimer);
  saveCacheTimer = setTimeout(() => {
    saveCacheTimer = null;
    saveShowCache();
  }, 500);
}

function loadShowCache() {
  try {
    const raw = localStorage.getItem(SHOW_CACHE_KEY);
    if (!raw) return;
    const o = /** @type {Record<string, unknown>} */ (JSON.parse(raw));
    if (Number(o.v) !== SHOW_CACHE_VERSION) return;

    guildIdLabel.value = String(o.guildIdLabel ?? "");
    guildCategories.value = Array.isArray(o.guildCategories) ? /** @type {typeof guildCategories.value} */ (o.guildCategories) : [];

    for (const k of Object.keys(messagesByChannelId)) {
      delete messagesByChannelId[k];
    }
    const mb = o.messagesByChannelId;
    if (mb && typeof mb === "object" && !Array.isArray(mb)) {
      for (const [k, v] of Object.entries(/** @type {Record<string, unknown>} */ (mb))) {
        if (Array.isArray(v)) {
          messagesByChannelId[k] = /** @type {import('../lib/kookMessages.js').KookHistMsg[]} */ (v);
        }
      }
    }

    selectedChannel.value =
      o.selectedChannel && typeof o.selectedChannel === "object"
        ? /** @type {typeof selectedChannel.value} */ (o.selectedChannel)
        : null;

    for (const k of Object.keys(unreadByChannelId)) {
      delete unreadByChannelId[k];
    }
    const ur = o.unreadByChannelId;
    if (ur && typeof ur === "object" && !Array.isArray(ur)) {
      mergeKookUnreadByChannel(unreadByChannelId, /** @type {Record<string, import('../lib/kookUnread.js').KookChannelUnread>} */ (ur));
    }

    const t = Number(o.savedAt);
    if (t) {
      cacheBanner.value = `已恢复本地缓存（${new Date(t).toLocaleString("zh-CN")}）`;
      setTimeout(() => {
        cacheBanner.value = "";
      }, 6000);
    }
  } catch {
    /* ignore corrupt cache */
  }
}

watch([guildCategories, guildIdLabel, selectedChannel], scheduleSaveShowCache, { deep: true });
watch(
  () => JSON.stringify(messagesByChannelId),
  () => scheduleSaveShowCache()
);
watch(
  () => JSON.stringify(unreadByChannelId),
  () => scheduleSaveShowCache()
);

/** 当前频道 REST 消息列表滚动容器 */
const msgsScrollEl = ref(/** @type {HTMLElement | null} */ (null));

/** 距底部小于等于此值（px）视为「贴在底部」，新消息才自动滚到底 */
const SCROLL_NEAR_BOTTOM_PX = 100;

/** 用户点击：平滑滚到列表顶部 */
function scrollChannelMsgsToTop() {
  void nextTick(() => {
    const el = msgsScrollEl.value;
    if (!el) return;
    el.scrollTo({ top: 0, behavior: "smooth" });
  });
}

function scrollChannelMsgsToBottom() {
  void nextTick(() => {
    const el = msgsScrollEl.value;
    if (!el) return;
    const run = () => {
      el.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
    };
    run();
    requestAnimationFrame(run);
  });
}

/** 切换频道 / 首屏：始终滚到底（instant，不打 smooth） */
function scrollChannelMsgsToBottomForced() {
  void nextTick(() => {
    const el = msgsScrollEl.value;
    if (!el) return;
    const run = () => {
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
    };
    run();
    requestAnimationFrame(run);
  });
}

/** 列表更新：仅当用户本来就在底部附近时才跟随，避免上翻时被拽走 */
function scrollChannelMsgsToBottomIfSticky() {
  void nextTick(() => {
    requestAnimationFrame(() => {
      const el = msgsScrollEl.value;
      if (!el) return;
      const dist = el.scrollHeight - el.scrollTop - el.clientHeight;
      if (dist > SCROLL_NEAR_BOTTOM_PX) return;
      el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
      requestAnimationFrame(() => {
        el.scrollTo({ top: el.scrollHeight, behavior: "auto" });
      });
    });
  });
}

const selectedChannelMessages = computed(() => {
  const id = selectedChannel.value?.id;
  if (!id) return [];
  const list = messagesByChannelId[id];
  return Array.isArray(list) ? list : [];
});

const guildLoaded = computed(() => guildCategories.value.length > 0);

/** main-header：群组 id（侧栏频道可能无 guild_id 时用 guild/view 解析的 guildIdLabel） */
const selectedGuildIdForHeader = computed(() => {
  const s = selectedChannel.value;
  if (!s) return "";
  return String(s.guildId || guildIdLabel.value || "").trim();
});

watch(selectedChannelMessages, () => scrollChannelMsgsToBottomIfSticky(), { deep: true });
watch(
  () => selectedChannel.value?.id,
  () => scrollChannelMsgsToBottomForced()
);

function toggleCategory(cat) {
  cat.open = !cat.open;
}

async function selectKookChannel(ch) {
  const gid = String(ch.guildId || guildIdLabel.value || "").trim();
  selectedChannel.value = {
    id: ch.id,
    name: ch.name,
    last_msg: ch.last_msg,
    guildId: gid,
  };
  clearChannelUnread(unreadByChannelId, ch.id);

  if (!gid) {
    navError.value = "缺少服务器 ID：请等待 guild/view 同步，或确保频道数据含 guild_id";
    return;
  }

  navError.value = "";
  navPending.value = true;
  const clientTraceId = `nav-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`;

  try {
    const r = await fetch("/api/cdp/kook-channel", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ guildId: gid, channelId: ch.id, clientTraceId }),
    });
    const j = /** @type {{ ok?: boolean, error?: string, finalUrl?: string }} */ (await r.json().catch(() => ({})));
    if (!r.ok || !j.ok) {
      navError.value =
        r.status === 404
          ? "CDP 接口 404：请重启终端 A（collect:ui）与终端 B（dev:ui-vue），并确认两者使用同一 COLLECTOR_UI_PORT；在终端 B 启动日志中应看到「API/WS 代理目标」与该端口一致。"
          : j.error || `HTTP ${r.status}`;
      return;
    }
    navError.value = "";
  } catch (e) {
    navError.value = String(/** @type {Error} */ (e).message || e);
  } finally {
    navPending.value = false;
  }
}

/** @param {string} channelId @param {string} [guildId] @param {import('../lib/kookMessages.js').KookHistMsg[]} incoming */
function persistMergedMessages(channelId, guildId, incoming, source = "frontend") {
  if (!incoming.length) return;
  const gid = guildId || guildIdLabel.value || selectedChannel.value?.guildId || "";
  queueKookMessagesForPersist(incoming, { channelId, guildId: gid });
  for (const m of incoming) {
    maybeNotifyCompleteTradeSignal(m, { guildId: gid, channelId, source });
  }
}

/** @param {string} channelId @param {string} preview */
function patchChannelLastMsgPreview(channelId, preview) {
  const short = preview.length > 120 ? `${preview.slice(0, 120)}…` : preview;
  for (const cat of guildCategories.value) {
    if (!Array.isArray(cat.children)) continue;
    for (const ch of cat.children) {
      if (ch.id !== channelId) continue;
      ch.last_msg = short;
      const sel = selectedChannel.value;
      if (sel?.id === channelId) {
        selectedChannel.value = { ...sel, last_msg: short };
      }
      return;
    }
  }
}

/** @param {Record<string, unknown>} msg */
function ingestKookWsFrameForShow(msg) {
  const body = msg.body;
  const j =
    body != null && typeof body === "object" && "json" in body && body.json != null && typeof body.json === "object"
      ? /** @type {Record<string, unknown>} */ (body.json)
      : null;
  if (!j) return;

  const selId = String(selectedChannel.value?.id ?? "").trim();

  const desk = tryExtractDesktopNotificationFromWsFrameJson(j);
  if (desk) {
    const { channelId, hist } = desk;
    const prev = messagesByChannelId[channelId] ?? [];
    messagesByChannelId[channelId] = mergeKookChannelMessages(prev, [hist]);
    patchChannelLastMsgPreview(channelId, hist.content);
    persistMergedMessages(channelId, desk.guildId, [hist], "ws_desktop");
    if (channelId && channelId !== selId) {
      bumpChannelUnread(unreadByChannelId, channelId, { mention: false });
    }
    return;
  }

  const cid = tryExtractChannelIdFromGatewayFrame(j);
  if (cid && cid !== selId) {
    bumpChannelUnread(unreadByChannelId, cid, { mention: false });
  }
}

/** @param {Record<string, unknown>} msg */
function onWire(msg) {
  const ch = String(msg.channel ?? "");
  if (ch === "frame" && String(msg.kind ?? "") === "ws_frame") {
    ingestKookWsFrameForShow(msg);
    return;
  }
  if (ch === "diag") {
    const k = String(msg.kind ?? "");
    const rid = String(msg.requestId ?? "");
    if (k === "net_request" && rid && msg.url) {
      reqUrlByRequestId[rid] = String(msg.url);
      pruneReqMap();
      return;
    }
    if (k === "net_response_body" && rid && msg.bodyJson != null) {
      const url = reqUrlByRequestId[rid];
      if (!url) return;

      if (isGuildViewApiUrl(url)) {
        const arr = getGuildViewChannelsArray(msg.bodyJson);
        if (arr && arr.length) {
          const { categories } = buildGuildSidebarTree(arr);
          guildCategories.value = categories;
          guildIdLabel.value = parseGuildIdFromViewUrl(url) || "";
        }
        return;
      }

      if (isKookChannelMessagesUrl(url)) {
        const chId = extractChannelIdFromMessagesUrl(url);
        if (chId) {
          const incoming = parseKookMessagesResponseBody(msg.bodyJson);
          if (incoming.length) {
            const prev = messagesByChannelId[chId] ?? [];
            messagesByChannelId[chId] = mergeKookChannelMessages(prev, incoming);
            persistMergedMessages(chId, guildIdLabel.value, incoming);
          }
        }
        return;
      }

      if (isKookMessagesUnreadApiUrl(url)) {
        const parsed = parseKookMessagesUnreadBody(msg.bodyJson);
        mergeKookUnreadByChannel(unreadByChannelId, parsed);
        return;
      }
      return;
    }
    return;
  }
}

useCollectorSocket(onWire);

onMounted(() => {
  loadShowCache();
  scrollChannelMsgsToBottomForced();
});

/** @param {number} ms */
function fmtMsgTime(ms) {
  if (!ms) return "—";
  return new Date(ms).toLocaleString("zh-CN", {
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
}

function isChannelRowActive(ch) {
  return selectedChannel.value?.id === ch.id;
}

/** @param {{ id: string }} ch */
function channelUnread(ch) {
  const u = unreadByChannelId[ch.id];
  if (!u) return null;
  if (u.message_count <= 0 && u.mention_count <= 0) return null;
  return u;
}

/** @param {{ children?: unknown[] }} cat */
function categoryHasUnread(cat) {
  const kids = cat.children;
  if (!Array.isArray(kids)) return false;
  return kids.some((ch) => channelUnread(/** @type {{ id: string }} */ (ch)));
}

const guildSidebarHasUnread = computed(() => {
  for (const cat of guildCategories.value) {
    if (categoryHasUnread(cat)) return true;
  }
  return false;
});

/** @type {Record<string, ReturnType<typeof normalizeSignalRow>>} */
const signalByMessageId = reactive({});
const reviewExpandedMessageId = ref("");
/** @type {Record<string, { hitTakeProfit: string, hitStopLoss: string, entryType: string, entryOffset: string, reviewNote: string }>} */
const reviewDraftByMessageId = reactive({});
const signalActionError = ref("");
/** @type {import('vue').Ref<Record<string, unknown>[]>} */
const signalSummariesByGuild = ref([]);
const signalSummaryLoading = ref(false);

/** @param {import('../lib/kookMessages.js').KookHistMsg} m */
function isSignalMarked(m) {
  return Boolean(signalByMessageId[m.id]);
}

/** @param {import('../lib/kookMessages.js').KookHistMsg} m */
function signalForMsg(m) {
  return signalByMessageId[m.id] ?? null;
}

/** @param {import('../lib/kookMessages.js').KookHistMsg} m */
function ensureReviewDraft(m) {
  const sig = signalForMsg(m);
  if (reviewDraftByMessageId[m.id]) return reviewDraftByMessageId[m.id];
  const d = {
    hitTakeProfit: sig?.hitTakeProfit === true ? "yes" : sig?.hitTakeProfit === false ? "no" : "",
    hitStopLoss: sig?.hitStopLoss === true ? "yes" : sig?.hitStopLoss === false ? "no" : "",
    entryType: sig?.entryType ?? "",
    entryOffset: sig?.entryOffset != null && !Number.isNaN(sig.entryOffset) ? String(sig.entryOffset) : "",
    reviewNote: sig?.reviewNote ?? "",
  };
  reviewDraftByMessageId[m.id] = d;
  return d;
}

/** @param {string} tri @returns {boolean | null} */
function triFromSelect(tri) {
  if (tri === "yes") return true;
  if (tri === "no") return false;
  return null;
}

async function reloadSignalsForContext() {
  const gid = selectedGuildIdForHeader.value;
  const cid = selectedChannel.value?.id;
  if (!gid) return;
  try {
    const rows = await fetchSignals({ guildId: gid, channelId: cid || undefined });
    for (const k of Object.keys(signalByMessageId)) {
      if (!cid || signalByMessageId[k]?.channelId === cid) delete signalByMessageId[k];
    }
    for (const row of rows) {
      if (row.messageId) signalByMessageId[row.messageId] = row;
    }
  } catch (e) {
    signalActionError.value = String(/** @type {Error} */ (e).message || e);
  }
}

async function reloadGuildSignalSummary() {
  signalSummaryLoading.value = true;
  try {
    signalSummariesByGuild.value = await fetchSignalSummariesByGuild();
    signalActionError.value = "";
  } catch (e) {
    signalActionError.value = String(/** @type {Error} */ (e).message || e);
    signalSummariesByGuild.value = [];
  } finally {
    signalSummaryLoading.value = false;
  }
}

/** @param {Record<string, unknown>} s */
function formatTpSlDenom(hit, miss) {
  const h = Number(hit) || 0;
  const m = Number(miss) || 0;
  const d = h + m;
  return d > 0 ? `${h}/${d}` : "—";
}

/** @param {import('../lib/kookMessages.js').KookHistMsg} m */
async function markMessageAsSignal(m) {
  const gid = selectedGuildIdForHeader.value;
  const cid = selectedChannel.value?.id;
  if (!gid || !cid) {
    signalActionError.value = "缺少群组或频道 id";
    return;
  }
  signalActionError.value = "";
  try {
    await markSignal({ messageId: m.id, guildId: gid, channelId: cid });
    signalByMessageId[m.id] = normalizeSignalRow({
      message_id: m.id,
      guild_id: gid,
      channel_id: cid,
      content: m.content,
      create_at_ms: m.create_at,
    });
    reviewExpandedMessageId.value = m.id;
    delete reviewDraftByMessageId[m.id];
    await reloadGuildSignalSummary();
  } catch (e) {
    signalActionError.value = String(/** @type {Error} */ (e).message || e);
  }
}

/** @param {import('../lib/kookMessages.js').KookHistMsg} m */
async function unmarkMessageSignal(m) {
  signalActionError.value = "";
  try {
    await unmarkSignal(m.id);
    delete signalByMessageId[m.id];
    delete reviewDraftByMessageId[m.id];
    if (reviewExpandedMessageId.value === m.id) reviewExpandedMessageId.value = "";
    await reloadGuildSignalSummary();
  } catch (e) {
    signalActionError.value = String(/** @type {Error} */ (e).message || e);
  }
}

/** @param {import('../lib/kookMessages.js').KookHistMsg} m */
function toggleReviewPanel(m) {
  if (!isSignalMarked(m)) return;
  reviewExpandedMessageId.value = reviewExpandedMessageId.value === m.id ? "" : m.id;
  ensureReviewDraft(m);
}

/** @param {import('../lib/kookMessages.js').KookHistMsg} m */
async function submitSignalReview(m) {
  const gid = selectedGuildIdForHeader.value;
  const cid = selectedChannel.value?.id;
  if (!gid || !cid) return;
  const d = ensureReviewDraft(m);
  signalActionError.value = "";
  try {
    const saved = await saveSignalReview({
      messageId: m.id,
      guildId: gid,
      channelId: cid,
      hitTakeProfit: triFromSelect(d.hitTakeProfit),
      hitStopLoss: triFromSelect(d.hitStopLoss),
      entryType: d.entryType || null,
      entryOffset: d.entryType === "near_miss" && d.entryOffset.trim() ? Number(d.entryOffset) : null,
      reviewNote: d.reviewNote.trim() || null,
    });
    signalByMessageId[m.id] = saved;
    await reloadGuildSignalSummary();
  } catch (e) {
    signalActionError.value = String(/** @type {Error} */ (e).message || e);
  }
}

watch(
  () => [selectedGuildIdForHeader.value, selectedChannel.value?.id],
  () => {
    void reloadSignalsForContext();
  }
);

watch(
  () => selectedGuildIdForHeader.value,
  () => {
    void reloadGuildSignalSummary();
  },
  { immediate: true }
);
</script>

<template>
  <div class="show-app">
    <aside class="guild-rail">
      <div class="guild-icon" title="Kook">K</div>
    </aside>
    <aside class="channel-panel">
      <div class="channel-head kook-head">
        <span class="kook-guild-title">{{ guildLoaded ? "服务器频道" : "频道" }}</span>
        <span v-if="guildSidebarHasUnread" class="kook-guild-unread-dot" title="有未读频道" aria-hidden="true" />
        <span v-if="guildIdLabel" class="kook-guild-id">ID {{ guildIdLabel }}</span>
      </div>
      <div v-if="cacheBanner" class="kook-cache-banner">{{ cacheBanner }}</div>

      <div class="guild-channel-scroll">
        <p v-if="!guildLoaded" class="kook-wait">
          等待 CDP 同步
          <code>/api/v2/guild/view</code>
          响应；未读角标来自
          <code>/api/v2/messages/unread</code>
          ；桌面通知来自网关 WS（CDP 帧）
          …
        </p>

        <template v-else>
          <div v-for="cat in guildCategories" :key="cat.id" class="kook-cat-block">
            <button type="button" class="kook-cat-head" @click="toggleCategory(cat)">
              <span class="kook-chev" :class="{ open: cat.open }" aria-hidden="true" />
              <span class="kook-cat-name">{{ cat.name }}</span>
              <span v-if="categoryHasUnread(cat)" class="kook-cat-unread-dot" title="分类内有未读" aria-hidden="true" />
            </button>
            <div v-show="cat.open" class="kook-ch-list">
              <button
                v-for="ch in cat.children"
                :key="ch.id"
                type="button"
                :class="['kook-ch-row', { active: isChannelRowActive(ch), pending: navPending && selectedChannel?.id === ch.id }]"
                :disabled="navPending"
                @click="selectKookChannel(ch)"
              >
                <span class="kook-hash">#</span>
                <span class="kook-ch-main">
                  <span class="kook-ch-title-row">
                    <span class="kook-ch-name">{{ ch.name }}</span>
                    <span
                      v-if="channelUnread(ch)?.mention_count"
                      class="kook-ch-mention"
                      :title="channelUnread(ch)?.mention_label || '有 @ 提及'"
                    >@</span>
                    <span v-if="channelUnread(ch)?.message_count" class="kook-ch-unread">{{ channelUnread(ch).message_count > 99 ? "99+" : channelUnread(ch).message_count }}</span>
                  </span>
                  <span class="kook-ch-last" :title="ch.last_msg">{{ ch.last_msg || "暂无最后一条消息" }}</span>
                </span>
              </button>
            </div>
          </div>
        </template>
      </div>
    </aside>

    <section class="main">
      <header class="main-header">
        <template v-if="selectedChannel">
          <span class="main-hash">#</span>
          <span class="main-title">{{ selectedChannel.name }}</span>
          <span v-if="selectedGuildIdForHeader" class="main-header-guild-id">群组 {{ selectedGuildIdForHeader }}</span>
        </template>
        <template v-else>
          <span class="main-sub kook-show-hint">从左侧选择频道；WebSocket 帧摘要见</span>
          <RouterLink class="main-sub kook-show-hint-link" to="/debug">Debug → CDP 消息流</RouterLink>
        </template>
      </header>

      <template v-if="selectedChannel">
        <div v-if="navError" class="kook-nav-alert err">{{ navError }}</div>
        <div v-else-if="navPending" class="kook-nav-alert pending">正在驱动 CDP 浏览器跳转…</div>


        <div class="kook-signal-summary-wrap">
          <div class="kook-detail-label">群组信号评估（按群组拆分 · 有效发车 + 核验汇总）</div>
          <p v-if="signalSummaryLoading" class="kook-signal-summary-hint">加载汇总…</p>
          <template v-else-if="signalSummariesByGuild.length">
            <div
              v-for="item in signalSummariesByGuild"
              :key="String(item.guildId)"
              class="kook-signal-summary-strip"
              :class="{ 'kook-signal-summary-strip--current': item.guildId === selectedGuildIdForHeader }"
            >
              <div class="kook-signal-summary-guild-title">群组 {{ item.guildId }}</div>
              <div class="kook-signal-summary-grid">
                <span>发车 <strong>{{ item.totalSignals ?? 0 }}</strong></span>
                <span>已核验 <strong>{{ item.reviewedCount ?? 0 }}</strong></span>
                <span>止盈 <strong>{{ formatTpSlDenom(item.takeProfitHit, item.takeProfitMiss) }}</strong></span>
                <span>止损 <strong>{{ formatTpSlDenom(item.stopLossHit, item.stopLossMiss) }}</strong></span>
                <span>精准入场 <strong>{{ item.entryPrecise ?? 0 }}</strong></span>
                <span>差一点入场 <strong>{{ item.entryNearMiss ?? 0 }}</strong><template v-if="item.entryNearMissAvgOffset != null">（均偏差 {{ Number(item.entryNearMissAvgOffset).toFixed(4) }}）</template></span>
                <span>差点打损 <strong>{{ item.entryNearStopLoss ?? 0 }}</strong></span>
                <span>进场位不好未打损 <strong>{{ item.entryBadEntryNoSl ?? 0 }}</strong></span>
                <span>未入场 <strong>{{ item.entryNone ?? 0 }}</strong></span>
              </div>
            </div>
          </template>
          <p v-else class="kook-signal-summary-hint">暂无发车信号；在消息行点击「标为发车」后填写核验表单。</p>
        </div>

        <div v-if="signalActionError" class="kook-nav-alert err">{{ signalActionError }}</div>

        <div class="main-split kook-show-msgs-only">
          <div class="kook-api-msgs">
            <div class="kook-msgs-scroll-fab" aria-label="消息列表滚动">
              <button type="button" class="kook-msgs-scroll-btn" title="滚动到最上面" @click="scrollChannelMsgsToTop">顶部</button>
              <button type="button" class="kook-msgs-scroll-btn" title="滚动到最下面" @click="scrollChannelMsgsToBottom">底部</button>
            </div>
            <div ref="msgsScrollEl" class="kook-api-msgs-scroll">
              <div
                v-for="m in selectedChannelMessages"
                :key="m.id"
                :class="['kook-hist-row', { 'kook-hist-row--signal': isSignalMarked(m) }]"
              >
                <template v-if="avatarUrlForMsg(m) && !avatarLoadFailed[m.id]">
                  <img
                    :src="avatarUrlForMsg(m)"
                    class="kook-hist-av"
                    width="40"
                    height="40"
                    alt=""
                    referrerpolicy="no-referrer"
                    loading="lazy"
                    decoding="async"
                    @error="onKookAvatarError(m.id)"
                  />
                </template>
                <div v-else class="kook-hist-av ph" aria-hidden="true" />
                <div class="kook-hist-body">
                  <div class="kook-hist-meta">
                    <span class="kook-hist-name">{{ m.authorDisplayName }}</span>
                    <span
                      v-if="m.authorUsername && m.authorUsername !== m.authorDisplayName"
                      class="kook-hist-user"
                    >@{{ m.authorUsername }}</span>
                    <span v-if="m.authorIdentifyNum" class="kook-hist-ident">#{{ m.authorIdentifyNum }}</span>
                    <span class="kook-hist-id">uid {{ m.authorId }}</span>
                    <span v-if="m.bot" class="kook-bot-pill">BOT</span>
                    <span class="kook-hist-time">{{ fmtMsgTime(m.create_at) }}</span>
                    <span v-if="m.raw && typeof m.raw === 'object' && m.raw._kookWsDesktopNotification" class="kook-ws-notice-pill">WS 通知</span>
                    <span v-if="isSignalMarked(m)" class="kook-signal-pill">发车</span>
                    <span v-if="reviewStatusLabel(signalForMsg(m))" class="kook-review-status">{{ reviewStatusLabel(signalForMsg(m)) }}</span>
                  </div>
                  <div class="kook-hist-content">{{ m.content }}</div>
                  <div class="kook-signal-actions">
                    <button
                      v-if="!isSignalMarked(m)"
                      type="button"
                      class="kook-signal-btn"
                      @click="markMessageAsSignal(m)"
                    >标为发车</button>
                    <template v-else>
                      <button type="button" class="kook-signal-btn primary" @click="toggleReviewPanel(m)">
                        {{ reviewExpandedMessageId === m.id ? "收起核验" : "结果核验" }}
                      </button>
                      <button type="button" class="kook-signal-btn muted" @click="unmarkMessageSignal(m)">取消发车</button>
                    </template>
                  </div>
                  <form
                    v-if="isSignalMarked(m) && reviewExpandedMessageId === m.id"
                    class="kook-signal-review-form"
                    @submit.prevent="submitSignalReview(m)"
                  >
                    <div class="kook-signal-form-row">
                      <label class="kook-signal-label">止盈</label>
                      <select v-model="ensureReviewDraft(m).hitTakeProfit" class="kook-signal-select">
                        <option value="">未评</option>
                        <option value="yes">是</option>
                        <option value="no">否</option>
                      </select>
                      <label class="kook-signal-label">止损</label>
                      <select v-model="ensureReviewDraft(m).hitStopLoss" class="kook-signal-select">
                        <option value="">未评</option>
                        <option value="yes">是</option>
                        <option value="no">否</option>
                      </select>
                    </div>
                    <div class="kook-signal-form-row">
                      <label class="kook-signal-label">入场</label>
                      <select v-model="ensureReviewDraft(m).entryType" class="kook-signal-select wide">
                        <option value="">未评</option>
                        <option
                          v-for="opt in KOOK_ENTRY_TYPE_OPTIONS"
                          :key="opt.value"
                          :value="opt.value"
                        >{{ opt.label }}</option>
                      </select>
                      <template v-if="ensureReviewDraft(m).entryType === 'near_miss'">
                        <label class="kook-signal-label">插值</label>
                        <input
                          v-model="ensureReviewDraft(m).entryOffset"
                          type="number"
                          step="any"
                          class="kook-signal-input"
                          placeholder="偏差数值"
                        />
                      </template>
                    </div>
                    <div class="kook-signal-form-row">
                      <label class="kook-signal-label">备注</label>
                      <textarea v-model="ensureReviewDraft(m).reviewNote" class="kook-signal-textarea" rows="2" placeholder="可选说明" />
                    </div>
                    <button type="submit" class="kook-signal-btn primary">保存核验</button>
                  </form>
                </div>
              </div>
              <p v-if="selectedChannelMessages.length === 0" class="kook-api-empty">
                暂无该频道的 REST 记录。请在 Kook 网页中进入
                <strong>#{{ selectedChannel.name }}</strong>
                ，等待 CDP 捕获 REST 响应；或依赖同页网关 WS 的
                <code>SYS_MSG</code>
                桌面通知写入。
              </p>
            </div>
          </div>
        </div>
      </template>

      <div v-else class="kook-show-empty">
        <p class="kook-show-empty-title">请选择左侧频道</p>
        <p class="kook-show-empty-body">
          此处展示 Kook REST 与网关 WS 桌面通知合并后的频道与消息。纯 WS 帧调试（live / MySQL / 合并）见
          <RouterLink to="/debug">Debug</RouterLink>
          顶部标签
          <strong>CDP 消息流</strong>
          。
        </p>
      </div>
    </section>
  </div>
</template>
