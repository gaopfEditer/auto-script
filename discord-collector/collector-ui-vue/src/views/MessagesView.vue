<script setup>
import { ref, onMounted } from "vue";
import { useCollectorSocket } from "../composables/useCollectorSocket.js";
import { useDebugMode } from "../composables/useDebugMode.js";
import { authorLabel, formatMessageCardTitle } from "../lib/discordExtract.js";

defineOptions({ name: "MessagesView" });

/** @type {import('vue').Ref<Array<Record<string, unknown>>>} */
const rows = ref([]);
const loading = ref(true);
const expanded = ref(/** @type {Set<string>} */ (new Set()));
const { debugMode, applyConfigFromSocket } = useDebugMode();

async function loadHistory() {
  loading.value = true;
  try {
    const res = await fetch("/api/discord/messages?limit=200");
    const data = await res.json();
    if (typeof data.debugMode === "boolean") {
      debugMode.value = data.debugMode;
    }
    if (data.ok) rows.value = data.rows ?? [];
  } finally {
    loading.value = false;
  }
}

/** @param {Record<string, unknown>} msg */
function onSocketMsg(msg) {
  applyConfigFromSocket(msg);
  if (msg.channel !== "message" || msg.kind !== "discord_message_batch") return;
  const batch = Array.isArray(msg.rows) ? msg.rows : [];
  for (const r of batch) {
    rows.value.unshift(r);
  }
  if (rows.value.length > 500) rows.value.length = 500;
}

useCollectorSocket(onSocketMsg);
onMounted(loadHistory);

/** @param {string} id */
function toggleRaw(id) {
  const s = new Set(expanded.value);
  if (s.has(id)) s.delete(id);
  else s.add(id);
  expanded.value = s;
}
</script>

<template>
  <div class="msg-root">
    <header>
      <div>
        <h2>Discord 消息</h2>
        <p class="mode-hint">{{ debugMode ? "Debug：全量字段 + 原始 JSON" : "精简：服务器 / 频道 / 正文" }}</p>
      </div>
      <button @click="loadHistory">刷新</button>
    </header>
    <p v-if="loading" class="hint">加载中…</p>
    <div v-else class="list">
      <article v-for="m in rows" :key="String(m.messageId ?? m.message_id)" class="card">
        <div class="location">{{ formatMessageCardTitle(m) }}</div>
        <div class="meta">
          <strong>{{ authorLabel(m) }}</strong>
          <span class="src">{{ m.source }}</span>
          <span class="ev">{{ m.eventType ?? m.event_type }}</span>
          <span v-if="debugMode" class="id">msg:{{ m.messageId ?? m.message_id }}</span>
        </div>
        <p class="content">{{ m.content || "（无文本）" }}</p>
        <template v-if="debugMode && (m.rawJson ?? m.raw_json)">
          <button class="raw-toggle" @click="toggleRaw(String(m.messageId ?? m.message_id))">
            {{ expanded.has(String(m.messageId ?? m.message_id)) ? "收起" : "展开" }} raw_json
          </button>
          <pre
            v-if="expanded.has(String(m.messageId ?? m.message_id))"
            class="raw-json"
          >{{ JSON.stringify(m.rawJson ?? m.raw_json, null, 2) }}</pre>
        </template>
      </article>
      <p v-if="!rows.length" class="hint">暂无消息。请确保 Chrome 已登录 Discord 且 collect:ui 在运行。</p>
    </div>
  </div>
</template>

<style scoped>
.msg-root {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
header {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid #1e1f22;
  gap: 1rem;
}
h2 {
  margin: 0;
  font-size: 1.1rem;
}
.mode-hint {
  margin: 0.25rem 0 0;
  font-size: 0.75rem;
  color: #949ba4;
}
button {
  background: #5865f2;
  color: #fff;
  border: none;
  padding: 0.35rem 0.75rem;
  border-radius: 6px;
  cursor: pointer;
  flex-shrink: 0;
}
.list {
  flex: 1;
  overflow: auto;
  padding: 0.75rem 1rem;
}
.card {
  background: #2b2d31;
  border-radius: 8px;
  padding: 0.65rem 0.85rem;
  margin-bottom: 0.5rem;
  border: 1px solid #3f4147;
}
.location {
  font-size: 0.82rem;
  font-weight: 700;
  color: #5865f2;
  margin-bottom: 0.35rem;
}
.meta {
  font-size: 0.78rem;
  color: #949ba4;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-bottom: 0.35rem;
}
.meta strong {
  color: #f2f3f5;
}
.content {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.raw-toggle {
  margin-top: 0.5rem;
  font-size: 0.75rem;
  padding: 0.2rem 0.5rem;
  background: #3f4147;
}
.raw-json {
  margin: 0.5rem 0 0;
  padding: 0.5rem;
  background: #1e1f22;
  border-radius: 6px;
  font-size: 0.7rem;
  overflow: auto;
  max-height: 280px;
}
.hint {
  color: #949ba4;
  padding: 1rem;
}
.id {
  font-family: monospace;
  font-size: 0.7rem;
}
</style>
