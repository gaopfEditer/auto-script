<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import SignalChannelOverviewSection from "../components/SignalChannelOverviewSection.vue";
import { emptyEvalMetrics, fetchEvalSummary } from "../lib/cardEvalApi.js";
import { fetchCardChannels, fetchCardSources } from "../lib/cardArchiveApi.js";
import {
  SOURCE_OPTIONS,
  PERIOD_OPTIONS,
  buildArchiveListQuery,
} from "../lib/cardArchiveFilters.js";
import { useHideKolName } from "../composables/useHideKolName.js";

const source = ref("");
const channelId = ref("");
const symbol = ref("");
const period = ref(/** @type {string | number} */ ("today"));
const loading = ref(false);
const error = ref("");
const note = ref("");
const overall = ref(/** @type {import("../lib/cardEvalApi.js").EvalMetrics | null} */ (null));
const channels = ref(/** @type {import("../lib/cardEvalApi.js").EvalChannelRow[]} */ ([]));
const channelOptions = ref(/** @type {import("../lib/cardArchiveApi.js").ArchiveChannelOption[]} */ ([]));

const { hideKolName, toggleHideKol, maskKolName, maskPercent } = useHideKolName();

const listQuery = computed(() =>
  buildArchiveListQuery({
    source: source.value,
    channelId: channelId.value,
    symbol: symbol.value.trim(),
    period: period.value,
  })
);

const showDiscordOverview = computed(() => {
  const s = String(source.value ?? "").trim().toLowerCase();
  return !s || s === "discord";
});

function fmtPct(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function fmtWinRate(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return `${Number(v).toFixed(1)}%`;
}

function displayWinRate(v) {
  return maskPercent(fmtWinRate(v));
}

function displayPct(v) {
  return maskPercent(fmtPct(v));
}

/** @param {number} win @param {number} loss @param {number} pending */
function displayWinLossSub(win, loss, pending) {
  if (!hideKolName.value) return `${win}胜 / ${loss}负 · 进行中 ${pending}`;
  return "***胜 / ***负 · 进行中 ***";
}

/** @param {import("../lib/cardEvalApi.js").EvalChannelRow} ch */
function channelBloggerLabel(ch) {
  return maskKolName(ch.channelName || ch.channelId || "未分组");
}

async function loadChannels() {
  try {
    channelOptions.value = await fetchCardChannels(listQuery.value);
    if (channelId.value && !channelOptions.value.some((c) => c.channelId === channelId.value)) {
      channelId.value = "";
    }
  } catch {
    channelOptions.value = [];
  }
}

async function loadSummary() {
  loading.value = true;
  error.value = "";
  try {
    const j = await fetchEvalSummary(listQuery.value);
    overall.value = j?.overall ?? emptyEvalMetrics();
    channels.value = Array.isArray(j?.channels) ? j.channels.filter((c) => (c?.cardCount ?? 0) > 0) : [];
    note.value = j?.note ?? "";
  } catch (e) {
    overall.value = null;
    channels.value = [];
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    loading.value = false;
  }
}

async function reload() {
  await loadChannels();
  await loadSummary();
}

watch([source, symbol, period], () => void reload());
watch(channelId, () => void loadSummary());
onMounted(() => void reload());
</script>

<template>
  <div class="eval-page">
    <aside class="filters">
      <div class="head">
        <h2>卡片评估</h2>
        <RouterLink to="/cards" class="link">卡片归档 →</RouterLink>
      </div>
      <p class="hint">筛选条件与卡片归档页一致：来源、发车频道、币种、时间。</p>

      <label class="field">
        <span>来源</span>
        <select v-model="source">
          <option v-for="o in SOURCE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </label>
      <label class="field">
        <span>发车频道</span>
        <select v-model="channelId">
          <option value="">全部频道</option>
          <option v-for="ch in channelOptions" :key="ch.channelId" :value="ch.channelId">
            {{ ch.channelName }} ({{ ch.count }})
          </option>
        </select>
      </label>
      <label class="field">
        <span>币种</span>
        <input v-model="symbol" type="text" placeholder="BTC / ETH" />
      </label>
      <label class="field">
        <span>时间</span>
        <select v-model="period">
          <option v-for="p in PERIOD_OPTIONS" :key="String(p.value)" :value="p.value">{{ p.label }}</option>
        </select>
      </label>
      <button type="button" class="btn" :disabled="loading" @click="reload">刷新</button>
      <p v-if="error" class="err">{{ error }}</p>
    </aside>

    <main class="eval-main">
      <header class="eval-head">
        <div>
          <h1>评估汇总</h1>
          <p class="eval-sub">档位胜率与损益统计 · 与当前筛选一致的卡片样本</p>
        </div>
        <button
          type="button"
          class="eval-hide-kol-btn"
          :class="{ on: hideKolName }"
          :title="hideKolName ? '显示 KOL 名称与完整胜率' : '隐藏 KOL 名称，胜率显示为 6***% 或 +1***%'"
          @click="toggleHideKol"
        >
          {{ hideKolName ? "显示 KOL" : "隐藏 KOL" }}
        </button>
      </header>

      <p v-if="note" class="eval-note">{{ note }}</p>
      <p v-if="loading" class="eval-wait">加载中…</p>

      <section v-if="overall" class="eval-overall">
        <div class="eval-stat">
          <span class="eval-stat-label">已入场卡片</span>
          <span class="eval-stat-val">{{ overall.cardCount }}</span>
        </div>
        <div class="eval-stat">
          <span class="eval-stat-label">胜率</span>
          <span class="eval-stat-val">{{ displayWinRate(overall.winRate) }}</span>
          <span class="eval-stat-sub">
            {{ displayWinLossSub(overall.winCount, overall.lossCount, overall.pendingCount) }}
          </span>
        </div>
        <div class="eval-stat">
          <span class="eval-stat-label">总损益</span>
          <span
            class="eval-stat-val"
            :class="{ gain: overall.totalPnlPct > 0, loss: overall.totalPnlPct < 0 }"
          >{{ displayPct(overall.totalPnlPct) }}</span>
        </div>
        <div class="eval-stat">
          <span class="eval-stat-label">平均损益</span>
          <span
            class="eval-stat-val"
            :class="{ gain: (overall.avgPnlPct ?? 0) > 0, loss: (overall.avgPnlPct ?? 0) < 0 }"
          >{{ displayPct(overall.avgPnlPct) }}</span>
        </div>
        <div class="eval-stat">
          <span class="eval-stat-label">TP 命中</span>
          <span class="eval-stat-val sm">TP1 {{ overall.tp1Hits }} · TP2 {{ overall.tp2Hits }} · TP3 {{ overall.tp3Hits }}</span>
        </div>
      </section>

      <section v-if="channels.length" class="eval-table-wrap eval-channel-summary">
        <table class="eval-table">
          <thead>
            <tr>
              <th>频道 / 博主</th>
              <th>卡片数</th>
              <th>胜率</th>
              <th>总 PnL</th>
              <th>平均 PnL</th>
              <th>TP1/2/3</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="ch in channels" :key="ch.channelId || '_'">
              <td>{{ channelBloggerLabel(ch) }}</td>
              <td>{{ ch.cardCount }}</td>
              <td>
                {{ displayWinRate(ch.winRate) }}
                <span class="eval-muted">
                  ({{ hideKolName ? "***" : ch.winCount }}/{{ hideKolName ? "***" : ch.lossCount }})
                </span>
              </td>
              <td :class="{ gain: ch.totalPnlPct > 0, loss: ch.totalPnlPct < 0 }">{{ displayPct(ch.totalPnlPct) }}</td>
              <td :class="{ gain: (ch.avgPnlPct ?? 0) > 0, loss: (ch.avgPnlPct ?? 0) < 0 }">{{ displayPct(ch.avgPnlPct) }}</td>
              <td class="eval-muted">{{ ch.tp1Hits }}/{{ ch.tp2Hits }}/{{ ch.tp3Hits }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <SignalChannelOverviewSection
        v-if="showDiscordOverview"
        :list-query="listQuery"
        :channel-id="channelId"
        :eval-channels="channels"
      />
      <p v-else class="eval-wait">当前来源筛选非 Discord，下方 Discord 信号频道明细已隐藏。</p>
    </main>
  </div>
</template>

<style scoped>
.eval-page {
  display: grid;
  grid-template-columns: 220px 1fr;
  height: 100%;
  min-height: 0;
  background: #1e1f22;
  color: #e8eaed;
}
.filters {
  padding: 1rem;
  overflow: auto;
  border-right: 1px solid #2b2d31;
}
.eval-main {
  padding: 1.25rem 1.5rem 2rem;
  overflow-y: auto;
  min-width: 0;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem;
}
h1,
h2 {
  margin: 0;
  color: #f2f3f5;
  font-size: 1.05rem;
}
.eval-head h1 {
  font-size: 1.35rem;
  font-weight: 650;
}
.link {
  font-size: 0.78rem;
  color: #5865f2;
  text-decoration: none;
}
.hint {
  color: #949ba4;
  font-size: 0.82rem;
  line-height: 1.45;
  margin: 0.5rem 0 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  margin: 0.65rem 0;
}
.field span {
  font-size: 0.75rem;
  color: #b5bac1;
  font-weight: 600;
}
.field input,
.field select {
  background: #2b2d31;
  border: 1px solid #3f4147;
  color: #dbdee1;
  border-radius: 6px;
  padding: 0.4rem 0.5rem;
}
.btn {
  width: 100%;
  margin-top: 0.5rem;
  padding: 0.45rem;
  border-radius: 6px;
  border: 1px solid #3f4147;
  background: #5865f2;
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.err {
  color: #f38688;
  font-size: 0.82rem;
}
.eval-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.eval-hide-kol-btn {
  flex-shrink: 0;
  padding: 0.35rem 0.65rem;
  border-radius: 6px;
  border: 1px solid #3f4147;
  background: #2b2d31;
  color: #b5bac1;
  font-size: 0.75rem;
  font-weight: 600;
  cursor: pointer;
}
.eval-hide-kol-btn.on {
  border-color: #5865f2;
  background: rgba(88, 101, 242, 0.18);
  color: #aeb4ff;
}
.eval-sub {
  margin: 0.35rem 0 0;
  font-size: 0.85rem;
  color: #9aa0a6;
  max-width: 36rem;
}
.eval-note {
  font-size: 0.8rem;
  color: #9aa0a6;
  margin: 0 0 0.75rem;
}
.eval-wait,
.eval-muted {
  color: #9aa0a6;
  font-size: 0.85rem;
}
.eval-overall {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  margin-bottom: 1.25rem;
}
.eval-stat {
  background: #1a1c20;
  border: 1px solid #2d3136;
  border-radius: 8px;
  padding: 0.75rem 1rem;
  min-width: 8.5rem;
}
.eval-stat-label {
  display: block;
  font-size: 0.75rem;
  color: #9aa0a6;
  margin-bottom: 0.25rem;
}
.eval-stat-val {
  font-size: 1.25rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.eval-stat-val.sm {
  font-size: 0.95rem;
}
.eval-stat-sub {
  display: block;
  font-size: 0.75rem;
  color: #9aa0a6;
  margin-top: 0.2rem;
}
.gain {
  color: #81c995;
}
.loss {
  color: #f28b82;
}
.eval-table-wrap {
  overflow-x: auto;
  border: 1px solid #2d3136;
  border-radius: 8px;
  margin-bottom: 0.5rem;
}
.eval-channel-summary {
  margin-bottom: 0;
}
.eval-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.eval-table th,
.eval-table td {
  padding: 0.55rem 0.75rem;
  text-align: left;
  border-bottom: 1px solid #2d3136;
  white-space: nowrap;
}
.eval-table th {
  background: #1a1c20;
  color: #9aa0a6;
  font-weight: 500;
}
</style>
