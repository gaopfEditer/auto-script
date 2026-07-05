<script setup>
import { computed, ref, watch } from "vue";
import { useRouter } from "vue-router";
import { useCollectorSocket } from "../composables/useCollectorSocket.js";
import {
  handleNewCardSocketMessage,
  useNewCardNotifications,
} from "../composables/useNewCardNotifications.js";

const router = useRouter();
const { toasts, dismissCardToast, dismissAllCardToasts } = useNewCardNotifications();

const expanded = ref(false);

useCollectorSocket(handleNewCardSocketMessage);

const stackCount = computed(() => toasts.value.length);
const isStacked = computed(() => stackCount.value > 1 && !expanded.value);
const visibleToasts = computed(() =>
  expanded.value || stackCount.value <= 1 ? toasts.value : toasts.value.slice(0, 1)
);
const hiddenCount = computed(() => Math.max(0, stackCount.value - 1));

watch(stackCount, (count, prev) => {
  if (count > prev) expanded.value = false;
  if (count <= 1) expanded.value = false;
});

/** @param {import("../composables/useNewCardNotifications.js").CardToast} toast */
function viewCard(toast) {
  dismissCardToast(toast.key);
  void router.push({ path: "/cards", query: { open: String(toast.cardId) } });
}

function closeAll() {
  dismissAllCardToasts();
  expanded.value = false;
}

/** @param {string} key */
function closeOne(key) {
  dismissCardToast(key);
  if (toasts.value.length <= 1) expanded.value = false;
}
</script>

<template>
  <Teleport to="body">
    <div v-if="stackCount" class="toast-stack-wrap" aria-live="polite">
      <header class="stack-toolbar">
        <span class="stack-count">{{ stackCount }} 张新卡片</span>
        <div class="stack-toolbar-actions">
          <button
            v-if="stackCount > 1"
            type="button"
            class="stack-tool-btn"
            @click="expanded = !expanded"
          >
            {{ expanded ? "收起" : `展开 (${stackCount})` }}
          </button>
          <button type="button" class="stack-tool-btn danger" @click="closeAll">全部关闭</button>
        </div>
      </header>

      <div class="toast-stack" :class="{ stacked: isStacked, expanded }">
        <div v-if="isStacked" class="stack-layers" aria-hidden="true">
          <div class="stack-layer layer-2" />
          <div class="stack-layer layer-1" />
          <span v-if="hiddenCount" class="stack-badge">+{{ hiddenCount }}</span>
        </div>

        <article
          v-for="toast in visibleToasts"
          :key="toast.key"
          class="toast-card"
          :class="{ 'stack-top': isStacked }"
        >
          <header class="toast-head">
            <span class="toast-label">新卡片</span>
            <span v-if="toast.channelName" class="toast-channel">{{ toast.channelName }}</span>
            <button type="button" class="toast-close" aria-label="关闭" @click="closeOne(toast.key)">
              ×
            </button>
          </header>
          <div class="toast-title">
            <strong>{{ toast.title }}</strong>
            <span v-if="toast.direction" class="toast-dir">{{ toast.direction }}</span>
          </div>
          <p v-if="toast.preview" class="toast-preview">{{ toast.preview }}</p>
          <div class="toast-actions">
            <button type="button" class="toast-btn primary" @click="viewCard(toast)">查看卡片</button>
            <button type="button" class="toast-btn" @click="closeOne(toast.key)">关闭</button>
          </div>
        </article>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-stack-wrap {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  z-index: 1200;
  max-width: min(360px, calc(100vw - 2rem));
  pointer-events: none;
}
.stack-toolbar {
  pointer-events: auto;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.45rem;
  padding: 0.35rem 0.5rem;
  background: rgba(30, 31, 34, 0.92);
  border: 1px solid #3f4147;
  border-radius: 8px;
  backdrop-filter: blur(8px);
}
.stack-count {
  font-size: 0.75rem;
  font-weight: 700;
  color: #57f287;
  white-space: nowrap;
}
.stack-toolbar-actions {
  display: flex;
  gap: 0.35rem;
  flex-shrink: 0;
}
.stack-tool-btn {
  border: 1px solid #3f4147;
  background: #35373c;
  color: #dbdee1;
  font-size: 0.68rem;
  font-weight: 600;
  padding: 0.2rem 0.45rem;
  border-radius: 5px;
  cursor: pointer;
}
.stack-tool-btn:hover {
  background: #404249;
}
.stack-tool-btn.danger:hover {
  border-color: #ed4245;
  background: rgba(237, 66, 69, 0.18);
  color: #f38688;
}
.toast-stack {
  position: relative;
  display: flex;
  flex-direction: column-reverse;
  gap: 0.55rem;
  max-height: min(70vh, 640px);
  overflow-y: auto;
  overflow-x: hidden;
  padding-top: 0.15rem;
}
.toast-stack.stacked {
  overflow: visible;
  max-height: none;
  padding-top: 0.55rem;
  padding-right: 0.35rem;
}
.stack-layers {
  position: absolute;
  inset: 0.55rem 0.35rem auto 0;
  height: calc(100% - 0.55rem);
  pointer-events: none;
  z-index: 0;
}
.stack-layer {
  position: absolute;
  left: 0;
  right: 0;
  height: 100%;
  border-radius: 10px;
  border: 1px solid #3f4147;
  background: #25262a;
}
.stack-layer.layer-1 {
  top: -6px;
  transform: scale(0.97);
  opacity: 0.85;
}
.stack-layer.layer-2 {
  top: -12px;
  transform: scale(0.94);
  opacity: 0.55;
}
.stack-badge {
  position: absolute;
  top: -10px;
  right: -4px;
  z-index: 2;
  min-width: 1.4rem;
  padding: 0.1rem 0.35rem;
  border-radius: 999px;
  background: #5865f2;
  color: #fff;
  font-size: 0.65rem;
  font-weight: 700;
  text-align: center;
  box-shadow: 0 2px 8px rgba(0, 0, 0, 0.35);
}
.toast-card {
  position: relative;
  z-index: 1;
  pointer-events: auto;
  background: #2b2d31;
  border: 1px solid #5865f2;
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  padding: 0.65rem 0.75rem 0.7rem;
  animation: toast-in 0.25s ease-out;
}
.toast-card.stack-top {
  z-index: 3;
}
@keyframes toast-in {
  from {
    opacity: 0;
    transform: translateY(12px);
  }
  to {
    opacity: 1;
    transform: translateY(0);
  }
}
.toast-head {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.35rem;
}
.toast-label {
  font-size: 0.72rem;
  font-weight: 700;
  color: #57f287;
  text-transform: uppercase;
  letter-spacing: 0.02em;
}
.toast-channel {
  flex: 1;
  min-width: 0;
  font-size: 0.72rem;
  color: #aeb4ff;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.toast-close {
  margin-left: auto;
  border: none;
  background: #35373c;
  color: #dbdee1;
  width: 1.4rem;
  height: 1.4rem;
  border-radius: 5px;
  font-size: 1rem;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}
.toast-close:hover {
  background: #5865f2;
  color: #fff;
}
.toast-title {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  margin-bottom: 0.25rem;
}
.toast-title strong {
  font-size: 1rem;
  color: #f2f3f5;
}
.toast-dir {
  font-size: 0.75rem;
  color: #aeb4ff;
}
.toast-preview {
  margin: 0 0 0.55rem;
  font-size: 0.78rem;
  line-height: 1.45;
  color: #b5bac1;
  white-space: pre-wrap;
  word-break: break-word;
  max-height: 4.5em;
  overflow: hidden;
}
.toast-actions {
  display: flex;
  gap: 0.4rem;
}
.toast-btn {
  border: 1px solid #3f4147;
  background: #35373c;
  color: #dbdee1;
  font-size: 0.72rem;
  font-weight: 600;
  padding: 0.28rem 0.55rem;
  border-radius: 5px;
  cursor: pointer;
}
.toast-btn:hover {
  background: #404249;
}
.toast-btn.primary {
  background: #5865f2;
  border-color: #5865f2;
  color: #fff;
}
.toast-btn.primary:hover {
  filter: brightness(1.08);
}
</style>
