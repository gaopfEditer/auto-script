<script setup>
import { ref, computed, watch, onMounted } from "vue";
import { RouterLink } from "vue-router";
import { fetchSignalConfig, fetchSignalOverview, fetchSignalHistory, formatCardTime, compareCardsByTimeDesc } from "../lib/discordSignalApi.js";
import {
  cardExecution,
  outcomeLabel,
  statLineFromCards,
  calcProfitPercents,
  formatProfitPercent,
  sumLeverageProfitFromCards,
  formatPlannedSummary,
  formatActualSummary,
  cardBodyPreview,
  isSignalCardActive,
  cardStatusLabel,
  directionLabel,
  formatCardId,
} from "../lib/signalExecution.js";

const PERIOD_OPTIONS = [
  { value: 7, label: "近 7 天" },
  { value: 30, label: "近 30 天" },
  { value: 90, label: "近 90 天" },
  { value: 0, label: "全部" },
];

const STATUS_OPTIONS = [
  { value: "active", label: "有效" },
  { value: "all", label: "全部（含失效）" },
];

const days = ref(30);
const statusFilter = ref("active");
const loading = ref(false);
const error = ref("");
const overview = ref(/** @type {{ fromMs: number, toMs: number, channels: Array<Record<string, unknown>> } | null} */ (null));
const selectedChannelId = ref("");
const historyLoading = ref(false);
const history = ref(/** @type {import("../lib/discordSignalApi.js").SignalCard[]} */ ([]));

const channels = computed(() => overview.value?.channels ?? []);

const selectedChannel = computed(() =>
  channels.value.find((c) => String(c.channelId) === selectedChannelId.value)
);

const filteredHistory = computed(() => {
  if (statusFilter.value === "all") return history.value;
  return history.value.filter((c) => isSignalCardActive(c));
});

const filteredStats = computed(() => statLineFromCards(filteredHistory.value));

const historyProfitSum = computed(() => sumLeverageProfitFromCards(filteredHistory.value));

async function loadOverview() {
  loading.value = true;
  error.value = "";
  try {
    const d = Number(days.value);
    overview.value = await fetchSignalOverview(d > 0 ? { days: d } : { days: 3650 });
    if (!selectedChannelId.value && overview.value?.channels?.length) {
      selectedChannelId.value = String(overview.value.channels[0].channelId);
    }
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    loading.value = false;
  }
}

async function loadHistory() {
  if (!selectedChannelId.value) {
    history.value = [];
    return;
  }
  historyLoading.value = true;
  try {
    const d = Number(days.value);
    const res = await fetchSignalHistory(selectedChannelId.value, d > 0 ? { days: d } : { days: 3650 });
    history.value = [...(res.cards ?? [])].sort(compareCardsByTimeDesc);
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    historyLoading.value = false;
  }
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function cardProfit(cell) {
  const ex = cardExecution(cell);
  return calcProfitPercents(
    ex.actual.buyPrice,
    ex.actual.sellPrice,
    ex.direction,
    undefined,
    ex.symbol
  );
}

/** @param {Record<string, number>} stats */
function statLine(stats) {
  if (!stats) return "—";
  return `共 ${stats.total ?? 0} · 进行中 ${stats.pending ?? 0} · 止盈 ${stats.take_profit ?? 0} · 止损 ${stats.stop_loss ?? 0}`;
}

watch(days, () => {
  void loadOverview();
  void loadHistory();
});

watch(selectedChannelId, () => void loadHistory());

onMounted(async () => {
  await fetchSignalConfig();
  await loadOverview();
});
</script>

<template>
  <div class="signal-overview-page">
    <header class="sov-head">
      <div>
        <h1>信号概览</h1>
        <p class="sov-sub">各监听频道发单与实际做单盈利情况</p>
      </div>
      <div class="sov-head-actions">
        <select v-model.number="days" class="sov-select">
          <option v-for="p in PERIOD_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
        </select>
        <RouterLink to="/show" class="sov-link">← Show</RouterLink>
        <RouterLink to="/" class="sov-link">首页</RouterLink>
      </div>
    </header>

    <p v-if="error" class="sov-err">{{ error }}</p>
    <p v-if="loading" class="sov-wait">加载概览…</p>

    <section v-if="channels.length" class="sov-channel-grid">
      <button
        v-for="ch in channels"
        :key="String(ch.channelId)"
        type="button"
        class="sov-channel-card"
        :class="{ active: selectedChannelId === String(ch.channelId) }"
        @click="selectedChannelId = String(ch.channelId)"
      >
        <div class="sov-channel-name">{{ ch.name }}</div>
        <div class="sov-channel-stats">{{ statLine(ch.stats) }}</div>
      </button>
    </section>

    <section v-if="selectedChannel" class="sov-history">
      <header class="sov-history-head">
        <h2>
          {{ selectedChannel.name }} · 盈利明细
          <span
            v-if="historyProfitSum"
            class="sov-profit-sum"
            :class="{ gain: historyProfitSum.sum > 0, loss: historyProfitSum.sum < 0 }"
          >
            （{{ formatProfitPercent(historyProfitSum.sum) }}）
          </span>
        </h2>
        <div class="sov-history-filters">
          <select v-model="statusFilter" class="sov-select">
            <option v-for="o in STATUS_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
          </select>
          <span class="sov-history-stats">{{ statLine(filteredStats) }}</span>
        </div>
      </header>

      <p v-if="historyLoading" class="sov-wait">加载历史…</p>
      <p v-else-if="!filteredHistory.length" class="sov-wait">该筛选条件下暂无信号记录</p>

      <div v-else class="sov-table-wrap">
        <table class="sov-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>状态</th>
              <th>信号信息</th>
              <th>实际做单</th>
              <th>盈利率</th>
              <th>杠杆盈</th>
              <th>结果</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="card in filteredHistory" :key="card.id" :class="{ inactive: !isSignalCardActive(card) }">
              <td class="sov-col-time">
                {{ formatCardTime(card) || "—" }}
              </td>
              <td>
                <span class="sov-status-tag" :class="isSignalCardActive(card) ? 'on' : 'off'">
                  {{ cardStatusLabel(card) }}
                </span>
              </td>
              <td class="sov-col-signal">
                <div class="sov-cell-main">
                  <span v-if="formatCardId(card.id)" class="sov-card-id">{{ formatCardId(card.id) }}</span>
                  {{ formatPlannedSummary(cardExecution(card)) }}
                </div>
                <div v-if="cardBodyPreview(card)" class="sov-cell-sub">{{ cardBodyPreview(card) }}</div>
              </td>
              <td class="sov-col-actual">
                <div class="sov-cell-main">{{ formatActualSummary(cardExecution(card)) }}</div>
                <div v-if="card.note" class="sov-cell-sub">备注：{{ card.note }}</div>
              </td>
              <td class="sov-col-profit">
                <template v-if="cardProfit(card)">
                  <span
                    class="sov-profit"
                    :class="{ gain: cardProfit(card).spot > 0, loss: cardProfit(card).spot < 0 }"
                  >
                    {{ directionLabel(cardProfit(card).side) }}
                    {{ formatProfitPercent(cardProfit(card).spot) }}
                  </span>
                </template>
                <span v-else class="sov-muted">—</span>
              </td>
              <td class="sov-col-profit">
                <span
                  v-if="cardProfit(card)"
                  class="sov-profit"
                  :class="{ gain: cardProfit(card).spot > 0, loss: cardProfit(card).spot < 0 }"
                >
                  <span class="sov-lev-tag">{{ cardProfit(card).leverage }}x</span>
                  {{ formatProfitPercent(cardProfit(card).leveragePct) }}
                </span>
                <span v-else class="sov-muted">—</span>
              </td>
              <td>{{ outcomeLabel(cardExecution(card).outcome) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.signal-overview-page {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: #5c5f66 #1e1f22;
  max-width: 1200px;
  margin: 0 auto;
  padding: 1.25rem 1rem 2rem;
  color: #dbdee1;
  box-sizing: border-box;
}
.signal-overview-page::-webkit-scrollbar {
  width: 8px;
}
.signal-overview-page::-webkit-scrollbar-track {
  background: #1e1f22;
}
.signal-overview-page::-webkit-scrollbar-thumb {
  background: #5c5f66;
  border-radius: 4px;
}
.signal-overview-page::-webkit-scrollbar-thumb:hover {
  background: #6d7480;
}
.sov-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 1rem;
  margin-bottom: 1.25rem;
}
.sov-head h1 {
  margin: 0;
  font-size: 1.35rem;
  color: #f2f3f5;
}
.sov-sub {
  margin: 0.25rem 0 0;
  color: #949ba4;
  font-size: 0.85rem;
}
.sov-head-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.sov-select {
  background: #2b2d31;
  border: 1px solid #3f4147;
  color: #dbdee1;
  border-radius: 6px;
  padding: 0.35rem 0.5rem;
  font-size: 0.85rem;
}
.sov-link {
  color: #949ba4;
  text-decoration: none;
  font-size: 0.85rem;
  padding: 0.35rem 0.5rem;
  border-radius: 6px;
  border: 1px solid #3f4147;
}
.sov-link:hover {
  color: #fff;
  border-color: #5865f2;
}
.sov-err {
  color: #f38688;
  font-size: 0.85rem;
}
.sov-wait {
  color: #949ba4;
  font-size: 0.85rem;
}
.sov-channel-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 0.65rem;
  margin-bottom: 1.5rem;
}
.sov-channel-card {
  text-align: left;
  background: #2b2d31;
  border: 1px solid #3f4147;
  border-radius: 10px;
  padding: 0.75rem;
  cursor: pointer;
  color: inherit;
}
.sov-channel-card.active {
  border-color: #5865f2;
  background: rgba(88, 101, 242, 0.12);
}
.sov-channel-name {
  font-weight: 700;
  font-size: 0.9rem;
  margin-bottom: 0.35rem;
}
.sov-channel-stats {
  font-size: 0.72rem;
  color: #949ba4;
  line-height: 1.4;
}
.sov-history-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem 1rem;
  margin-bottom: 0.75rem;
}
.sov-history-head h2 {
  margin: 0;
  font-size: 1rem;
}
.sov-profit-sum {
  font-weight: 700;
  margin-left: 0.15rem;
}
.sov-profit-sum.gain {
  color: #49e57a;
}
.sov-profit-sum.loss {
  color: #f38688;
}
.sov-history-filters {
  display: flex;
  align-items: center;
  gap: 0.65rem;
}
.sov-history-stats {
  font-size: 0.78rem;
  color: #949ba4;
}
.sov-table-wrap {
  overflow-x: auto;
  border: 1px solid #3f4147;
  border-radius: 8px;
  background: #2b2d31;
}
.sov-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.78rem;
}
.sov-table th,
.sov-table td {
  padding: 0.55rem 0.65rem;
  text-align: left;
  vertical-align: top;
  border-bottom: 1px solid #3f4147;
}
.sov-table th {
  background: #25262a;
  color: #949ba4;
  font-weight: 600;
  white-space: nowrap;
  position: sticky;
  top: 0;
  z-index: 1;
}
.sov-table tbody tr:last-child td {
  border-bottom: none;
}
.sov-table tbody tr:hover {
  background: rgba(255, 255, 255, 0.03);
}
.sov-table tbody tr.inactive {
  opacity: 0.65;
}
.sov-col-time {
  white-space: nowrap;
  color: #949ba4;
  font-size: 0.72rem;
}
.sov-col-signal,
.sov-col-actual {
  min-width: 180px;
  max-width: 280px;
}
.sov-col-profit {
  white-space: nowrap;
}
.sov-cell-main {
  line-height: 1.45;
  color: #dbdee1;
}
.sov-cell-sub {
  margin-top: 0.25rem;
  font-size: 0.68rem;
  color: #6d7480;
  line-height: 1.4;
  word-break: break-word;
}
.sov-status-tag {
  display: inline-block;
  font-size: 0.65rem;
  padding: 0.08rem 0.35rem;
  border-radius: 3px;
}
.sov-status-tag.on {
  background: rgba(73, 229, 122, 0.15);
  color: #49e57a;
}
.sov-status-tag.off {
  background: rgba(148, 155, 164, 0.15);
  color: #949ba4;
}
.sov-profit {
  font-weight: 600;
}
.sov-profit.gain {
  color: #49e57a;
}
.sov-profit.loss {
  color: #f38688;
}
.sov-lev-tag {
  display: inline-block;
  margin-right: 0.25rem;
  font-size: 0.72rem;
  color: #949ba4;
  font-weight: 600;
}
.sov-card-id {
  margin-right: 0.35rem;
  font-size: 0.78rem;
  font-weight: 700;
  color: #aeb4ff;
  font-variant-numeric: tabular-nums;
}
.sov-muted {
  color: #6d7480;
}
</style>
