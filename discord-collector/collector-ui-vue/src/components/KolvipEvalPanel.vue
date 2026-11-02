<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import { fetchKolvipEvalSummary } from "../lib/kolvipApi.js";

const props = defineProps({
  activeChannelId: { type: String, default: "" },
});

const loading = ref(false);
const error = ref("");
/** @type {import('../lib/kolvipApi.js').KolvipEvalChannelRow[]} */
const channels = ref([]);
const note = ref("");
const days = ref(7);

/** @type {ReturnType<typeof setInterval> | null} */
let refreshTimer = null;

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const j = await fetchKolvipEvalSummary({ days: days.value });
    channels.value = j.channels;
    note.value = j.note;
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

/** @param {import('../lib/kolvipApi.js').KolvipEvalChannelRow} row */
function statusLabel(row) {
  if (row.displayState === "win_rate" && row.metrics?.winRate != null) {
    return `${row.metrics.winRate}%`;
  }
  if (row.displayState === "insufficient_sample") return "样本不足";
  return "抓取中";
}

/** @param {import('../lib/kolvipApi.js').KolvipEvalChannelRow} row */
function subline(row) {
  const m = row.metrics || {};
  const parts = [];
  if (row.pushedCount) parts.push(`卡 ${row.pushedCount}`);
  if (m.winCount || m.lossCount) parts.push(`胜${m.winCount || 0}/负${m.lossCount || 0}`);
  if (m.pendingCount) parts.push(`待${m.pendingCount}`);
  return parts.join(" · ") || "—";
}

const sorted = computed(() =>
  [...channels.value].sort((a, b) => String(a.logicName).localeCompare(String(b.logicName), "zh"))
);

watch(
  () => props.activeChannelId,
  () => {
    /* 高亮由 class 绑定，无需重拉 */
  }
);

onMounted(() => {
  void load();
  refreshTimer = setInterval(() => void load(), 60_000);
});

onUnmounted(() => {
  if (refreshTimer) clearInterval(refreshTimer);
});
</script>

<template>
  <aside class="kolvip-eval-panel" aria-label="巨鲸 kolvip 胜率">
    <header class="kolvip-eval-head">
      <span class="kolvip-eval-title">kolvip</span>
      <span class="kolvip-eval-range">近 {{ days }} 天</span>
    </header>
    <p v-if="error" class="kolvip-eval-err">{{ error }}</p>
    <p v-else-if="loading && !channels.length" class="kolvip-eval-muted">加载中…</p>
    <ul v-else class="kolvip-eval-list">
      <li
        v-for="row in sorted"
        :key="row.kolvipChannelId"
        class="kolvip-eval-row"
        :class="{ active: row.discordChannelId === activeChannelId }"
      >
        <div class="kolvip-eval-row-top">
          <span class="kolvip-eval-name">{{ row.logicName }}</span>
          <span
            class="kolvip-eval-rate"
            :class="{
              ok: row.displayState === 'win_rate',
              warn: row.displayState === 'insufficient_sample',
              muted: row.displayState === 'fetching',
            }"
          >
            {{ statusLabel(row) }}
          </span>
        </div>
        <div class="kolvip-eval-sub">{{ subline(row) }}</div>
      </li>
    </ul>
    <p v-if="note" class="kolvip-eval-note">{{ note }}</p>
  </aside>
</template>

<style scoped>
.kolvip-eval-panel {
  background: var(--bg3, #1e1f22);
  border-left: 1px solid #000;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  font-size: 0.72rem;
  color: var(--text, #dbdee1);
}
.kolvip-eval-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  padding: 0.55rem 0.65rem;
  border-bottom: 1px solid rgba(0, 0, 0, 0.35);
  flex-shrink: 0;
}
.kolvip-eval-title {
  font-weight: 800;
  letter-spacing: 0.04em;
  text-transform: lowercase;
  color: #e8eaed;
}
.kolvip-eval-range {
  color: var(--muted, #949ba4);
  font-size: 0.62rem;
}
.kolvip-eval-list {
  list-style: none;
  margin: 0;
  padding: 0.35rem 0;
  overflow-y: auto;
  flex: 1;
  min-height: 0;
}
.kolvip-eval-row {
  padding: 0.35rem 0.65rem;
  border-left: 3px solid transparent;
}
.kolvip-eval-row.active {
  background: rgba(88, 101, 242, 0.12);
  border-left-color: #5865f2;
}
.kolvip-eval-row-top {
  display: flex;
  justify-content: space-between;
  gap: 0.35rem;
  align-items: center;
}
.kolvip-eval-name {
  font-weight: 600;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kolvip-eval-rate {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
.kolvip-eval-rate.ok {
  color: #49e57a;
}
.kolvip-eval-rate.warn {
  color: #faa61a;
}
.kolvip-eval-rate.muted {
  color: var(--muted, #949ba4);
  font-weight: 500;
}
.kolvip-eval-sub {
  margin-top: 0.12rem;
  color: var(--muted, #949ba4);
  font-size: 0.62rem;
}
.kolvip-eval-note,
.kolvip-eval-muted,
.kolvip-eval-err {
  margin: 0;
  padding: 0.35rem 0.65rem 0.5rem;
  font-size: 0.58rem;
  color: var(--muted, #949ba4);
  line-height: 1.35;
  flex-shrink: 0;
}
.kolvip-eval-err {
  color: #f23f43;
}
</style>
