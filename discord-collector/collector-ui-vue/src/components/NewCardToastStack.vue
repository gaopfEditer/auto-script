<script setup>
import { useRouter } from "vue-router";
import { useCollectorSocket } from "../composables/useCollectorSocket.js";
import {
  handleNewCardSocketMessage,
  useNewCardNotifications,
} from "../composables/useNewCardNotifications.js";

const router = useRouter();
const { toasts, dismissCardToast } = useNewCardNotifications();

useCollectorSocket(handleNewCardSocketMessage);

/** @param {import("../composables/useNewCardNotifications.js").CardToast} toast */
function viewCard(toast) {
  dismissCardToast(toast.key);
  void router.push({ path: "/cards", query: { open: String(toast.cardId) } });
}
</script>

<template>
  <Teleport to="body">
    <div v-if="toasts.length" class="toast-stack" aria-live="polite">
      <article v-for="toast in toasts" :key="toast.key" class="toast-card">
        <header class="toast-head">
          <span class="toast-label">新卡片</span>
          <span v-if="toast.channelName" class="toast-channel">{{ toast.channelName }}</span>
          <button type="button" class="toast-close" aria-label="关闭" @click="dismissCardToast(toast.key)">
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
          <button type="button" class="toast-btn" @click="dismissCardToast(toast.key)">关闭</button>
        </div>
      </article>
    </div>
  </Teleport>
</template>

<style scoped>
.toast-stack {
  position: fixed;
  right: 1rem;
  bottom: 1rem;
  z-index: 1200;
  display: flex;
  flex-direction: column-reverse;
  gap: 0.65rem;
  max-width: min(360px, calc(100vw - 2rem));
  pointer-events: none;
}
.toast-card {
  pointer-events: auto;
  background: #2b2d31;
  border: 1px solid #5865f2;
  border-radius: 10px;
  box-shadow: 0 8px 28px rgba(0, 0, 0, 0.45);
  padding: 0.65rem 0.75rem 0.7rem;
  animation: toast-in 0.25s ease-out;
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
