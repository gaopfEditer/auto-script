<script setup>
import { ref, onMounted, onUnmounted } from "vue";
import { RouterLink } from "vue-router";
import { fetchKolvipCdpOverview } from "../lib/kolvipCdpApi.js";
import { subscribeCollectorSocket } from "../composables/useCollectorSocket.js";

const loading = ref(false);
const error = ref("");
/** @type {import("vue").Ref<Record<string, unknown> | null>} */
const overview = ref(null);

/** @param {number|null|undefined} v */
function fmtWinRate(v) {
  if (v == null || Number.isNaN(Number(v))) return "—";
  return `${Number(v).toFixed(1)}%`;
}

/** @param {string} status */
function statusLabel(status) {
  const map = {
    ok: "样本可用",
    insufficient_sample: "样本不足",
    backfill_running: "回溯中",
    backfill_pending: "待抓取",
    backfill_failed: "回溯失败",
    live_running: "实时抓取",
    live_failed: "抓取失败",
    offline: "离线",
  };
  return map[status] || status || "—";
}

async function reload() {
  loading.value = true;
  error.value = "";
  try {
    overview.value = await fetchKolvipCdpOverview(30);
  } catch (e) {
    error.value = /** @type {Error} */ (e).message;
  } finally {
    loading.value = false;
  }
}

/** @param {Record<string, unknown>} msg */
function onSocketMsg(msg) {
  if (msg?.channel === "meta" && msg?.kind === "kolvip_cdp_run") void reload();
}

let pollTimer = /** @type {ReturnType<typeof setInterval> | null} */ (null);
/** @type {(() => void) | null} */
let unsubWs = null;

onMounted(() => {
  void reload();
  pollTimer = setInterval(() => void reload(), 20_000);
  unsubWs = subscribeCollectorSocket(onSocketMsg);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
  unsubWs?.();
});
</script>

<template>
  <aside class="kolvip-stats-rail" data-onboard="kolvip-stats">
    <header class="kolvip-stats-head">
      <h3>巨鲸 kolvip</h3>
      <span class="kolvip-stats-sub">近 30 天 · 与 /eval 同口径</span>
      <RouterLink class="kolvip-stats-link" to="/eval">评估详情</RouterLink>
    </header>

    <p v-if="error" class="kolvip-stats-error">{{ error }}</p>
    <p v-else-if="loading && !overview" class="kolvip-stats-muted">加载中…</p>

    <div v-if="overview" class="kolvip-stats-scroll">
      <div
        v-if="overview.backfill && typeof overview.backfill === 'object'"
        class="kolvip-backfill-bar"
      >
        <span>回溯 {{ overview.backfill.phaseDone ?? 0 }}/{{ overview.backfill.phaseTotal ?? "?" }}</span>
        <span class="kolvip-stats-tag">{{ statusLabel(String(overview.backfill.status ?? "")) }}</span>
      </div>

      <ul class="kolvip-channel-list">
        <li
          v-for="ch in overview.eval?.channels || []"
          :key="ch.kolvipChannelId"
          class="kolvip-channel-row"
        >
          <div class="kolvip-channel-title">
            <span class="name">{{ ch.logicName }}</span>
            <span class="ch-id">ch={{ ch.kolvipChannelId }}</span>
          </div>
          <div class="kolvip-channel-metrics">
            <span>胜率 {{ fmtWinRate(ch.metrics?.winRate) }}</span>
            <span>已入场 {{ ch.metrics?.cardCount ?? 0 }}</span>
            <span>W/L {{ ch.metrics?.winCount ?? 0 }}/{{ ch.metrics?.lossCount ?? 0 }}</span>
          </div>
          <div class="kolvip-channel-status">
            <span class="kolvip-stats-tag" :class="'st-' + (ch.uiStatus || ch.sampleStatus)">
              {{ statusLabel(ch.uiStatus || ch.sampleStatus) }}
            </span>
            <span v-if="ch.live?.error" class="kolvip-live-err">{{ ch.live.error }}</span>
          </div>
        </li>
      </ul>

      <p class="kolvip-stats-note">{{ overview.eval?.note }}</p>
    </div>
  </aside>
</template>

<style scoped>
.kolvip-stats-rail {
  background: #232428;
  border-left: 1px solid #1a1b1e;
  display: flex;
  flex-direction: column;
  min-height: 0;
  color: #e8eaed;
  font-size: 12px;
}
.kolvip-stats-head {
  padding: 10px 12px;
  border-bottom: 1px solid #1a1b1e;
}
.kolvip-stats-head h3 {
  margin: 0;
  font-size: 13px;
  font-weight: 600;
}
.kolvip-stats-sub {
  display: block;
  color: #9aa0a6;
  margin-top: 4px;
  font-size: 11px;
}
.kolvip-stats-link {
  display: inline-block;
  margin-top: 6px;
  color: #8ab4f8;
  text-decoration: none;
  font-size: 11px;
}
.kolvip-stats-scroll {
  overflow-y: auto;
  padding: 8px 10px 12px;
  flex: 1;
}
.kolvip-backfill-bar {
  display: flex;
  justify-content: space-between;
  align-items: center;
  padding: 6px 8px;
  margin-bottom: 8px;
  background: #2b2d31;
  border-radius: 6px;
  color: #bdc1c6;
}
.kolvip-channel-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.kolvip-channel-row {
  padding: 8px;
  background: #2b2d31;
  border-radius: 6px;
}
.kolvip-channel-title {
  display: flex;
  justify-content: space-between;
  margin-bottom: 4px;
}
.kolvip-channel-title .name {
  font-weight: 600;
}
.kolvip-channel-title .ch-id {
  color: #9aa0a6;
  font-size: 10px;
}
.kolvip-channel-metrics {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  color: #bdc1c6;
  margin-bottom: 4px;
}
.kolvip-stats-tag {
  display: inline-block;
  padding: 1px 6px;
  border-radius: 4px;
  background: #3c4043;
  color: #e8eaed;
  font-size: 10px;
}
.st-insufficient_sample,
.st-backfill_pending {
  background: #5f4322;
}
.st-backfill_running,
.st-live_running {
  background: #1e5128;
}
.st-backfill_failed {
  background: #5c2b2b;
}
.kolvip-live-err {
  display: block;
  color: #f28b82;
  font-size: 10px;
  margin-top: 2px;
  word-break: break-all;
}
.kolvip-stats-error {
  color: #f28b82;
  padding: 8px 12px;
}
.kolvip-stats-muted,
.kolvip-stats-note {
  color: #9aa0a6;
  font-size: 10px;
  margin: 8px 0 0;
}
</style>
