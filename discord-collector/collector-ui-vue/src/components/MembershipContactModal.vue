<script setup>
import { computed, nextTick, ref, watch } from "vue";
import {
  formatMessageTime,
  useMembership,
} from "../composables/useMembership.js";

const {
  isMember,
  messages,
  contactOpen,
  closeContact,
  sendFromVisitor,
  sendFromAgent,
  selectedPlan,
} = useMembership();

const draft = ref("");
const listEl = ref(/** @type {HTMLElement | null} */ (null));
const inputEl = ref(/** @type {HTMLInputElement | null} */ (null));

const lastTs = computed(() => (messages.value.length ? messages.value[messages.value.length - 1].ts : Date.now()));
const preview = computed(() => {
  const lastUser = [...messages.value].reverse().find((m) => m.role === "user");
  if (lastUser) return `我：${lastUser.text}`;
  return "暂无留言";
});

async function scrollToBottom() {
  await nextTick();
  const el = listEl.value;
  if (el) el.scrollTop = el.scrollHeight;
}

watch(
  () => [contactOpen.value, messages.value.length],
  async ([open]) => {
    if (!open) return;
    await scrollToBottom();
    await nextTick();
    inputEl.value?.focus();
  },
);

function onSend() {
  const text = draft.value.trim();
  if (!text) return;
  if (isMember.value) sendFromAgent(text);
  else sendFromVisitor(text);
  draft.value = "";
  void scrollToBottom();
}

/** @param {KeyboardEvent} ev */
function onKey(ev) {
  if (ev.key === "Enter" && !ev.shiftKey) {
    ev.preventDefault();
    onSend();
  }
}

function onBackdrop(ev) {
  if (ev.target === ev.currentTarget) closeContact();
}
</script>

<template>
  <Teleport to="body">
    <div
      v-if="contactOpen"
      class="cs-backdrop"
      role="presentation"
      @click="onBackdrop"
    >
      <div
        class="cs-modal"
        role="dialog"
        aria-modal="true"
        :aria-label="isMember ? '本地客服收件箱' : '联系本地客服'"
        @click.stop
      >
        <aside class="cs-side">
          <div class="cs-side-head">
            <h2>私信</h2>
            <span class="cs-side-tag">本地</span>
          </div>
          <button type="button" class="cs-thread on">
            <span class="cs-avatar" aria-hidden="true">本</span>
            <span class="cs-thread-main">
              <span class="cs-thread-name">
                本地客服
                <span class="cs-badge">超管</span>
              </span>
              <span class="cs-thread-preview">{{ preview }}</span>
            </span>
            <span class="cs-thread-time">{{ formatMessageTime(lastTs).replace("今天 ", "") }}</span>
          </button>
        </aside>

        <section class="cs-chat">
          <header class="cs-chat-head">
            <span class="cs-avatar sm" aria-hidden="true">本</span>
            <div class="cs-chat-title">
              <strong>本地客服</strong>
              <span class="cs-badge">超管</span>
            </div>
            <button type="button" class="cs-close" aria-label="关闭" @click="closeContact">×</button>
          </header>

          <div ref="listEl" class="cs-msgs">
            <p v-if="!messages.length" class="cs-empty">还没有留言。发送后只会保存在本机。</p>
            <template v-for="(m, i) in messages" :key="m.id">
              <div
                v-if="i === 0 || formatMessageTime(m.ts) !== formatMessageTime(messages[i - 1].ts)"
                class="cs-time"
              >
                {{ formatMessageTime(m.ts) }}
              </div>
              <div class="cs-row" :class="m.role">
                <div class="cs-bubble">{{ m.text }}</div>
              </div>
            </template>
          </div>

          <form class="cs-composer" @submit.prevent="onSend">
            <input
              ref="inputEl"
              v-model="draft"
              type="text"
              class="cs-input"
              :placeholder="isMember ? '以本地客服回复…' : '发私信...'"
              maxlength="2000"
              autocomplete="off"
              @keydown="onKey"
            />
            <button type="submit" class="cs-send" :disabled="!draft.trim()" aria-label="发送">
              <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden="true">
                <path d="M3.5 11.5 21 4 13.5 21l-2.2-7.2L3.5 11.5Z" fill="currentColor" />
              </svg>
            </button>
          </form>
          <p class="cs-hint">
            {{ isMember ? "会员模式：可在此查看并回复本机留言。" : `当前档位 ${selectedPlan.name} ${selectedPlan.priceLabel} · 留言只保存在本机` }}
          </p>
        </section>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.cs-backdrop {
  position: fixed;
  inset: 0;
  z-index: 80;
  display: flex;
  align-items: stretch;
  justify-content: center;
  padding: 3.2rem 0.8rem 0.8rem;
  background: rgba(0, 0, 0, 0.55);
}
.cs-modal {
  display: flex;
  width: min(1100px, 100%);
  height: 100%;
  max-height: calc(100vh - 4rem);
  overflow: hidden;
  border-radius: 12px;
  border: 1px solid #2a2a2c;
  background: #121214;
  box-shadow: 0 24px 64px rgba(0, 0, 0, 0.55);
  color: #dbdee1;
}
.cs-side {
  width: 260px;
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: #0c0c0e;
  border-right: 1px solid #262628;
}
.cs-side-head {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.95rem 0.95rem 0.7rem;
}
.cs-side-head h2 {
  margin: 0;
  font-size: 1rem;
  color: #f2f3f5;
}
.cs-side-tag,
.cs-badge {
  display: inline-flex;
  align-items: center;
  border-radius: 999px;
  font-size: 0.65rem;
  font-weight: 700;
  line-height: 1;
}
.cs-side-tag {
  padding: 0.22rem 0.45rem;
  color: #e8c57a;
  border: 1px solid rgba(212, 175, 99, 0.45);
  background: rgba(212, 175, 99, 0.1);
}
.cs-badge {
  margin-left: 0.3rem;
  padding: 0.16rem 0.38rem;
  color: #f3d394;
  background: linear-gradient(180deg, #6a5424, #3d3114);
  border: 1px solid rgba(232, 197, 122, 0.45);
}
.cs-thread {
  display: flex;
  align-items: flex-start;
  gap: 0.55rem;
  margin: 0 0.55rem;
  padding: 0.65rem 0.55rem;
  border: 1px solid transparent;
  border-radius: 10px;
  background: transparent;
  color: inherit;
  text-align: left;
  cursor: default;
}
.cs-thread.on {
  background: #1a1610;
  border-color: rgba(212, 175, 99, 0.28);
}
.cs-avatar {
  flex-shrink: 0;
  width: 36px;
  height: 36px;
  border-radius: 50%;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  font-size: 0.78rem;
  font-weight: 800;
  color: #3a2a10;
  background: linear-gradient(180deg, #f3d394, #c9953d);
}
.cs-avatar.sm {
  width: 28px;
  height: 28px;
  font-size: 0.68rem;
}
.cs-thread-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
}
.cs-thread-name {
  display: flex;
  align-items: center;
  font-size: 0.82rem;
  font-weight: 700;
  color: #f2f3f5;
}
.cs-thread-preview {
  font-size: 0.72rem;
  color: #949ba4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.cs-thread-time {
  flex-shrink: 0;
  font-size: 0.68rem;
  color: #6d7178;
}
.cs-chat {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: #161618;
}
.cs-chat-head {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  padding: 0.7rem 0.9rem;
  border-bottom: 1px solid #262628;
  flex-shrink: 0;
}
.cs-chat-title {
  display: flex;
  align-items: center;
  flex: 1;
  min-width: 0;
}
.cs-chat-title strong {
  font-size: 0.92rem;
  color: #f2f3f5;
}
.cs-close {
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: #b5bac1;
  font-size: 1.35rem;
  line-height: 1;
  cursor: pointer;
}
.cs-close:hover {
  background: #2b2d31;
  color: #fff;
}
.cs-msgs {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 1.1rem 1.2rem 0.6rem;
}
.cs-empty {
  margin: 3rem 0 0;
  text-align: center;
  color: #6d7178;
  font-size: 0.85rem;
}
.cs-time {
  text-align: center;
  color: #6d7178;
  font-size: 0.72rem;
  margin: 0.4rem 0 0.7rem;
}
.cs-row {
  display: flex;
  margin: 0 0 0.65rem;
}
.cs-row.user {
  justify-content: flex-end;
}
.cs-row.agent {
  justify-content: flex-start;
}
.cs-bubble {
  max-width: min(72%, 36rem);
  padding: 0.55rem 0.8rem;
  border-radius: 12px;
  font-size: 0.88rem;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
}
.cs-row.user .cs-bubble {
  background: #3ba55d;
  color: #fff;
  border-bottom-right-radius: 4px;
}
.cs-row.agent .cs-bubble {
  background: #2b2d31;
  color: #dbdee1;
  border-bottom-left-radius: 4px;
}
.cs-composer {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  margin: 0 0.85rem;
  padding: 0.35rem 0.45rem 0.35rem 0.85rem;
  border: 1px solid #3a3428;
  border-radius: 12px;
  background: #0e0e10;
}
.cs-input {
  flex: 1;
  min-width: 0;
  border: none;
  outline: none;
  background: transparent;
  color: #f2f3f5;
  font-size: 0.88rem;
  padding: 0.45rem 0;
}
.cs-input::placeholder {
  color: #6d7178;
}
.cs-send {
  width: 38px;
  height: 34px;
  border: none;
  border-radius: 9px;
  background: transparent;
  color: #c9c4b8;
  cursor: pointer;
  display: inline-flex;
  align-items: center;
  justify-content: center;
}
.cs-send:hover:not(:disabled) {
  color: #f3d394;
}
.cs-send:disabled {
  opacity: 0.35;
  cursor: default;
}
.cs-hint {
  margin: 0.35rem 1rem 0.55rem;
  font-size: 0.68rem;
  color: #6d7178;
}
@media (max-width: 720px) {
  .cs-side {
    display: none;
  }
  .cs-backdrop {
    padding: 3.2rem 0 0;
  }
  .cs-modal {
    border-radius: 12px 12px 0 0;
  }
}
</style>
