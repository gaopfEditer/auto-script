<script setup>
import TelegramEvalColoredMetrics from "./TelegramEvalColoredMetrics.vue";

const EVAL_WINDOWS = [
  { key: "month", label: "近一个月" },
  { key: "week", label: "七天" },
  { key: "all", label: "总计" },
];

const props = defineProps({
  chatId: { type: String, required: true },
  /** header | floating | modal（弹窗内） */
  variant: { type: String, default: "header" },
  sticky: { type: Boolean, default: false },
  /** @type {(key: import("../lib/telegramGroupEvalApi.js").TgEvalWindowKey) => object | null} */
  metricsFor: { type: Function, required: true },
});

const emit = defineEmits(["open-detail", "toggle-sticky"]);

/** @param {import("../lib/telegramGroupEvalApi.js").TgEvalWindowKey} key */
function openDetail(key) {
  emit("open-detail", key);
}

</script>

<template>
  <div
    class="col-eval"
    :class="{
      'col-eval-floating': variant === 'floating',
      'col-eval-inline': variant === 'header',
      'col-eval-modal': variant === 'modal',
    }"
    aria-label="信号卡周期统计"
  >
    <div v-if="variant === 'header' || variant === 'modal'" class="col-eval-head">
      <p class="col-eval-hint">
        {{ variant === "modal" ? "信号卡统计 · MySQL 已决议单" : "信号卡 · MySQL 已决议单" }}
      </p>
      <label
        v-if="variant === 'header'"
        class="eval-sticky-toggle"
        title="滚动消息时统计条贴在顶部"
      >
        <input type="checkbox" :checked="sticky" @change="emit('toggle-sticky')" />
        <span>滚动时悬浮</span>
      </label>
    </div>
    <p v-else-if="variant === 'floating'" class="col-eval-hint">信号卡统计</p>

    <div class="eval-stat-row">
      <button
        v-for="w in EVAL_WINDOWS"
        :key="chatId + '-' + variant + '-' + w.key"
        type="button"
        class="eval-stat-card"
        :title="`查看 ${w.label} 单子详情`"
        @click="openDetail(w.key)"
      >
        <span class="eval-stat-period">{{ w.label }}</span>
        <dl class="eval-stat-metrics">
          <div class="eval-stat-line">
            <dt>盈亏</dt>
            <dd><TelegramEvalColoredMetrics :metrics="metricsFor(w.key)" kind="winloss" /></dd>
          </div>
          <div class="eval-stat-line">
            <dt>胜率</dt>
            <dd><TelegramEvalColoredMetrics :metrics="metricsFor(w.key)" kind="winrate" /></dd>
          </div>
          <div class="eval-stat-line eval-stat-line-pnl">
            <dt>盈利率</dt>
            <dd><TelegramEvalColoredMetrics :metrics="metricsFor(w.key)" kind="pnl" /></dd>
          </div>
        </dl>
        <span class="eval-stat-action">查看单子</span>
      </button>
    </div>
  </div>
</template>

<style scoped>
.col-eval {
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.col-eval-inline {
  margin-top: 0.15rem;
}
.col-eval-modal {
  padding-bottom: 0.25rem;
}
.col-eval-modal .eval-stat-row {
  display: grid;
  grid-template-columns: repeat(3, minmax(0, 1fr));
  overflow: visible;
}
.col-eval-modal .eval-stat-card {
  flex: auto;
  min-width: 0;
}
@media (max-width: 640px) {
  .col-eval-modal .eval-stat-row {
    grid-template-columns: 1fr;
  }
}
.col-eval-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.35rem 0.65rem;
}
.col-eval-hint {
  margin: 0;
  font-size: 0.65rem;
  color: #848990;
  letter-spacing: 0.02em;
}
.eval-sticky-toggle {
  display: inline-flex;
  align-items: center;
  gap: 0.3rem;
  font-size: 0.62rem;
  color: #949ba4;
  cursor: pointer;
  user-select: none;
  white-space: nowrap;
}
.eval-sticky-toggle input {
  accent-color: #5865f2;
  cursor: pointer;
}
.col-eval-floating {
  position: sticky;
  top: 0;
  z-index: 4;
  margin: -0.55rem -0.65rem 0.55rem;
  padding: 0.55rem 0.65rem 0.6rem;
  background: #232428;
  border-bottom: 1px solid #383a40;
  box-shadow: 0 8px 20px rgba(0, 0, 0, 0.32);
}
.eval-stat-row {
  display: flex;
  gap: 0.45rem;
  overflow-x: auto;
  padding-bottom: 0.1rem;
  scroll-snap-type: x proximity;
  -webkit-overflow-scrolling: touch;
}
.eval-stat-row::-webkit-scrollbar {
  height: 4px;
}
.eval-stat-row::-webkit-scrollbar-thumb {
  background: #4e5058;
  border-radius: 4px;
}
.eval-stat-card {
  flex: 0 0 min(100%, 9.25rem);
  scroll-snap-align: start;
  display: flex;
  flex-direction: column;
  align-items: stretch;
  gap: 0.35rem;
  margin: 0;
  text-align: left;
  border: 1px solid #404249;
  border-radius: 10px;
  padding: 0.5rem 0.55rem 0.45rem;
  background: linear-gradient(165deg, #2a2c31 0%, #1e1f22 100%);
  color: #dbdee1;
  cursor: pointer;
  transition:
    border-color 0.15s ease,
    background 0.15s ease,
    transform 0.12s ease;
}
.eval-stat-card:hover {
  border-color: #5865f2;
  background: linear-gradient(165deg, #2f3340 0%, #22242a 100%);
  transform: translateY(-1px);
}
.eval-stat-period {
  font-size: 0.7rem;
  font-weight: 600;
  color: #e8eaed;
}
.eval-stat-metrics {
  margin: 0;
  display: flex;
  flex-direction: column;
  gap: 0.22rem;
}
.eval-stat-line {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem;
  font-size: 0.68rem;
}
.eval-stat-line dt {
  margin: 0;
  color: #848990;
  font-weight: 400;
}
.eval-stat-line dd {
  margin: 0;
  color: #c9cdd2;
  font-weight: 500;
  text-align: right;
}
.eval-stat-line-pnl dd {
  font-weight: 700;
  font-size: 0.74rem;
}
.eval-stat-action {
  margin-top: 0.1rem;
  font-size: 0.62rem;
  color: #5865f2;
  font-weight: 600;
}
</style>
