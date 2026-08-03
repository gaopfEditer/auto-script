<script setup>
import { computed, nextTick, onMounted, onUnmounted, ref, watch } from "vue";
import {
  fetchAvatarPacks,
  fetchChatMessages,
  sendChatMessage,
  updateMyAvatar,
  uploadChatMedia,
} from "../lib/communityApi.js";
import { subscribeCollectorSocket } from "../composables/useCollectorSocket.js";

const props = defineProps({
  me: { type: Object, default: null },
});

const emit = defineEmits(["update:me"]);

const messages = ref([]);
const loading = ref(false);
const loadingMore = ref(false);
const error = ref("");
const draft = ref("");
const sending = ref(false);
const listEl = ref(null);
const fileInput = ref(null);
const lightboxUrl = ref("");
const showAvatarPicker = ref(false);
const packs = ref([]);
const avatarBusy = ref(false);

const hasMore = ref(true);
const oldestId = computed(() => (messages.value.length ? messages.value[0].id : null));

function formatTime(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("zh-CN", { hour12: false });
}

function initialOf(name) {
  const s = String(name || "?").trim();
  return (s[0] || "?").toUpperCase();
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

async function openAvatarPicker() {
  showAvatarPicker.value = true;
  if (!packs.value.length) {
    try {
      const data = await fetchAvatarPacks();
      packs.value = data.packs ?? [];
    } catch (e) {
      error.value = e instanceof Error ? e.message : String(e);
    }
  }
}

async function chooseAvatar(url) {
  avatarBusy.value = true;
  try {
    const data = await updateMyAvatar(url);
    if (data.member) emit("update:me", data.member);
    showAvatarPicker.value = false;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    avatarBusy.value = false;
  }
}

function onSocket(msg) {
  if (msg?.channel !== "community") return;
  if (msg?.kind !== "chat_message") return;
  const m = msg.message;
  if (m) {
    const nearBottom =
      listEl.value && listEl.value.scrollHeight - listEl.value.scrollTop - listEl.value.clientHeight < 120;
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

watch(
  () => props.me?.id,
  () => {
    /* keep */
  }
);
</script>

<template>
  <section class="chat-panel">
    <header class="chat-hd">
      <div>
        <h2>实时聊天室</h2>
        <p class="muted">公共大厅 · 文字 / 图片 / 短视频 · WebSocket 实时推送</p>
      </div>
      <button v-if="me" type="button" class="ghost" @click="openAvatarPicker">换头像包</button>
    </header>

    <p v-if="error" class="banner err">{{ error }}</p>
    <p v-if="!me" class="muted hint">加入社区后即可发言、发图与短视频。</p>

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
      <p v-else-if="!messages.length" class="muted center">还没有消息，来打个招呼吧</p>

      <article v-for="m in messages" :key="m.id" class="msg">
        <div class="avatar-wrap">
          <img v-if="m.author?.avatarUrl" class="avatar img" :src="m.author.avatarUrl" alt="" />
          <span
            v-else
            class="avatar"
            :style="{ background: m.author?.title?.color || '#5865f2' }"
            >{{ initialOf(m.author?.displayName) }}</span
          >
        </div>
        <div class="bubble">
          <header class="msg-meta">
            <strong>{{ m.author?.displayName || "匿名" }}</strong>
            <span class="title-badge" :style="{ color: m.author?.title?.color }">{{
              m.author?.title?.label
            }}</span>
            <span class="time">{{ formatTime(m.createdAt) }}</span>
          </header>
          <p v-if="m.content" class="text">{{ m.content }}</p>
          <button
            v-if="m.type === 'image' && m.mediaUrl"
            type="button"
            class="media-btn"
            @click="lightboxUrl = m.mediaUrl"
          >
            <img :src="m.mediaUrl" alt="图片" class="media-img" />
          </button>
          <video v-else-if="m.type === 'video' && m.mediaUrl" class="media-video" controls playsinline :src="m.mediaUrl" />
        </div>
      </article>
    </div>

    <footer v-if="me" class="composer">
      <input ref="fileInput" type="file" accept="image/jpeg,image/png,image/gif,image/webp,video/mp4,video/webm" hidden @change="onFileChange" />
      <button type="button" class="ghost attach" :disabled="sending" title="发送图片或短视频" @click="pickFile">
        附件
      </button>
      <input
        v-model="draft"
        class="draft"
        maxlength="2000"
        placeholder="说点什么…（Enter 发送）"
        :disabled="sending"
        @keyup.enter="onSendText"
      />
      <button type="button" class="primary" :disabled="sending || !draft.trim()" @click="onSendText">
        {{ sending ? "发送中…" : "发送" }}
      </button>
    </footer>

    <div v-if="lightboxUrl" class="lightbox" @click="lightboxUrl = ''">
      <img :src="lightboxUrl" alt="预览" />
    </div>

    <div v-if="showAvatarPicker" class="modal-mask" @click.self="showAvatarPicker = false">
      <div class="modal">
        <header class="modal-hd">
          <h3>有趣头像包</h3>
          <button type="button" class="ghost" @click="showAvatarPicker = false">关闭</button>
        </header>
        <div v-for="pack in packs" :key="pack.id" class="pack">
          <h4>{{ pack.label }}</h4>
          <div class="pack-grid">
            <button
              v-for="a in pack.avatars"
              :key="a.id"
              type="button"
              class="pack-item"
              :disabled="avatarBusy"
              :class="{ active: me?.avatarUrl === a.url }"
              :title="a.label"
              @click="chooseAvatar(a.url)"
            >
              <img :src="a.url" :alt="a.label" />
              <span>{{ a.label }}</span>
            </button>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
.chat-panel {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: min(70vh, 640px);
  background: #1e1f22;
  border: 1px solid #2b2d31;
  border-radius: 12px;
  overflow: hidden;
}
.chat-hd {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid #2b2d31;
}
.chat-hd h2 {
  margin: 0;
  font-size: 1.05rem;
}
.muted {
  color: #949ba4;
  font-size: 0.82rem;
  margin: 0.25rem 0 0;
}
.hint {
  padding: 0 1rem;
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
  padding: 0.75rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}
.center {
  text-align: center;
  margin: 1rem 0;
}
.load-more {
  align-self: center;
  border: 1px solid #3f4147;
  background: #2b2d31;
  color: #b5bac1;
  border-radius: 999px;
  padding: 0.25rem 0.75rem;
  font-size: 0.78rem;
  cursor: pointer;
}
.msg {
  display: flex;
  gap: 0.65rem;
  align-items: flex-start;
}
.avatar-wrap {
  flex-shrink: 0;
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
.bubble {
  min-width: 0;
  flex: 1;
  background: #2b2d31;
  border-radius: 10px;
  padding: 0.45rem 0.7rem 0.55rem;
}
.msg-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: baseline;
  margin-bottom: 0.2rem;
}
.msg-meta strong {
  font-size: 0.88rem;
}
.title-badge {
  font-size: 0.72rem;
  font-weight: 700;
}
.time {
  color: #6d6f78;
  font-size: 0.72rem;
  margin-left: auto;
}
.text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.9rem;
  line-height: 1.45;
}
.media-btn {
  border: 0;
  background: transparent;
  padding: 0;
  cursor: zoom-in;
  display: block;
  margin-top: 0.35rem;
}
.media-img {
  max-width: min(100%, 320px);
  max-height: 240px;
  border-radius: 8px;
  display: block;
}
.media-video {
  margin-top: 0.35rem;
  max-width: min(100%, 360px);
  max-height: 260px;
  border-radius: 8px;
  background: #000;
}
.composer {
  display: flex;
  gap: 0.5rem;
  padding: 0.65rem 0.85rem;
  border-top: 1px solid #2b2d31;
  background: #18191c;
}
.draft {
  flex: 1;
  border: 1px solid #3f4147;
  background: #1e1f22;
  color: #dbdee1;
  border-radius: 8px;
  padding: 0.45rem 0.65rem;
  font-size: 0.9rem;
}
.primary,
.ghost {
  border-radius: 8px;
  padding: 0.4rem 0.75rem;
  font-size: 0.85rem;
  cursor: pointer;
  border: 1px solid #3f4147;
}
.primary {
  background: #5865f2;
  border-color: #5865f2;
  color: #fff;
  font-weight: 600;
}
.primary:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.ghost {
  background: #2b2d31;
  color: #b5bac1;
}
.attach {
  white-space: nowrap;
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
.modal-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 70;
  padding: 1rem;
}
.modal {
  width: min(520px, 100%);
  max-height: 80vh;
  overflow: auto;
  background: #1e1f22;
  border: 1px solid #3f4147;
  border-radius: 12px;
  padding: 0.85rem 1rem 1rem;
}
.modal-hd {
  display: flex;
  justify-content: space-between;
  align-items: center;
  margin-bottom: 0.75rem;
}
.modal-hd h3 {
  margin: 0;
}
.pack h4 {
  margin: 0.75rem 0 0.45rem;
  font-size: 0.9rem;
  color: #dbdee1;
}
.pack-grid {
  display: grid;
  grid-template-columns: repeat(4, 1fr);
  gap: 0.5rem;
}
.pack-item {
  border: 1px solid #3f4147;
  background: #2b2d31;
  border-radius: 10px;
  padding: 0.4rem;
  cursor: pointer;
  color: #b5bac1;
  font-size: 0.72rem;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 0.25rem;
}
.pack-item.active {
  border-color: #5865f2;
  box-shadow: 0 0 0 1px #5865f2;
}
.pack-item img {
  width: 48px;
  height: 48px;
  border-radius: 50%;
}
</style>
