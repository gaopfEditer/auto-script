<script setup>
import { computed, onMounted, onUnmounted, watch } from "vue";
import { useOnboardingGuide } from "../composables/useOnboardingGuide.js";

const { steps, step, isFirst, isLast, next, prev, skip, goTo, refreshRect, state } = useOnboardingGuide();

const progress = computed(() => {
  const total = steps.value.length || 1;
  return `${state.stepIndex + 1} / ${total}`;
});

const hasHighlight = computed(() => Boolean(state.rect));

let resizeObserver = null;

function onResize() {
  if (state.open) void refreshRect();
}

watch(
  () => state.open,
  (open) => {
    if (open) void refreshRect();
  }
);

watch(
  () => state.stepIndex,
  () => {
    if (!state.open) return;
    void refreshRect();
    // OI iframe 切路径后可能晚一点才可测
    if (step.value?.iframeTarget) {
      window.setTimeout(() => {
        if (state.open) void refreshRect();
      }, 700);
    }
  }
);

onMounted(() => {
  window.addEventListener("resize", onResize);
  window.addEventListener("scroll", onResize, true);
});

onUnmounted(() => {
  window.removeEventListener("resize", onResize);
  window.removeEventListener("scroll", onResize, true);
  resizeObserver?.disconnect();
});
</script>

<template>
  <Teleport to="body">
    <div v-if="state.open" class="onboard-root" role="dialog" aria-modal="true" aria-label="新手操作指引">
      <div class="onboard-backdrop" @click="skip" />

      <div
        v-if="hasHighlight"
        class="onboard-spot"
        :style="{
          top: `${state.rect.top}px`,
          left: `${state.rect.left}px`,
          width: `${state.rect.width}px`,
          height: `${state.rect.height}px`,
        }"
      />

      <div class="onboard-card" :class="{ center: !hasHighlight }">
        <header class="onboard-hd">
          <span class="onboard-progress">{{ progress }}</span>
          <h2>{{ step?.title }}</h2>
        </header>
        <ul class="onboard-lines">
          <li v-for="(line, i) in step?.lines ?? []" :key="i">{{ line }}</li>
        </ul>
        <footer class="onboard-ft">
          <button type="button" class="onboard-skip" @click="skip">跳过</button>
          <div class="onboard-nav">
            <button type="button" class="onboard-btn" :disabled="isFirst" @click="prev">上一步</button>
            <button type="button" class="onboard-btn primary" @click="next">
              {{ isLast ? "完成" : "下一步" }}
            </button>
          </div>
        </footer>
        <div class="onboard-dots">
          <button
            v-for="(s, i) in steps"
            :key="s.id"
            type="button"
            class="onboard-dot"
            :class="{ on: i === state.stepIndex }"
            :title="s.title"
            @click="goTo(i)"
          />
        </div>
      </div>
    </div>
  </Teleport>
</template>

<style scoped>
.onboard-root {
  position: fixed;
  inset: 0;
  z-index: 10050;
  pointer-events: none;
}
.onboard-backdrop {
  position: absolute;
  inset: 0;
  background: rgba(0, 0, 0, 0.62);
  pointer-events: auto;
}
.onboard-spot {
  position: fixed;
  border: 2px solid #5865f2;
  border-radius: 10px;
  box-shadow:
    0 0 0 9999px rgba(0, 0, 0, 0.62),
    0 0 24px rgba(88, 101, 242, 0.45);
  pointer-events: none;
  z-index: 1;
  transition:
    top 0.2s ease,
    left 0.2s ease,
    width 0.2s ease,
    height 0.2s ease;
}
.onboard-card {
  position: fixed;
  z-index: 2;
  left: 50%;
  bottom: 1.25rem;
  transform: translateX(-50%);
  width: min(520px, calc(100vw - 2rem));
  background: #1e1f22;
  border: 1px solid #3f4147;
  border-radius: 12px;
  padding: 1rem 1.1rem 0.85rem;
  color: #e8eaed;
  pointer-events: auto;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
}
.onboard-card.center {
  top: 50%;
  bottom: auto;
  transform: translate(-50%, -50%);
}
.onboard-hd {
  margin-bottom: 0.65rem;
}
.onboard-progress {
  font-size: 0.72rem;
  color: #949ba4;
}
.onboard-hd h2 {
  margin: 0.25rem 0 0;
  font-size: 1.05rem;
  font-weight: 650;
  color: #f2f3f5;
}
.onboard-lines {
  margin: 0 0 0.85rem;
  padding-left: 1.1rem;
  font-size: 0.86rem;
  line-height: 1.55;
  color: #c4c9ce;
}
.onboard-lines li + li {
  margin-top: 0.35rem;
}
.onboard-ft {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.onboard-skip {
  background: none;
  border: none;
  color: #949ba4;
  font-size: 0.8rem;
  cursor: pointer;
  padding: 0.35rem 0.25rem;
}
.onboard-skip:hover {
  color: #dbdee1;
}
.onboard-nav {
  display: flex;
  gap: 0.5rem;
}
.onboard-btn {
  border: 1px solid #4e5058;
  background: #2b2d31;
  color: #e8eaed;
  border-radius: 6px;
  padding: 0.4rem 0.85rem;
  font-size: 0.82rem;
  cursor: pointer;
}
.onboard-btn:disabled {
  opacity: 0.4;
  cursor: not-allowed;
}
.onboard-btn.primary {
  background: #5865f2;
  border-color: #5865f2;
  color: #fff;
}
.onboard-btn.primary:hover:not(:disabled) {
  filter: brightness(1.08);
}
.onboard-dots {
  display: flex;
  justify-content: center;
  gap: 0.35rem;
  margin-top: 0.75rem;
}
.onboard-dot {
  width: 7px;
  height: 7px;
  border-radius: 50%;
  border: none;
  background: #4e5058;
  padding: 0;
  cursor: pointer;
}
.onboard-dot.on {
  background: #5865f2;
  transform: scale(1.15);
}
</style>
