<script setup>
import { ref, computed, watch, onMounted } from "vue";
import {
  fetchSignalConfig,
  fetchSignalOverview,
  fetchSignalHistory,
  formatCardTime,
  compareCardsByTimeDesc,
} from "../lib/discordSignalApi.js";
import { subscribeCollectorSocket } from "../composables/useCollectorSocket.js";
import { useHideKolName } from "../composables/useHideKolName.js";
import {
  cardExecution,
  outcomeLabel,
  statLineFromCards,
  isCardEnteredForEval,
  formatProfitPercent,
  sumLeverageProfitFromCards,
  formatPlannedSummary,
  formatActualSummary,
  cardBodyPreview,
  isSignalCardActive,
  cardStatusLabel,
  directionLabel,
  formatCardId,
  resolveCardProfitDisplay,
  resolveCardEvalOutcome,
} from "../lib/signalExecution.js";

const { hideKolName, toggleHideKol, maskKolName, maskPercent } = useHideKolName();

/** @param {string | null | undefined} name */
function maskChannelName(name) {
  return maskKolName(name || "—");
}

/** @param {number | null | undefined} pct */
function displayProfitPercent(pct) {
  return maskPercent(formatProfitPercent(pct));
}

/** @param {number | null | undefined} v */
function displayWinRate(v) {
  if (v == null || !Number.isFinite(Number(v))) return maskPercent("—");
  return maskPercent(`${Number(v).toFixed(1)}%`);
}

const props = defineProps({
  /** 与 /cards 一致的列表查询（days/from、source、channelId、symbol） */
  listQuery: {
    type: Object,
    default: () => ({}),
  },
  /** 父级选中的发车频道（空=全部） */
  channelId: {
    type: String,
    default: "",
  },
  /** 与 /eval 评估表一致的频道行（有则网格与上方 eval-table 同步，不再仅限 Discord 配置频道） */
  evalChannels: {
    type: Array,
    default: () => [],
  },
});

const loading = ref(false);
const error = ref("");
const overview = ref(
  /** @type {{ fromMs: number, toMs: number, channels: Array<Record<string, unknown>> } | null} */ (null)
);
const selectedChannelId = ref("");
const historyLoading = ref(false);
const history = ref(/** @type {import("../lib/discordSignalApi.js").SignalCard[]} */ ([]));

const overviewQuery = computed(() => {
  const q = { ...props.listQuery, status: "all" };
  return q;
});

const useEvalChannels = computed(
  () => Array.isArray(props.evalChannels) && props.evalChannels.length > 0
);

const channels = computed(() => {
  if (useEvalChannels.value) {
    return props.evalChannels.map((ch) => {
      const row = /** @type {Record<string, unknown>} */ (ch);
      return {
        channelId: String(row.channelId ?? ""),
        name: String(row.channelName ?? row.channelId ?? "未分组"),
        evalRow: row,
      };
    });
  }
  return overview.value?.channels ?? [];
});

const selectedChannel = computed(() =>
  channels.value.find((c) => String(c.channelId) === selectedChannelId.value)
);

const enteredHistory = computed(() =>
  history.value.filter((c) => isCardEnteredForEval(/** @type {Record<string, unknown>} */ (c)))
);

const filteredStats = computed(() => statLineFromCards(enteredHistory.value));

const historyProfitSum = computed(() => sumLeverageProfitFromCards(enteredHistory.value));

function syncOverviewStatsForSelected() {
  if (useEvalChannels.value) return;
  const chans = overview.value?.channels;
  if (!chans || !selectedChannelId.value) return;
  const stats = statLineFromCards(enteredHistory.value);
  const idx = chans.findIndex((c) => String(c.channelId) === selectedChannelId.value);
  if (idx >= 0) chans[idx].stats = stats;
}

/** @param {Array<Record<string, unknown>>} [rows] */
function syncSelectedChannelId(rows) {
  const list = rows ?? channels.value;
  const forced = String(props.channelId ?? "").trim();
  if (forced) {
    selectedChannelId.value = forced;
    return;
  }
  if (!selectedChannelId.value && list.length) {
    selectedChannelId.value = String(list[0]?.channelId ?? "");
    return;
  }
  if (
    selectedChannelId.value &&
    !list.some((c) => String(c.channelId ?? "") === selectedChannelId.value)
  ) {
    selectedChannelId.value = list.length ? String(list[0]?.channelId ?? "") : "";
  }
}

/** @param {Record<string, unknown>} ch */
function channelStats(ch) {
  const cid = String(ch.channelId ?? "");
  if (cid === selectedChannelId.value && !historyLoading.value) {
    return filteredStats.value;
  }
  return /** @type {Record<string, number>} */ (ch.stats ?? {});
}

/** @param {Record<string, unknown>} ch */
function channelSubtitle(ch) {
  const row = ch.evalRow;
  if (row && typeof row === "object") {
    const wr = displayWinRate(
      row.winRate != null && Number.isFinite(Number(row.winRate)) ? Number(row.winRate) : null
    );
    if (hideKolName.value) {
      return `已入场 ${Number(row.cardCount) || 0} · ***胜 /***负 · 胜率 ${wr}`;
    }
    return `已入场 ${Number(row.cardCount) || 0} · 胜 ${Number(row.winCount) || 0}/负 ${Number(row.lossCount) || 0} · 胜率 ${wr}`;
  }
  return statLine(channelStats(ch));
}

async function loadOverview() {
  if (useEvalChannels.value) {
    loading.value = false;
    error.value = "";
    syncSelectedChannelId();
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    overview.value = await fetchSignalOverview(overviewQuery.value);
    syncSelectedChannelId(overview.value?.channels ?? []);
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
    const res = await fetchSignalHistory(selectedChannelId.value, {
      ...overviewQuery.value,
      limit: 500,
    });
    history.value = [...(res.cards ?? [])].sort(compareCardsByTimeDesc);
    syncOverviewStatsForSelected();
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    historyLoading.value = false;
  }
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function cardProfit(card) {
  return resolveCardProfitDisplay(/** @type {Record<string, unknown>} */ (card));
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function cardOutcomeLabel(card) {
  return outcomeLabel(resolveCardEvalOutcome(/** @type {Record<string, unknown>} */ (card)));
}

/** @param {Record<string, unknown>} msg */
function onSocketMsg(msg) {
  if (msg.channel !== "meta") return;
  if (msg.kind === "signal_card_updated" && msg.card && typeof msg.card === "object") {
    const updated = /** @type {import("../lib/discordSignalApi.js").SignalCard} */ (msg.card);
    const idx = history.value.findIndex((c) => c.id === updated.id);
    if (idx >= 0) {
      history.value[idx] = updated;
      history.value.sort(compareCardsByTimeDesc);
      syncOverviewStatsForSelected();
    }
    if (!useEvalChannels.value) void loadOverview();
    return;
  }
  if (
    msg.kind === "signal_card_created" ||
    msg.kind === "card_archived" ||
    msg.kind === "signal_card_deleted"
  ) {
    if (!useEvalChannels.value) void loadOverview();
    if (selectedChannelId.value) void loadHistory();
  }
}

/** @param {Record<string, number>} stats */
function statLine(stats) {
  if (!stats) return "—";
  return `共 ${stats.total ?? 0} · 进行中 ${stats.pending ?? 0} · 止盈 ${stats.take_profit ?? 0} · 止损 ${stats.stop_loss ?? 0}`;
}

watch(
  () => props.evalChannels,
  () => {
    if (useEvalChannels.value) syncSelectedChannelId();
  },
  { deep: true }
);

watch(
  () => props.listQuery,
  () => {
    void loadOverview();
    void loadHistory();
  },
  { deep: true }
);

watch(
  () => props.channelId,
  (id) => {
    if (String(id ?? "").trim()) selectedChannelId.value = String(id).trim();
  }
);

watch(selectedChannelId, () => void loadHistory());

onMounted(async () => {
  await fetchSignalConfig();
  if (props.channelId) selectedChannelId.value = props.channelId;
  await loadOverview();
  subscribeCollectorSocket(onSocketMsg);
});
</script>

<template>
  <section class="sov-section">
    <header class="sov-section-head">
      <div>
        <h2 class="sov-section-title">{{ useEvalChannels ? "频道盈利明细" : "Discord 信号频道" }}</h2>
        <p class="sov-section-sub">
          {{ useEvalChannels ? "与上方评估表一致的频道/博主列表" : "各监听频道发单与实际做单盈利率（与左侧筛选一致）" }}
        </p>
      </div>
      <button
        type="button"
        class="sov-hide-kol-btn"
        :class="{ on: hideKolName }"
        :title="hideKolName ? '显示 KOL 名称与完整收益率' : '隐藏 KOL 名称，收益率显示为 +1***%'"
        @click="toggleHideKol"
      >
        {{ hideKolName ? "显示 KOL" : "隐藏 KOL" }}
      </button>
    </header>

    <p v-if="error" class="sov-err">{{ error }}</p>
    <p v-if="loading" class="sov-wait">加载频道…</p>

    <div v-if="channels.length" class="sov-channel-grid">
      <button
        v-for="ch in channels"
        :key="String(ch.channelId)"
        type="button"
        class="sov-channel-card"
        :class="{ active: selectedChannelId === String(ch.channelId) }"
        @click="selectedChannelId = String(ch.channelId)"
      >
        <div class="sov-channel-name">{{ maskChannelName(String(ch.name ?? "")) }}</div>
        <div class="sov-channel-stats">{{ channelSubtitle(ch) }}</div>
      </button>
    </div>
    <p v-else-if="!loading" class="sov-wait">当前筛选下暂无 Discord 信号频道数据</p>

    <div v-if="selectedChannel" class="sov-history">
      <header class="sov-history-head">
        <h3>
          {{ maskChannelName(String(selectedChannel.name ?? "")) }} · 盈利明细
          <span
            v-if="historyProfitSum"
            class="sov-profit-sum"
            :class="{ gain: historyProfitSum.sum > 0, loss: historyProfitSum.sum < 0 }"
          >
            （{{ displayProfitPercent(historyProfitSum.sum) }}）
          </span>
        </h3>
        <span class="sov-history-stats">{{ statLine(filteredStats) }}</span>
      </header>

      <p v-if="historyLoading" class="sov-wait">加载历史…</p>
      <p v-else-if="!enteredHistory.length" class="sov-wait">该筛选条件下暂无已入场信号记录</p>

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
            <tr
              v-for="card in enteredHistory"
              :key="card.id"
              :class="{ inactive: !isSignalCardActive(card) }"
            >
              <td class="sov-col-time">{{ formatCardTime(card) || "—" }}</td>
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
                <div v-if="cardBodyPreview(card) && !hideKolName" class="sov-cell-sub">{{ cardBodyPreview(card) }}</div>
              </td>
              <td class="sov-col-actual">
                <div class="sov-cell-main">{{ formatActualSummary(cardExecution(card)) }}</div>
                <div v-if="card.note && !hideKolName" class="sov-cell-sub">备注：{{ card.note }}</div>
              </td>
              <td class="sov-col-profit">
                <template v-if="cardProfit(card)">
                  <span
                    class="sov-profit"
                    :class="{ gain: cardProfit(card).spot > 0, loss: cardProfit(card).spot < 0 }"
                  >
                    {{ directionLabel(cardProfit(card).side) }}
                    {{ displayProfitPercent(cardProfit(card).spot) }}
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
                  {{ displayProfitPercent(cardProfit(card).leveragePct) }}
                </span>
                <span v-else class="sov-muted">—</span>
              </td>
              <td>{{ cardOutcomeLabel(card) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  </section>
</template>

<style scoped>
.sov-section {
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid #2d3136;
}
.sov-section-head {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 1rem;
}
.sov-section-title {
  margin: 0;
  font-size: 1.05rem;
  font-weight: 650;
  color: #f2f3f5;
}
.sov-section-sub {
  margin: 0.25rem 0 0;
  font-size: 0.82rem;
  color: #949ba4;
}
.sov-hide-kol-btn {
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
.sov-hide-kol-btn.on {
  border-color: #5865f2;
  background: rgba(88, 101, 242, 0.18);
  color: #aeb4ff;
}
.sov-err {
  color: #f28b82;
  font-size: 0.85rem;
}
.sov-wait {
  color: #9aa0a6;
  font-size: 0.85rem;
}
.sov-channel-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 0.65rem;
  margin-bottom: 1.25rem;
}
.sov-channel-card {
  text-align: left;
  background: #1a1c20;
  border: 1px solid #2d3136;
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
  color: #e8eaed;
}
.sov-channel-stats {
  font-size: 0.72rem;
  color: #9aa0a6;
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
.sov-history-head h3 {
  margin: 0;
  font-size: 0.95rem;
  color: #e8eaed;
}
.sov-profit-sum {
  font-weight: 700;
  margin-left: 0.15rem;
}
.sov-profit-sum.gain {
  color: #81c995;
}
.sov-profit-sum.loss {
  color: #f28b82;
}
.sov-history-stats {
  font-size: 0.78rem;
  color: #9aa0a6;
}
.sov-table-wrap {
  overflow-x: auto;
  border: 1px solid #2d3136;
  border-radius: 8px;
  background: #1a1c20;
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
  border-bottom: 1px solid #2d3136;
}
.sov-table th {
  background: #15171a;
  color: #9aa0a6;
  font-weight: 600;
  white-space: nowrap;
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
  color: #9aa0a6;
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
  color: #e8eaed;
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
  background: rgba(129, 201, 149, 0.15);
  color: #81c995;
}
.sov-status-tag.off {
  background: rgba(154, 160, 166, 0.15);
  color: #9aa0a6;
}
.sov-profit {
  font-weight: 600;
}
.sov-profit.gain {
  color: #81c995;
}
.sov-profit.loss {
  color: #f28b82;
}
.sov-lev-tag {
  display: inline-block;
  margin-right: 0.25rem;
  font-size: 0.72rem;
  color: #9aa0a6;
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
