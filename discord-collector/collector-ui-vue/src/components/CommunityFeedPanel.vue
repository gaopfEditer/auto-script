<script setup>
import { onMounted, onUnmounted, ref, watch } from "vue";
import { fetchCommunityFeed, fetchTwitterAuthors } from "../lib/communityApi.js";
import { subscribeCollectorSocket } from "../composables/useCollectorSocket.js";

const props = defineProps({
  /** @type {"card"|"twitter"} */
  feedType: { type: String, required: true },
});

const messages = ref(/** @type {any[]} */ ([]));
const authors = ref(/** @type {any[]} */ ([]));
const loading = ref(false);
const error = ref("");
const hasMore = ref(false);
const listEl = ref(/** @type {HTMLElement | null} */ (null));

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

function parsedLabel(p) {
  if (!p || typeof p !== "object") return "";
  if (p.status === "pending") return "AI 解析中…";
  if (p.status === "skipped") return "未启用 AI";
  if (p.status === "empty") return "无明确信号";
  if (p.status === "ok" || p.summary) {
    const bits = [];
    if (p.kind) bits.push(String(p.kind));
    if (p.symbol) bits.push(String(p.symbol));
    if (p.direction) bits.push(String(p.direction));
    return bits.join(" · ") || "已解析";
  }
  return "";
}

function upsertLocal(msg) {
  if (!msg?.id) return;
  if (msg.feedType && msg.feedType !== props.feedType) return;
  const idx = messages.value.findIndex((m) => m.id === msg.id);
  if (idx >= 0) messages.value[idx] = msg;
  else messages.value = [msg, ...messages.value];
}

async function load(initial = true) {
  loading.value = true;
  error.value = "";
  try {
    const beforeId = initial ? undefined : messages.value.at(-1)?.id;
    const data = await fetchCommunityFeed({
      type: props.feedType,
      limit: 40,
      beforeId,
    });
    const rows = data.messages ?? [];
    if (initial) messages.value = rows;
    else messages.value = [...messages.value, ...rows];
    hasMore.value = rows.length >= 40;
    if (props.feedType === "twitter" && initial) {
      try {
        const a = await fetchTwitterAuthors(100);
        authors.value = a.authors ?? [];
      } catch {
        authors.value = [];
      }
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function onSocket(msg) {
  if (msg?.channel !== "community") return;
  if (msg.kind === "feed_message" || msg.kind === "feed_message_updated") {
    const m = msg.message;
    if (m && (!m.feedType || m.feedType === props.feedType)) upsertLocal(m);
  }
  if (msg.kind === "twitter_author_upserted" && props.feedType === "twitter" && msg.author) {
    const a = msg.author;
    const idx = authors.value.findIndex((x) => x.authorKey === a.authorKey);
    if (idx >= 0) authors.value[idx] = a;
    else authors.value = [a, ...authors.value];
  }
}

let unsub = null;

watch(
  () => props.feedType,
  () => {
    void load(true);
  }
);

onMounted(() => {
  unsub = subscribeCollectorSocket(onSocket);
  void load(true);
});

onUnmounted(() => {
  unsub?.();
});
</script>

<template>
  <section class="feed-panel">
    <header class="feed-hd">
      <div>
        <h2>{{ feedType === "card" ? "消息频道" : "Twitter" }}</h2>
        <p class="muted">
          {{
            feedType === "card"
              ? "卡片产生时同步 · 正文与 Telegram 同格式"
              : "列表短贴 · AI 宽松解析 · 维护发帖人档案"
          }}
        </p>
      </div>
      <button type="button" class="ghost" :disabled="loading" @click="load(true)">刷新</button>
    </header>

    <p v-if="error" class="banner err">{{ error }}</p>
    <p v-if="loading && !messages.length" class="banner">加载中…</p>

    <div v-if="feedType === 'twitter' && authors.length" class="authors">
      <h3>发帖人</h3>
      <ul>
        <li v-for="a in authors.slice(0, 24)" :key="a.authorKey">
          <img v-if="a.avatarUrl" class="av img" :src="a.avatarUrl" alt="" />
          <span v-else class="av">{{ initialOf(a.displayName || a.handle) }}</span>
          <div>
            <strong>{{ a.displayName || a.handle || a.authorKey }}</strong>
            <div class="muted tiny">@{{ a.handle || a.authorKey }}</div>
          </div>
        </li>
      </ul>
    </div>

    <div ref="listEl" class="msg-list">
      <article v-for="m in messages" :key="m.id" class="msg">
        <header class="msg-hd">
          <template v-if="feedType === 'twitter'">
            <img v-if="m.authorAvatar" class="av img" :src="m.authorAvatar" alt="" />
            <span v-else class="av">{{ initialOf(m.authorName || m.authorHandle) }}</span>
            <div>
              <strong>{{ m.authorName || m.authorHandle || "Twitter" }}</strong>
              <span v-if="m.authorHandle" class="muted tiny"> @{{ m.authorHandle }}</span>
              <div class="muted tiny">{{ formatTime(m.createdAt) }}</div>
            </div>
          </template>
          <template v-else>
            <span class="ch-pill">{{ m.channelName || m.channelId || "频道" }}</span>
            <span class="muted tiny">{{ formatTime(m.createdAt) }}</span>
            <span v-if="m.cardId" class="muted tiny">#{{ m.cardId }}</span>
          </template>
        </header>
        <pre class="body">{{ m.content }}</pre>
        <div v-if="feedType === 'twitter' && m.parsed" class="ai">
          <span class="ai-tag">{{ parsedLabel(m.parsed) }}</span>
          <p v-if="m.parsed.summary">{{ m.parsed.summary }}</p>
          <p v-if="m.parsed.entry || m.parsed.stopLoss" class="muted tiny">
            <template v-if="m.parsed.entry">入场 {{ m.parsed.entry }}</template>
            <template v-if="m.parsed.takeProfits?.length">
              · TP {{ m.parsed.takeProfits.join("/") }}
            </template>
            <template v-if="m.parsed.stopLoss"> · SL {{ m.parsed.stopLoss }}</template>
          </p>
        </div>
        <a
          v-if="m.meta?.tweetUrl"
          class="link"
          :href="m.meta.tweetUrl"
          target="_blank"
          rel="noopener"
          >原文</a
        >
      </article>
      <p v-if="!loading && !messages.length" class="muted empty">暂无消息。</p>
      <button
        v-if="hasMore"
        type="button"
        class="ghost more"
        :disabled="loading"
        @click="load(false)"
      >
        加载更早
      </button>
    </div>
  </section>
</template>

<style scoped>
.feed-panel {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  background: #1e1f22;
  border: 1px solid #2c2e33;
  border-radius: 16px;
  overflow: hidden;
}
.feed-hd {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid #2c2e33;
  flex-shrink: 0;
}
.feed-hd h2 {
  margin: 0;
  font-size: 1.05rem;
  color: #f2f3f5;
}
.muted {
  color: #8b9199;
}
.tiny {
  font-size: 0.75rem;
}
.banner {
  margin: 0.5rem 1rem 0;
  padding: 0.45rem 0.65rem;
  border-radius: 8px;
  background: #151618;
  flex-shrink: 0;
}
.banner.err {
  background: #4a1f22;
  color: #f2a7ad;
}
.ghost {
  background: transparent;
  border: 1px solid #3a3c43;
  color: #dbdee1;
  border-radius: 8px;
  padding: 0.3rem 0.65rem;
  cursor: pointer;
  font-size: 0.82rem;
}
.ghost:disabled {
  opacity: 0.5;
}
.authors {
  padding: 0.65rem 1rem 0;
  flex-shrink: 0;
  border-bottom: 1px solid #2c2e33;
}
.authors h3 {
  margin: 0 0 0.45rem;
  font-size: 0.82rem;
  color: #949ba4;
}
.authors ul {
  list-style: none;
  margin: 0 0 0.65rem;
  padding: 0;
  display: flex;
  gap: 0.55rem;
  overflow-x: auto;
}
.authors li {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  min-width: 140px;
  padding: 0.35rem 0.45rem;
  background: #151618;
  border-radius: 10px;
}
.av {
  width: 32px;
  height: 32px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  background: #5865f2;
  color: #fff;
  font-weight: 800;
  font-size: 0.8rem;
  flex-shrink: 0;
}
.av.img {
  object-fit: cover;
}
.msg-list {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0.5rem 1rem 1rem;
}
.msg {
  padding: 0.75rem 0;
  border-bottom: 1px solid #2c2e33;
}
.msg-hd {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.45rem 0.65rem;
  margin-bottom: 0.4rem;
}
.ch-pill {
  background: #2b2d31;
  color: #f2f3f5;
  border-radius: 999px;
  padding: 0.15rem 0.55rem;
  font-size: 0.78rem;
  font-weight: 700;
}
.body {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font: inherit;
  line-height: 1.5;
  color: #dbdee1;
}
.ai {
  margin-top: 0.5rem;
  padding: 0.5rem 0.65rem;
  background: #151618;
  border-radius: 10px;
  border-left: 3px solid #1d9bf0;
}
.ai-tag {
  font-size: 0.75rem;
  font-weight: 700;
  color: #1d9bf0;
}
.ai p {
  margin: 0.3rem 0 0;
  font-size: 0.88rem;
}
.link {
  display: inline-block;
  margin-top: 0.35rem;
  color: #5865f2;
  font-size: 0.82rem;
}
.empty {
  padding: 1.5rem 0;
  text-align: center;
}
.more {
  display: block;
  margin: 0.75rem auto 0;
}
</style>
