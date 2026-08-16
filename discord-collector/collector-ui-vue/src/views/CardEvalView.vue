<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import { emptyEvalMetrics, fetchEvalChannel, fetchEvalSummary } from "../lib/cardEvalApi.js";

const RANGE_OPTIONS = [
  { value: "1d", label: "当日" },
  { value: "7d", label: "近一周" },
  { value: "14d", label: "近两周" },
  { value: "30d", label: "近一月" },
  { value: "90d", label: "近三月" },
  { value: "custom", label: "自定义" },
];

const range = ref("1d");
const customFrom = ref("");
const customTo = ref("");
const loading = ref(false);
const error = ref("");
const note = ref("");
const overall = ref(/** @type {import("../lib/cardEvalApi.js").EvalMetrics | null} */ (null));
const channels = ref(/** @type {import("../lib/cardEvalApi.js").EvalChannelRow[]} */ ([]));
const selectedChannelId = ref(/** @type {string|null} */ (null));
const detailLoading = ref(false);
const detail = ref(/** @type {Record<string, unknown> | null} */ (null));

const queryOpts = computed(() => {
  /** @type {{ range: string, from?: string, to?: string }} */
  const o = { range: range.value };
  if (range.value === "custom") {
    if (customFrom.value) o.from = new Date(customFrom.value).toISOString();
    if (customTo.value) o.to = new Date(customTo.value).toISOString();
  }
  return o;
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

function outcomeLabel(o) {
  if (o === "take_profit") return "赢(TP)";
  if (o === "stop_loss") return "输(SL)";
  return "进行中";
}

function tpMarks(card) {
  const hits = Array.isArray(card.tpHits) ? card.tpHits : [];
  const idxs = new Set(hits.map((h) => Number(h.index)));
  const tps = Array.isArray(card.takeProfits) ? card.takeProfits : [];
  if (!tps.length) return hits.length ? `TP×${hits.length}` : "—";
  return tps
    .map((_, i) => (idxs.has(i) ? `TP${i + 1}✓` : `TP${i + 1}`))
    .join(" ");
}

async function loadSummary() {
  loading.value = true;
  error.value = "";
  try {
    const j = await fetchEvalSummary(queryOpts.value);
    overall.value = j?.overall ?? emptyEvalMetrics();
    channels.value = Array.isArray(j?.channels) ? j.channels.filter((c) => (c?.cardCount ?? 0) > 0) : [];
    note.value = j?.note ?? "";
    if (selectedChannelId.value != null) {
      const still = channels.value.some((c) => c.channelId === selectedChannelId.value);
      if (!still) {
        selectedChannelId.value = null;
        detail.value = null;
      } else {
        await loadDetail();
      }
    }
  } catch (e) {
    overall.value = null;
    channels.value = [];
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    loading.value = false;
  }
}

async function loadDetail() {
  if (selectedChannelId.value == null) {
    detail.value = null;
    return;
  }
  detailLoading.value = true;
  try {
    detail.value = await fetchEvalChannel(selectedChannelId.value, queryOpts.value);
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    detailLoading.value = false;
  }
}

/** @param {import("../lib/cardEvalApi.js").EvalChannelRow} ch */
function openChannel(ch) {
  selectedChannelId.value = ch.channelId ?? "";
  void loadDetail();
}

function backToChannels() {
  selectedChannelId.value = null;
  detail.value = null;
}

watch([range, customFrom, customTo], () => {
  if (range.value === "custom" && !customFrom.value) return;
  void loadSummary();
});

onMounted(() => void loadSummary());
</script>

<template>
  <div class="eval-page">
    <header class="eval-head">
      <div>
        <h1>卡片评估</h1>
        <p class="eval-sub">按 Discord 频道统计胜率与损益（任意 TP=赢 · 先 SL=输 · 1/N 分批止盈）</p>
      </div>
      <div class="eval-head-actions">
        <select v-model="range" class="eval-select">
          <option v-for="o in RANGE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
        <template v-if="range === 'custom'">
          <input v-model="customFrom" type="datetime-local" class="eval-input" />
          <span class="eval-muted">至</span>
          <input v-model="customTo" type="datetime-local" class="eval-input" />
        </template>
        <button type="button" class="eval-btn" :disabled="loading" @click="loadSummary">刷新</button>
        <RouterLink to="/cards" class="eval-link">卡片</RouterLink>
      </div>
    </header>

    <p v-if="note" class="eval-note">{{ note }}</p>
    <p v-if="error" class="eval-err">{{ error }}</p>
    <p v-if="loading" class="eval-wait">加载中…</p>

    <section v-if="overall && selectedChannelId === null" class="eval-overall">
      <div class="eval-stat">
        <span class="eval-stat-label">已入场卡片</span>
        <span class="eval-stat-val">{{ overall.cardCount }}</span>
      </div>
      <div class="eval-stat">
        <span class="eval-stat-label">胜率</span>
        <span class="eval-stat-val">{{ fmtWinRate(overall.winRate) }}</span>
        <span class="eval-stat-sub">{{ overall.winCount }}胜 / {{ overall.lossCount }}负 · 进行中 {{ overall.pendingCount }}</span>
      </div>
      <div class="eval-stat">
        <span class="eval-stat-label">总损益</span>
        <span
          class="eval-stat-val"
          :class="{ gain: overall.totalPnlPct > 0, loss: overall.totalPnlPct < 0 }"
        >{{ fmtPct(overall.totalPnlPct) }}</span>
      </div>
      <div class="eval-stat">
        <span class="eval-stat-label">平均损益</span>
        <span
          class="eval-stat-val"
          :class="{ gain: (overall.avgPnlPct ?? 0) > 0, loss: (overall.avgPnlPct ?? 0) < 0 }"
        >{{ fmtPct(overall.avgPnlPct) }}</span>
      </div>
      <div class="eval-stat">
        <span class="eval-stat-label">TP 命中</span>
        <span class="eval-stat-val sm">TP1 {{ overall.tp1Hits }} · TP2 {{ overall.tp2Hits }} · TP3 {{ overall.tp3Hits }}</span>
      </div>
    </section>

    <section v-if="selectedChannelId === null" class="eval-table-wrap">
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
          <tr v-if="!channels.length && !loading">
            <td colspan="6" class="eval-muted">该时段暂无已入场卡片</td>
          </tr>
          <tr
            v-for="ch in channels"
            :key="ch.channelId || '_'"
            class="eval-row-click"
            @click="openChannel(ch)"
          >
            <td>{{ ch.channelName || ch.channelId || "未分组" }}</td>
            <td>{{ ch.cardCount }}</td>
            <td>{{ fmtWinRate(ch.winRate) }} <span class="eval-muted">({{ ch.winCount }}/{{ ch.lossCount }})</span></td>
            <td :class="{ gain: ch.totalPnlPct > 0, loss: ch.totalPnlPct < 0 }">{{ fmtPct(ch.totalPnlPct) }}</td>
            <td :class="{ gain: (ch.avgPnlPct ?? 0) > 0, loss: (ch.avgPnlPct ?? 0) < 0 }">{{ fmtPct(ch.avgPnlPct) }}</td>
            <td class="eval-muted">{{ ch.tp1Hits }}/{{ ch.tp2Hits }}/{{ ch.tp3Hits }}</td>
          </tr>
        </tbody>
      </table>
    </section>

    <section v-else class="eval-detail">
      <header class="eval-detail-head">
        <button type="button" class="eval-btn ghost" @click="backToChannels">← 返回频道列表</button>
        <h2>{{ detail?.channelName || selectedChannelId || "未分组" }}</h2>
        <span v-if="detail?.metrics" class="eval-muted">
          胜率 {{ fmtWinRate(detail.metrics.winRate) }} · 总 {{ fmtPct(detail.metrics.totalPnlPct) }}
        </span>
      </header>
      <p v-if="detailLoading" class="eval-wait">加载卡片…</p>
      <div v-else class="eval-table-wrap">
        <table class="eval-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>标的</th>
              <th>方向</th>
              <th>入场</th>
              <th>TP</th>
              <th>SL</th>
              <th>状态</th>
              <th>结果</th>
              <th>PnL</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="card in detail?.cards ?? []" :key="String(card.id)">
              <td class="eval-time">{{ card.signalAt ? new Date(card.signalAt).toLocaleString() : "—" }}</td>
              <td>{{ card.symbol || "—" }}</td>
              <td>{{ card.direction || "—" }}</td>
              <td>{{ card.entry || "—" }}</td>
              <td class="eval-tps">{{ tpMarks(card) }}</td>
              <td>{{ card.stopLoss || "—" }}</td>
              <td>{{ card.status || "—" }}</td>
              <td>{{ outcomeLabel(card.outcome) }}</td>
              <td :class="{ gain: (card.pnlPct ?? 0) > 0, loss: (card.pnlPct ?? 0) < 0 }">{{ fmtPct(card.pnlPct) }}</td>
              <td>
                <RouterLink :to="`/cards`" class="eval-link sm">卡片</RouterLink>
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.eval-page {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 1.25rem 1.5rem 2rem;
  color: #e8eaed;
}
.eval-head {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1rem;
}
.eval-head h1 {
  margin: 0;
  font-size: 1.35rem;
  font-weight: 650;
}
.eval-sub {
  margin: 0.35rem 0 0;
  font-size: 0.85rem;
  color: #9aa0a6;
  max-width: 36rem;
}
.eval-head-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}
.eval-select,
.eval-input {
  background: #1e2024;
  border: 1px solid #3c4043;
  color: #e8eaed;
  border-radius: 6px;
  padding: 0.35rem 0.55rem;
  font-size: 0.85rem;
}
.eval-btn {
  background: #3b82f6;
  border: none;
  color: #fff;
  border-radius: 6px;
  padding: 0.35rem 0.75rem;
  font-size: 0.85rem;
  cursor: pointer;
}
.eval-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.eval-btn.ghost {
  background: transparent;
  border: 1px solid #3c4043;
  color: #e8eaed;
}
.eval-link {
  color: #8ab4f8;
  text-decoration: none;
  font-size: 0.85rem;
}
.eval-link.sm {
  font-size: 0.8rem;
}
.eval-note {
  font-size: 0.8rem;
  color: #9aa0a6;
  margin: 0 0 0.75rem;
}
.eval-err {
  color: #f28b82;
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
.eval-row-click {
  cursor: pointer;
}
.eval-row-click:hover {
  background: #22252a;
}
.eval-detail-head {
  display: flex;
  flex-wrap: wrap;
  gap: 0.75rem;
  align-items: center;
  margin-bottom: 0.75rem;
}
.eval-detail-head h2 {
  margin: 0;
  font-size: 1.1rem;
}
.eval-time {
  font-variant-numeric: tabular-nums;
}
.eval-tps {
  font-size: 0.8rem;
  white-space: normal;
  max-width: 12rem;
}
</style>
