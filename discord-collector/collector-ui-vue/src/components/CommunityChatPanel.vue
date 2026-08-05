<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref } from "vue";
import {
  fetchChatMessages,
  sendChatMessage,
  uploadChatMedia,
} from "../lib/communityApi.js";
import { subscribeCollectorSocket } from "../composables/useCollectorSocket.js";
import CommunityHoverCard from "./CommunityHoverCard.vue";
import CommunityLevelBadges from "./CommunityLevelBadges.vue";

const props = defineProps({
  me: { type: Object, default: null },
});

const emit = defineEmits(["update:me", "tip-member"]);

const messages = ref([]);
const loading = ref(false);
const loadingMore = ref(false);
const error = ref("");
const draft = ref("");
const sending = ref(false);
const listEl = ref(null);
const fileInput = ref(null);
const lightboxUrl = ref("");

const hasMore = ref(true);
const oldestId = computed(() => (messages.value.length ? messages.value[0].id : null));

function formatClock(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  if (sameDay) {
    return d.toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit", hour12: false });
  }
  return d.toLocaleString("zh-CN", {
    month: "numeric",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
}

function initialOf(name) {
  const s = String(name || "?").trim();
  return (s[0] || "?").toUpperCase();
}

function isMine(m) {
  return Boolean(props.me?.id && m?.author?.id === props.me.id);
}

/** 连续同作者时折叠头像/昵称 */
function showAuthorChrome(m, idx) {
  if (idx === 0) return true;
  const prev = messages.value[idx - 1];
  if (!prev) return true;
  if (prev.author?.id !== m.author?.id) return true;
  const t0 = new Date(prev.createdAt).getTime();
  const t1 = new Date(m.createdAt).getTime();
  return !Number.isFinite(t0) || !Number.isFinite(t1) || t1 - t0 > 5 * 60_000;
}

function scrollToBottom() {
  nextTick(() => {
    const el = listEl.value;
    if (el) el.scrollTop = el.scrollHeight;
  });
}

function upsertMessage(msg) {
  if (!msg?.id) return;
  const idx = messages.value.findIndex((m) => m.id === msg.id);
  if (idx >= 0) {
    messages.value[idx] = msg;
    return;
  }
  messages.value.push(msg);
  messages.value.sort((a, b) => a.id - b.id);
}

async function loadHistory({ before } = {}) {
  if (before) loadingMore.value = true;
  else loading.value = true;
  error.value = "";
  try {
    const data = await fetchChatMessages({ limit: 40, before });
    const rows = data.messages ?? [];
    if (before) {
      if (!rows.length) hasMore.value = false;
      else {
        const existing = new Set(messages.value.map((m) => m.id));
        const prepend = rows.filter((m) => !existing.has(m.id));
        messages.value = [...prepend, ...messages.value];
        if (rows.length < 40) hasMore.value = false;
      }
    } else {
      messages.value = rows;
      hasMore.value = rows.length >= 40;
      scrollToBottom();
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
    loadingMore.value = false;
  }
}

async function onScroll() {
  const el = listEl.value;
  if (!el || loadingMore.value || !hasMore.value) return;
  if (el.scrollTop < 48 && oldestId.value) {
    const prevHeight = el.scrollHeight;
    await loadHistory({ before: oldestId.value });
    nextTick(() => {
      el.scrollTop = el.scrollHeight - prevHeight;
    });
  }
}

async function onSendText() {
  const text = draft.value.trim();
  if (!text || !props.me || sending.value) return;
  sending.value = true;
  error.value = "";
  try {
    const data = await sendChatMessage({ type: "text", content: text });
    draft.value = "";
    if (data.message) upsertMessage(data.message);
    scrollToBottom();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    sending.value = false;
  }
}

function pickFile() {
  fileInput.value?.click();
}

async function onFileChange(ev) {
  const file = ev.target?.files?.[0];
  ev.target.value = "";
  if (!file || !props.me) return;
  const isVideo = String(file.type || "").startsWith("video/");
  if (isVideo && file.size > 20 * 1024 * 1024) {
    error.value = "短视频不得超过 20MB";
    return;
  }
  if (!isVideo && file.size > 5 * 1024 * 1024) {
    error.value = "图片不得超过 5MB";
    return;
  }
  sending.value = true;
  error.value = "";
  try {
    const up = await uploadChatMedia(file);
    const data = await sendChatMessage({
      type: up.type || (isVideo ? "video" : "image"),
      content: draft.value.trim().slice(0, 200),
      mediaUrl: up.mediaUrl,
    });
    draft.value = "";
    if (data.message) upsertMessage(data.message);
    scrollToBottom();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    sending.value = false;
  }
}

function onSocket(msg) {
  if (msg?.channel !== "community") return;
  if (msg?.kind !== "chat_message") return;
  const m = msg.message;
  if (m) {
    const nearBottom =
      listEl.value &&
      listEl.value.scrollHeight - listEl.value.scrollTop - listEl.value.clientHeight < 120;
    upsertMessage(m);
    if (nearBottom) scrollToBottom();
  }
}

let unsub = null;

onMounted(() => {
  unsub = subscribeCollectorSocket(onSocket);
  void loadHistory();
});

onUnmounted(() => {
  unsub?.();
});
</script>

<template>
  <section class="chat-panel">
    <header class="chat-hd">
      <div class="room-dot" aria-hidden="true" />
      <div>
        <h2>公共大厅</h2>
        <p class="muted">实时聊天 · 文字 / 图片 / 短视频</p>
      </div>
      <span class="online-pill">在线</span>
    </header>

    <p v-if="error" class="banner err">{{ error }}</p>

    <div ref="listEl" class="msg-list" @scroll="onScroll">
      <button
        v-if="hasMore && messages.length"
        type="button"
        class="load-more"
        :disabled="loadingMore"
        @click="loadHistory({ before: oldestId })"
      >
        {{ loadingMore ? "加载中…" : "加载更早消息" }}
      </button>
      <p v-if="loading" class="muted center">加载消息…</p>
      <p v-else-if="!messages.length" class="muted center empty">还没有消息，来打个招呼吧 👋</p>

      <article
        v-for="(m, idx) in messages"
        :key="m.id"
        class="msg-row"
        :class="{ mine: isMine(m), compact: !showAuthorChrome(m, idx) }"
      >
        <div v-if="!isMine(m)" class="avatar-col">
          <template v-if="showAuthorChrome(m, idx)">
            <CommunityHoverCard :member="m.author" @tip="emit('tip-member', $event)">
              <button type="button" class="av-hit">
                <img v-if="m.author?.avatarUrl" class="avatar img" :src="m.author.avatarUrl" alt="" />
                <span
                  v-else
                  class="avatar"
                  :style="{ background: m.author?.title?.color || '#5865f2' }"
                  >{{ initialOf(m.author?.displayName) }}</span
                >
              </button>
            </CommunityHoverCard>
          </template>
          <span v-else class="avatar-spacer" />
        </div>

        <div class="msg-col">
          <header v-if="showAuthorChrome(m, idx)" class="msg-meta">
            <strong>{{ isMine(m) ? "我" : m.author?.displayName || "匿名" }}</strong>
            <CommunityLevelBadges
              v-if="m.author?.badges || m.author?.level"
              :badges="m.author?.badges"
              :level="m.author?.level"
              size="sm"
            />
            <span
              v-if="m.author?.title?.label"
              class="title-badge"
              :style="{ color: m.author?.title?.color }"
              >{{ m.author.title.label }}</span
            >
            <span class="time">{{ formatClock(m.createdAt) }}</span>
          </header>
          <div class="bubble">
            <p v-if="m.content" class="text">{{ m.content }}</p>
            <button
              v-if="m.type === 'image' && m.mediaUrl"
              type="button"
              class="media-btn"
              @click="lightboxUrl = m.mediaUrl"
            >
              <img :src="m.mediaUrl" alt="图片" class="media-img" />
            </button>
            <video
              v-else-if="m.type === 'video' && m.mediaUrl"
              class="media-video"
              controls
              playsinline
              :src="m.mediaUrl"
            />
          </div>
        </div>

        <div v-if="isMine(m)" class="avatar-col">
          <template v-if="showAuthorChrome(m, idx)">
            <CommunityHoverCard :member="me">
              <button type="button" class="av-hit">
                <img v-if="me?.avatarUrl" class="avatar img" :src="me.avatarUrl" alt="" />
                <span
                  v-else
                  class="avatar"
                  :style="{ background: me?.title?.color || '#5865f2' }"
                  >{{ initialOf(me?.displayName) }}</span
                >
              </button>
            </CommunityHoverCard>
          </template>
          <span v-else class="avatar-spacer" />
        </div>
      </article>
    </div>

    <footer v-if="me" class="composer">
      <input
        ref="fileInput"
        type="file"
        accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm"
        hidden
        @change="onFileChange"
      />
      <button type="button" class="icon-btn" :disabled="sending" title="图片 / 短视频" @click="pickFile">
        ＋
      </button>
      <input
        v-model="draft"
        class="draft"
        maxlength="2000"
        placeholder="输入消息…"
        :disabled="sending"
        @keyup.enter="onSendText"
      />
      <button type="button" class="send-btn" :disabled="sending || !draft.trim()" @click="onSendText">
        发送
      </button>
    </footer>
    <p v-else class="guest-hint">在右侧创建资料后即可发言</p>

    <div v-if="lightboxUrl" class="lightbox" @click="lightboxUrl = ''">
      <img :src="lightboxUrl" alt="预览" />
    </div>
  </section>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
  background: #1a1b1e;
  border-radius: 16px;
  border: 1px solid #2c2e33;
  overflow: hidden;
}
.chat-hd {
  display: flex;
  align-items: center;
  gap: 0.75rem;
  padding: 0.85rem 1.1rem;
  border-bottom: 1px solid #2c2e33;
  background: linear-gradient(180deg, #222428 0%, #1a1b1e 100%);
}
.room-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  background: #57f287;
  box-shadow: 0 0 0 4px rgba(87, 242, 135, 0.15);
  flex-shrink: 0;
}
.chat-hd h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 700;
  color: #f2f3f5;
}
.muted {
  color: #8b9199;
  font-size: 0.78rem;
  margin: 0.15rem 0 0;
}
.online-pill {
  margin-left: auto;
  font-size: 0.72rem;
  font-weight: 700;
  color: #57f287;
  background: rgba(87, 242, 135, 0.12);
  border-radius: 999px;
  padding: 0.2rem 0.55rem;
}
.banner.err {
  margin: 0.5rem 1rem 0;
  padding: 0.45rem 0.65rem;
  border-radius: 8px;
  background: rgba(237, 66, 69, 0.15);
  color: #f38688;
  font-size: 0.85rem;
}
.msg-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 1rem 1.1rem 1.25rem;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  background:
    radial-gradient(ellipse at top, rgba(88, 101, 242, 0.06), transparent 55%),
    #1a1b1e;
}
.center {
  text-align: center;
  margin: 1.5rem 0;
}
.empty {
  opacity: 0.85;
}
.load-more {
  align-self: center;
  border: 1px solid #3a3c43;
  background: #25272c;
  color: #b5bac1;
  border-radius: 999px;
  padding: 0.3rem 0.85rem;
  font-size: 0.75rem;
  cursor: pointer;
  margin-bottom: 0.5rem;
}
.msg-row {
  display: flex;
  gap: 0.55rem;
  align-items: flex-end;
  max-width: 100%;
}
.msg-row.mine {
  justify-content: flex-end;
}
.msg-row.compact {
  margin-top: -0.1rem;
}
.avatar-col {
  width: 36px;
  flex-shrink: 0;
  display: flex;
  justify-content: center;
}
.av-hit {
  border: 0;
  background: transparent;
  padding: 0;
  cursor: pointer;
  border-radius: 50%;
  line-height: 0;
}
.avatar-spacer {
  width: 36px;
  height: 8px;
}
.avatar {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-weight: 700;
  color: #fff;
  font-size: 0.85rem;
}
.avatar.img {
  object-fit: cover;
  background: #2b2d31;
}
.msg-col {
  max-width: min(72%, 520px);
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.msg-row.mine .msg-col {
  align-items: flex-end;
}
.msg-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: baseline;
  padding: 0 0.25rem;
}
.msg-row.mine .msg-meta {
  flex-direction: row-reverse;
}
.msg-meta strong {
  font-size: 0.78rem;
  color: #c8ccd2;
  font-weight: 700;
}
.title-badge {
  font-size: 0.68rem;
  font-weight: 700;
}
.time {
  color: #6a6e76;
  font-size: 0.68rem;
}
.bubble {
  background: #2b2d31;
  border-radius: 14px 14px 14px 4px;
  padding: 0.55rem 0.8rem;
  box-shadow: 0 1px 0 rgba(0, 0, 0, 0.2);
}
.msg-row.mine .bubble {
  background: linear-gradient(145deg, #5865f2, #4752c4);
  border-radius: 14px 14px 4px 14px;
  color: #fff;
}
.text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.92rem;
  line-height: 1.45;
}
.media-btn {
  border: 0;
  background: transparent;
  padding: 0;
  cursor: zoom-in;
  display: block;
  margin-top: 0.2rem;
}
.media-img {
  max-width: min(100%, 280px);
  max-height: 220px;
  border-radius: 10px;
  display: block;
}
.media-video {
  margin-top: 0.2rem;
  max-width: min(100%, 300px);
  max-height: 240px;
  border-radius: 10px;
  background: #000;
}
.composer {
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem 0.9rem;
  border-top: 1px solid #2c2e33;
  background: #151618;
  align-items: center;
}
.draft {
  flex: 1;
  border: 1px solid #34363c;
  background: #1e1f22;
  color: #dbdee1;
  border-radius: 22px;
  padding: 0.55rem 1rem;
  font-size: 0.9rem;
  outline: none;
}
.draft:focus {
  border-color: #5865f2;
}
.icon-btn {
  width: 38px;
  height: 38px;
  border-radius: 50%;
  border: 1px solid #34363c;
  background: #25272c;
  color: #dbdee1;
  font-size: 1.2rem;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}
.send-btn {
  border: 0;
  background: #5865f2;
  color: #fff;
  border-radius: 22px;
  padding: 0.5rem 1.1rem;
  font-weight: 700;
  font-size: 0.88rem;
  cursor: pointer;
  flex-shrink: 0;
}
.send-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.guest-hint {
  margin: 0;
  padding: 0.85rem 1rem;
  text-align: center;
  color: #8b9199;
  font-size: 0.85rem;
  border-top: 1px solid #2c2e33;
  background: #151618;
}
.lightbox {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.85);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 80;
  cursor: zoom-out;
}
.lightbox img {
  max-width: 92vw;
  max-height: 90vh;
  border-radius: 8px;
}
</style>
