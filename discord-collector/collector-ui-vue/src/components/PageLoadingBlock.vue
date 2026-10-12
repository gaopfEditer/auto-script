<script setup>
defineProps({
  message: { type: String, default: "加载中…" },
  hint: { type: String, default: "" },
  /** 铺满父容器（需父级 position:relative） */
  overlay: { type: Boolean, default: true },
});
</script>

<template>
  <div
    class="page-loading-block"
    :class="{ 'page-loading-block--overlay': overlay, 'page-loading-block--inline': !overlay }"
    role="status"
    aria-live="polite"
  >
    <div class="page-loading-block-spinner" aria-hidden="true" />
    <p class="page-loading-block-msg">{{ message }}</p>
    <p v-if="hint" class="page-loading-block-hint">{{ hint }}</p>
  </div>
</template>

<style scoped>
.page-loading-block {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 0.65rem;
  padding: 2rem 1.5rem;
  text-align: center;
}
.page-loading-block--overlay {
  position: absolute;
  inset: 0;
  z-index: 20;
  background: rgba(30, 31, 34, 0.88);
  backdrop-filter: blur(4px);
  border-radius: inherit;
  min-height: 12rem;
}
.page-loading-block--inline {
  min-height: 8rem;
}
.page-loading-block-spinner {
  width: 36px;
  height: 36px;
  border-radius: 50%;
  border: 3px solid rgba(88, 101, 242, 0.25);
  border-top-color: #5865f2;
  animation: page-loading-spin 0.75s linear infinite;
}
.page-loading-block-msg {
  margin: 0;
  font-size: 0.9rem;
  font-weight: 600;
  color: #e8eaed;
}
.page-loading-block-hint {
  margin: 0;
  max-width: 22rem;
  font-size: 0.78rem;
  line-height: 1.45;
  color: #949ba4;
}
@keyframes page-loading-spin {
  to {
    transform: rotate(360deg);
  }
}
</style>
