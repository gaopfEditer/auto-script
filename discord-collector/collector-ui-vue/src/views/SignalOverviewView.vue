<script setup>
import { ref, computed, watch, onMounted } from "vue";
import { RouterLink } from "vue-router";
import {
  fetchSignalConfig,
  fetchSignalOverview,
  fetchSignalHistory,
  updateSignalCard,
} from "../lib/discordSignalApi.js";
import SignalExecutionForm from "../components/SignalExecutionForm.vue";
import {
  cardExecution,
  outcomeLabel,
  takeProfitText,
  buildExecutionPayload,
  executionEquals,
} from "../lib/signalExecution.js";

const PERIOD_OPTIONS = [
  { value: 7, label: "近 7 天" },
  { value: 30, label: "近 30 天" },
  { value: 90, label: "近 90 天" },
  { value: 0, label: "全部" },
];

const days = ref(30);
const loading = ref(false);
const error = ref("");
const overview = ref(/** @type {{ fromMs: number, toMs: number, channels: Array<Record<string, unknown>> } | null} */ (null));
const selectedChannelId = ref("");
const historyLoading = ref(false);
const history = ref(/** @type {import("../lib/discordSignalApi.js").SignalCard[]} */ ([]));
const historyStats = ref(/** @type {Record<string, number>} */ ({}));
const expandedCardId = ref(/** @type {number | null} */ (null));

/** @type {Record<number, import("../lib/signalExecution.js").SignalExecution>} */
const execDraft = ref({});
/** @type {Record<number, string>} */
const plannedTpText = ref({});
/** @type {Record<number, string>} */
const actualTpText = ref({});

const channels = computed(() => overview.value?.channels ?? []);

const selectedChannel = computed(() =>
  channels.value.find((c) => String(c.channelId) === selectedChannelId.value)
);

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
    history.value = res.cards ?? [];
    historyStats.value = res.stats ?? {};
    syncDrafts(history.value);
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    historyLoading.value = false;
  }
}

/** @param {import("../lib/discordSignalApi.js").SignalCard[]} list */
function syncDrafts(list) {
  for (const c of list) {
    const ex = cardExecution(c);
    execDraft.value[c.id] = structuredClone(ex);
    plannedTpText.value[c.id] = takeProfitText(ex.planned);
    actualTpText.value[c.id] = takeProfitText(ex.actual);
  }
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function cardTitle(card) {
  const ex = cardExecution(card);
  if (ex.symbol) return ex.symbol.replace(/^\$/, "");
  return `#${card.id}`;
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
async function saveCard(card) {
  const draft = execDraft.value[card.id];
  if (!draft) return;
  const payload = buildExecutionPayload(draft, {
    plannedTp: plannedTpText.value[card.id],
    actualTp: actualTpText.value[card.id],
  });
  if (executionEquals(payload, cardExecution(card))) return;
  try {
    const updated = await updateSignalCard(card.id, { execution: payload });
    const idx = history.value.findIndex((c) => c.id === updated.id);
    if (idx >= 0) history.value[idx] = updated;
    execDraft.value[updated.id] = structuredClone(cardExecution(updated));
    plannedTpText.value[updated.id] = takeProfitText(cardExecution(updated).planned);
    actualTpText.value[updated.id] = takeProfitText(cardExecution(updated).actual);
    await loadOverview();
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  }
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
        <p class="sov-sub">各监听频道的做单统计与历史记录</p>
      </div>
      <div class="sov-head-actions">
        <select v-model.number="days" class="sov-period">
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
        <div v-if="ch.recent?.length" class="sov-recent">
          <span v-for="c in ch.recent.slice(0, 3)" :key="c.id" class="sov-recent-chip">
            {{ (c.execution?.symbol || `#${c.id}`).replace(/^\$/, "") }}
            <em>{{ outcomeLabel(c.execution?.outcome ?? "pending") }}</em>
          </span>
        </div>
      </button>
    </section>

    <section v-if="selectedChannel" class="sov-history">
      <header class="sov-history-head">
        <h2>{{ selectedChannel.name }} · 信号历史</h2>
        <span class="sov-history-stats">{{ statLine(historyStats) }}</span>
      </header>

      <p v-if="historyLoading" class="sov-wait">加载历史…</p>
      <p v-else-if="!history.length" class="sov-wait">该周期内暂无信号记录</p>

      <article v-for="card in history" :key="card.id" class="sov-history-item">
        <header class="sov-item-top" @click="expandedCardId = expandedCardId === card.id ? null : card.id">
          <span class="sov-item-symbol">{{ cardTitle(card) }}</span>
          <span class="sov-item-outcome">{{ outcomeLabel(cardExecution(card).outcome) }}</span>
          <span v-if="card.isManual" class="sov-item-manual">手动</span>
          <span class="sov-item-time">{{ card.createdAt ? new Date(card.createdAt).toLocaleString("zh-CN") : "" }}</span>
          <span class="sov-item-toggle">{{ expandedCardId === card.id ? "▾" : "▸" }}</span>
        </header>
        <div v-if="expandedCardId === card.id" class="sov-item-body">
          <SignalExecutionForm
            v-if="execDraft[card.id]"
            v-model="execDraft[card.id]"
            v-model:planned-tp-text="plannedTpText[card.id]"
            v-model:actual-tp-text="actualTpText[card.id]"
            @change="saveCard(card)"
          />
          <p v-if="card.note" class="sov-item-note">备注：{{ card.note }}</p>
          <pre v-if="card.rawContent" class="sov-item-raw">{{ card.rawContent }}</pre>
        </div>
      </article>
    </section>
  </div>
</template>

<style scoped>
.signal-overview-page {
  max-width: 960px;
  margin: 0 auto;
  padding: 1.25rem 1rem 2rem;
  color: #dbdee1;
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
.sov-period {
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
  grid-template-columns: repeat(auto-fill, minmax(220px, 1fr));
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
.sov-recent {
  display: flex;
  flex-wrap: wrap;
  gap: 0.25rem;
  margin-top: 0.45rem;
}
.sov-recent-chip {
  font-size: 0.65rem;
  background: #1e1f22;
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
}
.sov-recent-chip em {
  font-style: normal;
  color: #949ba4;
  margin-left: 0.2rem;
}
.sov-history-head {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 0.5rem 1rem;
  margin-bottom: 0.75rem;
}
.sov-history-head h2 {
  margin: 0;
  font-size: 1rem;
}
.sov-history-stats {
  font-size: 0.78rem;
  color: #949ba4;
}
.sov-history-item {
  background: #2b2d31;
  border: 1px solid #3f4147;
  border-radius: 8px;
  margin-bottom: 0.5rem;
  overflow: hidden;
}
.sov-item-top {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem 0.65rem;
  padding: 0.55rem 0.65rem;
  cursor: pointer;
}
.sov-item-top:hover {
  background: #35373c;
}
.sov-item-symbol {
  font-weight: 700;
  font-size: 0.85rem;
}
.sov-item-outcome {
  font-size: 0.72rem;
  color: #49e57a;
}
.sov-item-manual {
  font-size: 0.65rem;
  color: #faa61a;
}
.sov-item-time {
  margin-left: auto;
  font-size: 0.68rem;
  color: #6d7480;
}
.sov-item-toggle {
  color: #949ba4;
  font-size: 0.75rem;
}
.sov-item-body {
  padding: 0 0.65rem 0.65rem;
  border-top: 1px solid #3f4147;
}
.sov-item-note {
  font-size: 0.72rem;
  color: #949ba4;
  margin: 0.5rem 0 0;
}
.sov-item-raw {
  font-size: 0.75rem;
  white-space: pre-wrap;
  margin: 0.5rem 0 0;
  color: #949ba4;
  background: #1e1f22;
  padding: 0.45rem;
  border-radius: 6px;
}
</style>
