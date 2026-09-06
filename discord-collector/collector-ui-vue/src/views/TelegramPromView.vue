<script setup>
import { computed, nextTick, onActivated, onMounted, onUnmounted, ref, watch } from "vue";
import { subscribeCollectorSocket } from "../composables/useCollectorSocket.js";

defineOptions({ name: "TelegramPromView" });

/** @typedef {{ chatId: string, name: string, avatarUrl: string }} Channel */
/** @typedef {{
 *   id: string,
 *   chatId: string,
 *   chatName: string,
 *   avatarUrl: string,
 *   sender: string,
 *   text: string,
 *   messageId: number,
 *   at: string,
 *   receivedAt: number,
 *   pinned?: boolean,
 *   pinNote?: string,
 *   pinOrder?: number,
 *   imageUrls?: string[],
 * }} LiveMessage */

const TIME_OPTIONS = [
  { value: "1h", label: "近 1 小时" },
  { value: "6h", label: "近 6 小时" },
  { value: "today", label: "今天" },
  { value: "24h", label: "近 24 小时" },
  { value: "7d", label: "近 7 天" },
  { value: "all", label: "全部" },
];

const channels = ref(/** @type {Channel[]} */ ([]));
const messages = ref(/** @type {LiveMessage[]} */ ([]));
const activeChatId = ref("");
const timePeriod = ref("today");
const symbolQuery = ref("");
const loading = ref(false);
const error = ref("");
const status = ref("连接中…");

/** @type {import("vue").Ref<LiveMessage | null>} */
const editPin = ref(null);
const editNote = ref("");
const editText = ref("");
const editSaving = ref(false);

/** @type {import("vue").Ref<Record<string, HTMLElement | null>>} */
const colBodies = ref({});

function msgTime(m) {
  const t = Date.parse(String(m.at || ""));
  if (Number.isFinite(t)) return t;
  return Number(m.receivedAt) || 0;
}

function withinPeriod(m, period) {
  const t = msgTime(m);
  if (!t) return period === "all";
  const now = Date.now();
  if (period === "all") return true;
  if (period === "1h") return now - t <= 3600_000;
  if (period === "6h") return now - t <= 6 * 3600_000;
  if (period === "24h") return now - t <= 24 * 3600_000;
  if (period === "7d") return now - t <= 7 * 24 * 3600_000;
  if (period === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return t >= start.getTime();
  }
  return true;
}

function textHasSymbol(text, rawSym) {
  const q = String(rawSym || "")
    .trim()
    .replace(/^\$/, "")
    .replace(/[/\s_-]*(USDT|USDC|USD)$/i, "")
    .toUpperCase();
  if (!q) return true;
  const hay = String(text || "").toUpperCase();
  if (hay.includes(q)) return true;
  return hay.includes(`$${q}`) || hay.includes(`${q}USDT`) || hay.includes(`${q}/USDT`);
}

const filteredMessages = computed(() => {
  const id = activeChatId.value;
  const period = timePeriod.value;
  const sym = symbolQuery.value;
  return messages.value
    .filter((m) => {
      if (id && m.chatId !== id && m.chatId !== String(Number(id))) return false;
      if (m.pinned) return true; // 置顶始终可见（再按币种筛）
      if (!withinPeriod(m, period)) return false;
      if (!textHasSymbol(m.text, sym) && !textHasSymbol(m.pinNote || "", sym)) return false;
      return true;
    })
    .filter((m) => {
      if (!sym.trim()) return true;
      return textHasSymbol(m.text, sym) || textHasSymbol(m.pinNote || "", sym);
    })
    .slice()
    .sort((a, b) => msgTime(a) - msgTime(b));
});

const visibleChannels = computed(() => {
  const id = activeChatId.value;
  if (!id) return channels.value;
  return channels.value.filter((c) => c.chatId === id);
});

const pinnedMessages = computed(() =>
  messages.value
    .filter((m) => m.pinned)
    .filter((m) => {
      const id = activeChatId.value;
      if (id && m.chatId !== id && m.chatId !== String(Number(id))) return false;
      return true;
    })
    .slice()
    .sort((a, b) => (Number(b.pinOrder) || 0) - (Number(a.pinOrder) || 0)),
);

/** @param {string} chatId */
function messagesForChannel(chatId) {
  return filteredMessages.value.filter(
    (m) => !m.pinned && (m.chatId === chatId || m.chatId === String(Number(chatId))),
  );
}

function formatTime(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso || "");
  return d.toLocaleString("zh-CN", {
    hour12: false,
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

/** @param {string} chatId @param {HTMLElement | null} el */
function setColBody(chatId, el) {
  if (el) colBodies.value[chatId] = el;
  else delete colBodies.value[chatId];
}

function scrollColumnToBottom(chatId, { smooth = false } = {}) {
  const el = colBodies.value[chatId];
  if (!el) return;
  el.scrollTo({
    top: el.scrollHeight,
    behavior: smooth ? "smooth" : "auto",
  });
}

function scrollAllToBottom({ smooth = false } = {}) {
  for (const c of visibleChannels.value) {
    scrollColumnToBottom(c.chatId, { smooth });
  }
}

function upsertMessage(msg) {
  if (!msg?.id) return;
  const idx = messages.value.findIndex((m) => m.id === msg.id);
  if (idx >= 0) {
    const next = messages.value.slice();
    next[idx] = { ...next[idx], ...msg };
    messages.value = next;
  } else {
    messages.value = [...messages.value, msg].slice(-2000);
  }
}

/** @param {Response} r */
async function readJson(r) {
  const text = await r.text();
  if (!r.ok) {
    throw new Error(
      text
        ? `HTTP ${r.status}: ${text.slice(0, 160)}`
        : `HTTP ${r.status}（collect:ui 未响应，请检查 :3851）`,
    );
  }
  if (!text.trim()) {
    throw new Error("空响应：collect:ui 可能未启动或代理失败（pnpm run collect:ui）");
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(`非 JSON 响应: ${text.slice(0, 120)}`);
  }
}

async function loadChannels() {
  try {
    const r = await fetch("/api/telegram/live/channels");
    const j = await readJson(r);
    if (!j.ok) throw new Error(j.error || "channels failed");
    channels.value = Array.isArray(j.channels) ? j.channels : [];
    if (!j.profilesOk && j.error) {
      error.value = String(j.error);
    } else {
      error.value = "";
    }
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  }
}

async function loadMessages() {
  loading.value = true;
  try {
    const r = await fetch("/api/telegram/live/messages?limit=800");
    const j = await readJson(r);
    if (!j.ok) throw new Error(j.error || "messages failed");
    const rows = Array.isArray(j.messages) ? j.messages : [];
    messages.value = rows.slice().sort((a, b) => msgTime(a) - msgTime(b));
    status.value = `库内 ${j.total ?? rows.length} 条 · 置顶 ${j.pinnedCount ?? 0} · ${channels.value.length} 群`;
    error.value = "";
    await nextTick();
    scrollAllToBottom();
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    loading.value = false;
  }
}

function selectChannel(id) {
  activeChatId.value = activeChatId.value === id ? "" : id;
  void nextTick(() => scrollAllToBottom());
}

function clearFilters() {
  timePeriod.value = "today";
  symbolQuery.value = "";
  activeChatId.value = "";
}

/** @param {LiveMessage} m */
async function togglePin(m) {
  try {
    const r = await fetch("/api/telegram/live/pin", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: m.id, pinned: !m.pinned }),
    });
    const j = await readJson(r);
    if (!j.ok) throw new Error(j.error || "pin failed");
    if (j.message) upsertMessage(j.message);
    error.value = "";
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  }
}

/** @param {LiveMessage} m */
function openEditPin(m) {
  editPin.value = m;
  editNote.value = m.pinNote || "";
  editText.value = m.text || "";
}

function closeEditPin() {
  editPin.value = null;
}

async function saveEditPin() {
  if (!editPin.value) return;
  editSaving.value = true;
  try {
    const id = encodeURIComponent(editPin.value.id);
    const r = await fetch(`/api/telegram/live/pins/${id}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pinNote: editNote.value, text: editText.value }),
    });
    const j = await readJson(r);
    if (!j.ok) throw new Error(j.error || "save failed");
    if (j.message) upsertMessage(j.message);
    error.value = "";
    closeEditPin();
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    editSaving.value = false;
  }
}

/** @param {Record<string, unknown>} msg */
function onWs(msg) {
  if (msg.channel !== "telegram_live") return;
  const kind = String(msg.kind ?? "");
  if (kind === "telegram_cleared") {
    messages.value = messages.value.filter((m) => m.pinned);
    status.value = "未置顶消息已清空（库仍保留置顶）";
    return;
  }
  if (
    (kind === "telegram_message" || kind === "telegram_pin") &&
    msg.message &&
    typeof msg.message === "object"
  ) {
    const m = /** @type {LiveMessage} */ (msg.message);
    upsertMessage(m);
    status.value = `实时 · ${new Date().toLocaleTimeString("zh-CN", { hour12: false })}`;
    if (kind === "telegram_message") {
      void nextTick(() => scrollColumnToBottom(m.chatId, { smooth: true }));
    }
  }
}

watch([timePeriod, symbolQuery, activeChatId], async () => {
  await nextTick();
  scrollAllToBottom();
});

let unsub = /** @type {null | (() => void)} */ (null);
let pollTimer = /** @type {ReturnType<typeof setInterval> | null} */ (null);

onMounted(() => {
  void (async () => {
    await loadChannels();
    await loadMessages();
  })();
  unsub = subscribeCollectorSocket(onWs);
  pollTimer = setInterval(() => void loadMessages(), 20_000);
});

onActivated(() => {
  // KeepAlive 切回时从库补最新
  void loadMessages();
});

onUnmounted(() => {
  unsub?.();
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div class="tg-live">
    <header class="tg-live-head">
      <div>
        <h1>Telegram 实时</h1>
        <p class="muted">
          消息落库 <code>data/telegram-live.sqlite</code> · 切 tab 可续拉 · 支持置顶编辑
        </p>
      </div>
      <div class="tg-live-meta">
        <span class="status">{{ status }}</span>
        <button type="button" :disabled="loading" @click="loadMessages">
          {{ loading ? "刷新中…" : "刷新" }}
        </button>
      </div>
    </header>

    <p v-if="error" class="err">{{ error }}</p>

    <section class="filters" aria-label="筛选">
      <label class="field">
        <span>时间</span>
        <select v-model="timePeriod">
          <option v-for="o in TIME_OPTIONS" :key="o.value" :value="o.value">
            {{ o.label }}
          </option>
        </select>
      </label>
      <label class="field grow">
        <span>币种</span>
        <input
          v-model="symbolQuery"
          type="search"
          placeholder="BTC / ETH / SOL…（匹配正文包含）"
          autocomplete="off"
          spellcheck="false"
        />
      </label>
      <button type="button" class="ghost" @click="clearFilters">重置</button>
    </section>

    <section class="channels" aria-label="群组">
      <button
        type="button"
        class="chip"
        :class="{ on: !activeChatId }"
        @click="selectChannel('')"
      >
        全部
      </button>
      <button
        v-for="c in channels"
        :key="c.chatId"
        type="button"
        class="chip"
        :class="{ on: activeChatId === c.chatId }"
        :title="c.chatId"
        @click="selectChannel(c.chatId)"
      >
        <img v-if="c.avatarUrl" class="chip-av" :src="c.avatarUrl" alt="" />
        <span>{{ c.name }}</span>
      </button>
    </section>

    <section v-if="pinnedMessages.length" class="pins" aria-label="置顶">
      <header class="pins-head">置顶 · {{ pinnedMessages.length }}</header>
      <div class="pins-list">
        <article v-for="m in pinnedMessages" :key="'pin-' + m.id" class="pin-card">
          <div class="pin-meta">
            <strong>{{ m.chatName }}</strong>
            <span>{{ m.sender }}</span>
            <time>{{ formatTime(m.at) }}</time>
          </div>
          <p v-if="m.pinNote" class="pin-note">{{ m.pinNote }}</p>
          <p v-if="m.text" class="text">{{ m.text }}</p>
          <div v-if="m.imageUrls?.length" class="msg-media">
            <a
              v-for="(u, i) in m.imageUrls"
              :key="m.id + '-pin-img-' + i"
              :href="u"
              target="_blank"
              rel="noopener"
            >
              <img :src="u" alt="" loading="lazy" />
            </a>
          </div>
          <div class="pin-actions">
            <button type="button" class="ghost" @click="openEditPin(m)">编辑</button>
            <button type="button" class="ghost" @click="togglePin(m)">取消置顶</button>
          </div>
        </article>
      </div>
    </section>

    <section
      class="board"
      :class="{ single: visibleChannels.length === 1 }"
      aria-live="polite"
    >
      <div v-for="c in visibleChannels" :key="c.chatId" class="col">
        <header class="col-head">
          <img v-if="c.avatarUrl" class="col-av" :src="c.avatarUrl" alt="" />
          <div v-else class="col-av fallback">{{ (c.name || "?").slice(0, 1) }}</div>
          <div class="col-title">
            <strong>{{ c.name }}</strong>
            <span>{{ messagesForChannel(c.chatId).length }} 条</span>
          </div>
        </header>
        <div
          class="col-body"
          :ref="(el) => setColBody(c.chatId, /** @type {HTMLElement | null} */ (el))"
        >
          <article
            v-for="m in messagesForChannel(c.chatId)"
            :key="m.id"
            class="bubble"
          >
            <div class="meta">
              <span class="sender">{{ m.sender }}</span>
              <time>{{ formatTime(m.at) }}</time>
              <button type="button" class="pin-btn" title="置顶" @click="togglePin(m)">
                置顶
              </button>
            </div>
            <p v-if="m.text" class="text">{{ m.text }}</p>
            <div v-if="m.imageUrls?.length" class="msg-media">
              <a
                v-for="(u, i) in m.imageUrls"
                :key="m.id + '-img-' + i"
                :href="u"
                target="_blank"
                rel="noopener"
              >
                <img :src="u" alt="" loading="lazy" />
              </a>
            </div>
          </article>
          <p v-if="!messagesForChannel(c.chatId).length" class="col-empty">
            {{ symbolQuery.trim() || timePeriod !== "all" ? "无匹配消息" : "暂无消息" }}
          </p>
        </div>
      </div>
      <p v-if="!visibleChannels.length" class="empty">
        暂无频道。请确认 collect:ui + listen.py + channel_profiles.json
      </p>
    </section>

    <div v-if="editPin" class="modal" role="dialog" aria-modal="true">
      <div class="modal-card">
        <header>
          <strong>编辑置顶</strong>
          <button type="button" class="ghost" @click="closeEditPin">关闭</button>
        </header>
        <p class="muted">{{ editPin.chatName }} · {{ editPin.sender }}</p>
        <label class="field grow">
          <span>备注（操作提示）</span>
          <textarea v-model="editNote" rows="3" placeholder="例如：等回踩 / 已下单…" />
        </label>
        <label class="field grow">
          <span>正文</span>
          <textarea v-model="editText" rows="6" />
        </label>
        <div class="modal-actions">
          <button type="button" class="ghost" @click="closeEditPin">取消</button>
          <button type="button" :disabled="editSaving" @click="saveEditPin">
            {{ editSaving ? "保存中…" : "保存" }}
          </button>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tg-live {
  height: 100%;
  display: flex;
  flex-direction: column;
  min-height: 0;
  padding: 1rem 1.25rem 1.25rem;
  color: #dbdee1;
  background:
    radial-gradient(720px 320px at 8% -10%, #2a3140 0%, transparent 55%),
    #1e1f22;
}
.tg-live-head {
  display: flex;
  justify-content: space-between;
  gap: 1rem;
  align-items: flex-start;
  flex-shrink: 0;
}
.tg-live-head h1 {
  margin: 0 0 0.3rem;
  font-size: 1.2rem;
}
.muted {
  margin: 0;
  color: #949ba4;
  font-size: 0.82rem;
  line-height: 1.45;
}
.tg-live-meta {
  display: flex;
  align-items: center;
  gap: 0.6rem;
  flex-shrink: 0;
}
.status {
  font-size: 0.75rem;
  color: #949ba4;
}
button {
  border: 1px solid #4e5058;
  background: #383a40;
  color: #e8eaed;
  border-radius: 6px;
  padding: 0.35rem 0.7rem;
  font-size: 0.8rem;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
button.ghost {
  background: transparent;
}
.err {
  color: #f23f43;
  font-size: 0.85rem;
  margin: 0.6rem 0 0;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem 0.75rem;
  align-items: flex-end;
  margin-top: 0.85rem;
  flex-shrink: 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 9rem;
  font-size: 0.72rem;
  color: #949ba4;
}
.field.grow {
  flex: 1;
  min-width: 12rem;
}
.field select,
.field input,
.field textarea {
  border: 1px solid #4e5058;
  background: #2b2d31;
  color: #e8eaed;
  border-radius: 6px;
  padding: 0.4rem 0.55rem;
  font-size: 0.82rem;
  font-family: inherit;
}
.field textarea {
  resize: vertical;
}
.channels {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-top: 0.7rem;
  flex-shrink: 0;
}
.chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  border: 1px solid #4e5058;
  background: #2b2d31;
  border-radius: 999px;
  padding: 0.28rem 0.7rem 0.28rem 0.35rem;
  font-size: 0.78rem;
  color: #b5bac1;
}
.chip.on {
  border-color: #5865f2;
  background: rgba(88, 101, 242, 0.18);
  color: #e8eaed;
}
.chip-av {
  width: 22px;
  height: 22px;
  border-radius: 50%;
  object-fit: cover;
}
.pins {
  margin-top: 0.75rem;
  flex-shrink: 0;
  border: 1px solid #4a3f1f;
  border-radius: 10px;
  background: rgba(240, 185, 11, 0.08);
  max-height: 28vh;
  overflow: auto;
}
.pins-head {
  padding: 0.45rem 0.7rem;
  font-size: 0.75rem;
  color: #f0b90b;
  border-bottom: 1px solid #4a3f1f;
}
.pins-list {
  display: grid;
  gap: 0.5rem;
  padding: 0.55rem 0.65rem 0.7rem;
  grid-template-columns: repeat(auto-fit, minmax(220px, 1fr));
}
.pin-card {
  border: 1px solid #5a4a20;
  border-radius: 8px;
  background: #232018;
  padding: 0.5rem 0.6rem;
}
.pin-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.55rem;
  font-size: 0.72rem;
  color: #949ba4;
  margin-bottom: 0.25rem;
}
.pin-meta strong {
  color: #f0d78c;
}
.pin-note {
  margin: 0 0 0.3rem;
  font-size: 0.8rem;
  color: #f0b90b;
  white-space: pre-wrap;
}
.pin-actions {
  display: flex;
  gap: 0.4rem;
  margin-top: 0.4rem;
}
.board {
  flex: 1;
  min-height: 0;
  margin-top: 0.85rem;
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(240px, 1fr));
  gap: 0.65rem;
  overflow-x: auto;
  overflow-y: hidden;
}
.board.single {
  grid-template-columns: minmax(280px, 560px);
}
.col {
  display: flex;
  flex-direction: column;
  min-width: 0;
  min-height: 0;
  border: 1px solid #3f4147;
  border-radius: 10px;
  background: #2b2d31;
  overflow: hidden;
}
.col-head {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.55rem 0.7rem;
  border-bottom: 1px solid #3f4147;
  background: #232428;
  flex-shrink: 0;
}
.col-av {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  object-fit: cover;
  flex-shrink: 0;
  background: #1e1f22;
}
.col-av.fallback {
  display: grid;
  place-items: center;
  font-weight: 700;
  font-size: 0.75rem;
  color: #c9cdfb;
  background: #383a40;
}
.col-title {
  display: flex;
  flex-direction: column;
  gap: 0.1rem;
  min-width: 0;
}
.col-title strong {
  font-size: 0.82rem;
  color: #e8eaed;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.col-title span {
  font-size: 0.7rem;
  color: #949ba4;
}
.col-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0.55rem 0.65rem 0.75rem;
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.bubble {
  padding: 0.5rem 0.6rem;
  border-radius: 8px;
  background: #1e1f22;
  border: 1px solid #383a40;
}
.meta {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.55rem;
  align-items: baseline;
  font-size: 0.72rem;
  color: #949ba4;
  margin-bottom: 0.25rem;
}
.sender {
  color: #b5bac1;
  font-weight: 600;
}
.pin-btn {
  margin-left: auto;
  padding: 0.1rem 0.4rem;
  font-size: 0.68rem;
  border-radius: 4px;
  border-color: #5a4a20;
  color: #f0b90b;
  background: transparent;
}
.text {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-size: 0.84rem;
  line-height: 1.45;
  color: #dbdee1;
}
.msg-media {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  margin-top: 0.4rem;
}
.msg-media a {
  display: block;
  max-width: 100%;
  border-radius: 8px;
  overflow: hidden;
  border: 1px solid #3f4147;
  background: #1e1f22;
}
.msg-media img {
  display: block;
  max-width: min(100%, 320px);
  max-height: 280px;
  width: auto;
  height: auto;
  object-fit: contain;
}
.col-empty,
.empty {
  margin: 1.5rem auto;
  text-align: center;
  color: #949ba4;
  font-size: 0.82rem;
  line-height: 1.7;
}
.modal {
  position: fixed;
  inset: 0;
  z-index: 80;
  background: rgba(0, 0, 0, 0.55);
  display: grid;
  place-items: center;
  padding: 1rem;
}
.modal-card {
  width: min(520px, 100%);
  background: #2b2d31;
  border: 1px solid #4e5058;
  border-radius: 10px;
  padding: 0.85rem 1rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}
.modal-card header {
  display: flex;
  justify-content: space-between;
  align-items: center;
}
.modal-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
}
code {
  font-size: 0.85em;
  color: #c9cdfb;
}
</style>
