<script setup>
import { ref, computed, watch, onMounted } from "vue";
import PageLoadingBlock from "./PageLoadingBlock.vue";
import { aggregateEvalChannelRows, emptyEvalMetrics, fetchEvalChannel } from "../lib/cardEvalApi.js";
import {
  fetchSignalConfig,
  fetchSignalOverview,
  fetchSignalHistory,
  formatCardTime,
  compareCardsByTimeDesc,
} from "../lib/discordSignalApi.js";
import { subscribeCollectorSocket } from "../composables/useCollectorSocket.js";
import { useHideKolName } from "../composables/useHideKolName.js";
import { pnlToneClass } from "../lib/pnlTone.js";
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
  /** 父级评估汇总仍在加载 */
  parentLoading: {
    type: Boolean,
    default: false,
  },
  /** 胜率榜前 N（展示文案） */
  evalTopN: {
    type: Number,
    default: 20,
  },
  /** 左侧时间筛选文案（生成汇总表标题） */
  periodLabel: {
    type: String,
    default: "当前时段",
  },
  /** 巨鲸模式：网格可勾选 + 生成汇总 */
  kolvipSelectMode: {
    type: Boolean,
    default: false,
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
/** @type {import('vue').Ref<Array<Record<string, unknown>>>} */
const kolvipSigHistory = ref([]);
/** @type {import('vue').Ref<Array<Record<string, unknown>>>} */
const kolvipSigOpen = ref([]);
/** @type {import('vue').Ref<Record<string, unknown>|null>} */
const kolvipSigStat = ref(null);
const kolvipSigRange = ref("");
const localArchiveCardCount = ref(0);

/** @type {import("vue").Ref<Set<string>>} */
const checkedChannelIds = ref(new Set());
const showCustomSummary = ref(false);
/** @type {import("vue").Ref<Array<Record<string, unknown>>>} */
const customSummaryRows = ref([]);
const customSummaryTotal = ref(/** @type {import("../lib/cardEvalApi.js").EvalMetrics} */ (emptyEvalMetrics()));

const sectionBooting = computed(
  () => props.parentLoading || loading.value,
);

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
        rank: row.rank,
      };
    });
  }
  return overview.value?.channels ?? [];
});

const checkedCount = computed(() => checkedChannelIds.value.size);

function syncCheckedFromChannels() {
  if (!props.kolvipSelectMode || !useEvalChannels.value) return;
  const valid = new Set(channels.value.map((c) => String(c.channelId ?? "")).filter(Boolean));
  const next = new Set([...checkedChannelIds.value].filter((id) => valid.has(id)));
  if (!next.size && valid.size) {
    for (const id of valid) next.add(id);
  }
  checkedChannelIds.value = next;
}

function selectAllChannels() {
  const next = new Set();
  for (const ch of channels.value) {
    const id = String(ch.channelId ?? "");
    if (id) next.add(id);
  }
  checkedChannelIds.value = next;
}

function clearChannelChecks() {
  checkedChannelIds.value = new Set();
  showCustomSummary.value = false;
}

/** @param {string} channelId */
function toggleChannelCheck(channelId) {
  const id = String(channelId ?? "").trim();
  if (!id) return;
  const next = new Set(checkedChannelIds.value);
  if (next.has(id)) next.delete(id);
  else next.add(id);
  checkedChannelIds.value = next;
}

/** @param {string} channelId */
function isChannelChecked(channelId) {
  return checkedChannelIds.value.has(String(channelId ?? ""));
}

function generateCustomSummary() {
  /** @type {import("../lib/cardEvalApi.js").EvalChannelRow[]} */
  const picked = [];
  for (const ch of channels.value) {
    const id = String(ch.channelId ?? "");
    if (!id || !checkedChannelIds.value.has(id)) continue;
    const row = ch.evalRow;
    if (row && typeof row === "object") {
      picked.push(/** @type {import("../lib/cardEvalApi.js").EvalChannelRow} */ (row));
    }
  }
  customSummaryRows.value = picked.map((r) => ({ ...r }));
  customSummaryTotal.value = aggregateEvalChannelRows(picked);
  showCustomSummary.value = picked.length > 0;
}

/** @param {string} channelId */
function openChannelDetail(channelId) {
  selectedChannelId.value = String(channelId);
}

const selectedChannel = computed(() =>
  channels.value.find((c) => String(c.channelId) === selectedChannelId.value)
);

const enteredHistory = computed(() =>
  history.value.filter((c) => isCardEnteredForEval(/** @type {Record<string, unknown>} */ (c)))
);

const useKolvipSigDetail = computed(
  () => useEvalChannels.value && (kolvipSigHistory.value.length > 0 || kolvipSigOpen.value.length > 0)
);

const kolvipHistoryHeadStats = computed(() => {
  const st = kolvipSigStat.value;
  const openN = kolvipSigOpen.value.length;
  if (!st && !kolvipSigHistory.value.length) return "";
  const wins = Number(st?.wins) || 0;
  const losses = Number(st?.losses) || 0;
  const count = Number(st?.count) || kolvipSigHistory.value.length;
  let winN = 0;
  let lossN = 0;
  for (const row of kolvipSigHistory.value) {
    const s = String(row.status ?? "").toLowerCase();
    if (s === "win") winN += 1;
    else if (s === "lose" || s === "loss") lossN += 1;
  }
  if (wins || losses) {
    return `网页 ${count} 笔 · 胜 ${wins}/负 ${losses} · 进行中 ${openN}`;
  }
  return `网页 ${kolvipSigHistory.value.length} 笔 · 胜 ${winN}/负 ${lossN} · 进行中 ${openN}`;
});

function kolvipSideLabel(s) {
  return Number(s) > 0 ? "多" : "空";
}

function fmtKolvipR(r) {
  const n = Number(r);
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${Math.round(n * 100) / 100} R`;
}

function fmtKolvipTs(ms) {
  const t = Number(ms);
  if (!Number.isFinite(t) || t <= 0) return "—";
  return new Date(t).toLocaleString("zh-CN", { hour12: false });
}

function kolvipStatusLabel(row) {
  const s = String(row?.status ?? "").trim();
  if (s === "win") return "止盈";
  if (s === "lose" || s === "loss") return "止损";
  if (s === "be") return "保本";
  return s || "—";
}

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

function fmtRowR(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  const sign = n > 0 ? "+" : "";
  return maskPercent(`${sign}${n.toFixed(2)} R`);
}

/** @param {Record<string, unknown>} ch */
function channelSubtitle(ch) {
  const row = ch.evalRow;
  if (row && typeof row === "object") {
    const web = row.metricsSource === "kolvip_web" || row.sig;
    const wr = displayWinRate(
      row.winRate != null && Number.isFinite(Number(row.winRate)) ? Number(row.winRate) : null
    );
    if (web) {
      const n = Number(row.cardCount) || 0;
      return `网页 ${n} 笔 · 胜率 ${wr} · 累计 ${fmtRowR(row.totalPnlPct)}`;
    }
    if (row.kolvipSigMissing) {
      return "网页胜率未关联 · 见上方提示";
    }
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
    kolvipSigHistory.value = [];
    kolvipSigOpen.value = [];
    kolvipSigStat.value = null;
    return;
  }
  historyLoading.value = true;
  try {
    const res = useEvalChannels.value
      ? await fetchEvalChannel(selectedChannelId.value, {
          ...overviewQuery.value,
          source: "kolvip",
        })
      : await fetchSignalHistory(selectedChannelId.value, {
          ...overviewQuery.value,
          limit: 500,
        });
    const raw = res.cards ?? [];
    history.value = [...raw].sort(compareCardsByTimeDesc);
    localArchiveCardCount.value = Array.isArray(raw) ? raw.length : 0;
    const ks = res.kolvipSig;
    if (ks && typeof ks === "object") {
      kolvipSigHistory.value = Array.isArray(ks.history) ? [...ks.history] : [];
      kolvipSigOpen.value = Array.isArray(ks.open) ? [...ks.open] : [];
      kolvipSigStat.value = ks.stat && typeof ks.stat === "object" ? ks.stat : null;
      kolvipSigRange.value = String(ks.range ?? "");
      kolvipSigHistory.value.sort((a, b) => Number(b.call_time ?? 0) - Number(a.call_time ?? 0));
    } else {
      kolvipSigHistory.value = [];
      kolvipSigOpen.value = [];
      kolvipSigStat.value = null;
      kolvipSigRange.value = "";
    }
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
    if (useEvalChannels.value) {
      syncSelectedChannelId();
      syncCheckedFromChannels();
    }
  },
  { deep: true, immediate: true }
);

watch(channels, () => syncCheckedFromChannels());

watch(
  () => props.listQuery,
  () => {
    showCustomSummary.value = false;
    if (!useEvalChannels.value) void loadOverview();
    else syncSelectedChannelId();
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
  if (props.kolvipSelectMode || useEvalChannels.value) {
    syncSelectedChannelId();
  } else {
    await loadOverview();
  }
  subscribeCollectorSocket(onSocketMsg);
});
</script>

<template>
  <section class="sov-section">
    <PageLoadingBlock
      v-if="sectionBooting"
      message="加载巨鲸信号频道…"
      hint="正在拉取胜率榜频道发单记录与盈利统计"
    />
    <header class="sov-section-head">
      <div>
        <h2 class="sov-section-title">{{ useEvalChannels ? "巨鲸信号频道 · 盈利明细" : "巨鲸信号频道" }}</h2>
        <p class="sov-section-sub">
          {{
            useEvalChannels
              ? `胜率榜前 ${evalTopN} 博主 · 与上方评估表一致`
              : "各监听频道发单与实际做单盈利率（与左侧筛选一致）"
          }}
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

    <div
      v-if="kolvipSelectMode && useEvalChannels && channels.length"
      class="sov-pick-toolbar"
    >
      <span class="sov-pick-hint">勾选博主 · 时间「{{ periodLabel }}」</span>
      <div class="sov-pick-actions">
        <button type="button" class="sov-pick-btn" @click="selectAllChannels">全选</button>
        <button type="button" class="sov-pick-btn" @click="clearChannelChecks">清空</button>
        <button
          type="button"
          class="sov-pick-btn primary"
          :disabled="checkedCount === 0"
          @click="generateCustomSummary"
        >
          生成汇总表（{{ checkedCount }}）
        </button>
      </div>
    </div>

    <div v-if="channels.length" class="sov-channel-grid">
      <div
        v-for="ch in channels"
        :key="String(ch.channelId)"
        class="sov-channel-card"
        :class="{
          active: selectedChannelId === String(ch.channelId),
          checked: kolvipSelectMode && isChannelChecked(ch.channelId),
        }"
      >
        <label
          v-if="kolvipSelectMode && useEvalChannels"
          class="sov-channel-check"
          @click.stop
        >
          <input
            type="checkbox"
            :checked="isChannelChecked(ch.channelId)"
            @change="toggleChannelCheck(ch.channelId)"
          />
        </label>
        <button
          type="button"
          class="sov-channel-open"
          @click="openChannelDetail(ch.channelId)"
        >
          <div class="sov-channel-name">
            <span v-if="ch.rank" class="sov-rank">#{{ ch.rank }}</span>
            {{ maskChannelName(String(ch.name ?? "")) }}
          </div>
          <div class="sov-channel-stats">
            <template v-if="ch.evalRow && (ch.evalRow.metricsSource === 'kolvip_web' || ch.evalRow.sig)">
              网页 {{ Number(ch.evalRow.cardCount) || 0 }} 笔 · 胜率
              {{
                displayWinRate(
                  ch.evalRow.winRate != null && Number.isFinite(Number(ch.evalRow.winRate))
                    ? Number(ch.evalRow.winRate)
                    : null
                )
              }}
              · 累计
              <span class="sov-r" :class="pnlToneClass(ch.evalRow.totalPnlPct)">{{
                maskPercent(fmtRowR(ch.evalRow.totalPnlPct))
              }}</span>
            </template>
            <template v-else>{{ channelSubtitle(ch) }}</template>
          </div>
        </button>
      </div>
    </div>
    <p v-else-if="!loading" class="sov-wait">当前筛选下暂无巨鲸信号频道数据</p>

    <div v-if="showCustomSummary && customSummaryRows.length" class="sov-summary-table-wrap">
      <h3 class="sov-summary-title">勾选汇总 · {{ periodLabel }} · {{ checkedCount }} 个频道</h3>
      <table class="sov-table sov-summary-table">
        <thead>
          <tr>
            <th>#</th>
            <th>博主</th>
            <th>卡片</th>
            <th>胜率</th>
            <th>总 PnL</th>
            <th>平均 PnL</th>
            <th>胜/负</th>
            <th>进行中</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="row in customSummaryRows" :key="'sum-' + row.channelId">
            <td class="sov-muted">{{ row.rank ?? "—" }}</td>
            <td>{{ maskChannelName(String(row.channelName ?? row.channelId)) }}</td>
            <td>{{ row.cardCount }}</td>
            <td>{{ displayWinRate(row.winRate != null ? Number(row.winRate) : null) }}</td>
            <td :class="{ gain: row.totalPnlPct > 0, loss: row.totalPnlPct < 0 }">
              {{ displayProfitPercent(row.totalPnlPct) }}
            </td>
            <td>{{ displayProfitPercent(row.avgPnlPct) }}</td>
            <td class="sov-muted">{{ row.winCount }}/{{ row.lossCount }}</td>
            <td>{{ row.pendingCount }}</td>
          </tr>
          <tr class="sov-summary-total">
            <td colspan="2">合计</td>
            <td>{{ customSummaryTotal.cardCount }}</td>
            <td>{{ displayWinRate(customSummaryTotal.winRate) }}</td>
            <td :class="{ gain: customSummaryTotal.totalPnlPct > 0, loss: customSummaryTotal.totalPnlPct < 0 }">
              {{ displayProfitPercent(customSummaryTotal.totalPnlPct) }}
            </td>
            <td>{{ displayProfitPercent(customSummaryTotal.avgPnlPct) }}</td>
            <td class="sov-muted">{{ customSummaryTotal.winCount }}/{{ customSummaryTotal.lossCount }}</td>
            <td>{{ customSummaryTotal.pendingCount }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-if="selectedChannel" class="sov-history">
      <PageLoadingBlock
        v-if="historyLoading"
        message="加载频道信号明细…"
        hint="历史卡片较多时首次打开会稍慢"
      />
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
        <span class="sov-history-stats">{{
          useKolvipSigDetail ? kolvipHistoryHeadStats : statLine(filteredStats)
        }}</span>
      </header>

      <p v-if="useKolvipSigDetail" class="sov-wait sov-kolvip-note">
        下列为 kolvip 网页 AI 结算单（与「博主胜率」同源{{
          kolvipSigRange ? ` · ${kolvipSigRange === "7" ? "近7天" : kolvipSigRange === "30" ? "近30天" : "全部"}` : ""
        }}）。本地归档 {{ localArchiveCardCount }} 张卡，已入场路径明细 {{ enteredHistory.length }} 条。
      </p>

      <template v-if="useKolvipSigDetail">
        <div v-if="kolvipSigOpen.length" class="sov-kolvip-open">
          <h4>进行中（{{ kolvipSigOpen.length }}）</h4>
          <ul>
            <li v-for="s in kolvipSigOpen" :key="'o-' + s.id">
              <b>{{ s.coin }}</b> {{ kolvipSideLabel(s.side) }}
              <span class="sov-muted">{{ s.status }}</span>
            </li>
          </ul>
        </div>
        <div class="sov-table-wrap">
          <table class="sov-table sov-kolvip-tbl">
            <thead>
              <tr>
                <th>喊单时间</th>
                <th>币种</th>
                <th>方向</th>
                <th>结果</th>
                <th>收益 R</th>
                <th>入场</th>
                <th>止损</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in kolvipSigHistory" :key="'k-' + s.id">
                <td class="sov-col-time">{{ fmtKolvipTs(s.call_time) }}</td>
                <td><b>{{ s.coin }}</b></td>
                <td :class="Number(s.side) > 0 ? 'gain' : 'loss'">{{ kolvipSideLabel(s.side) }}</td>
                <td>{{ kolvipStatusLabel(s) }}<span v-if="s.how" class="sov-muted"> · {{ s.how }}</span></td>
                <td class="sov-col-profit sov-r" :class="pnlToneClass(s.r)">
                  {{ maskPercent(fmtKolvipR(s.r)) }}
                </td>
                <td class="sov-muted">{{ s.entry_price ?? s.entry_lo ?? "—" }}</td>
                <td class="sov-muted">{{ s.sl ?? "—" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>

      <p v-else-if="!historyLoading && !enteredHistory.length" class="sov-wait">
        该筛选条件下暂无已入场信号记录；可在「博主胜率」同步后查看网页结算单。
      </p>

      <div v-else-if="enteredHistory.length" class="sov-table-wrap">
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
  position: relative;
  margin-top: 1.5rem;
  padding-top: 1.25rem;
  border-top: 1px solid #2d3136;
  min-height: 10rem;
}
.sov-history {
  position: relative;
  min-height: 6rem;
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
.sov-kolvip-note {
  margin: 0 0 0.65rem;
  line-height: 1.45;
}
.sov-kolvip-open {
  margin-bottom: 0.75rem;
}
.sov-kolvip-open h4 {
  margin: 0 0 0.35rem;
  font-size: 0.85rem;
  color: #dcddde;
}
.sov-kolvip-open ul {
  list-style: none;
  margin: 0;
  padding: 0;
  font-size: 0.82rem;
}
.sov-kolvip-open li {
  padding: 0.2rem 0;
}
.sov-pick-toolbar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
  margin-bottom: 0.75rem;
}
.sov-pick-hint {
  font-size: 0.78rem;
  color: #9aa0a6;
}
.sov-pick-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.sov-pick-btn {
  padding: 0.3rem 0.55rem;
  border-radius: 6px;
  background: #2b2d31;
  color: #dbdee1;
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
}
.sov-pick-btn.primary {
  background: #5865f2;
  color: #fff;
}
.sov-pick-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.sov-channel-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(160px, 1fr));
  gap: 0.65rem;
  margin-bottom: 1.25rem;
}
.sov-channel-card {
  display: flex;
  align-items: flex-start;
  gap: 0.35rem;
  text-align: left;
  background: #1a1c20;
  border: 1px solid #2d3136;
  border-radius: 10px;
  padding: 0.55rem 0.5rem 0.55rem 0.4rem;
  color: inherit;
}
.sov-channel-card.checked {
  border-color: rgba(88, 101, 242, 0.55);
}
.sov-channel-card.active {
  border-color: #5865f2;
  background: rgba(88, 101, 242, 0.12);
}
.sov-channel-check {
  flex-shrink: 0;
  padding: 0.2rem 0.15rem 0 0.25rem;
  cursor: pointer;
}
.sov-channel-check input {
  width: 14px;
  height: 14px;
  accent-color: #5865f2;
}
.sov-channel-open {
  flex: 1;
  min-width: 0;
  text-align: left;
  background: transparent;
  border: none;
  padding: 0.15rem 0.35rem 0.15rem 0;
  color: inherit;
  cursor: pointer;
}
.sov-rank {
  margin-right: 0.25rem;
  font-size: 0.68rem;
  color: #6d7480;
  font-weight: 700;
}
.sov-summary-table-wrap {
  margin-bottom: 1.25rem;
  border: 1px solid #2d3136;
  border-radius: 8px;
  overflow: hidden;
  background: #1a1c20;
}
.sov-summary-title {
  margin: 0;
  padding: 0.55rem 0.75rem;
  font-size: 0.88rem;
  font-weight: 650;
  border-bottom: 1px solid #2d3136;
  color: #e8eaed;
}
.sov-summary-table {
  font-size: 0.82rem;
}
.sov-summary-total td {
  font-weight: 700;
  background: rgba(88, 101, 242, 0.08);
  border-top: 1px solid #3d4148;
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
.sov-profit.gain,
.sov-r.gain,
.sov-col-profit.gain {
  color: #81c995;
  font-weight: 600;
}
.sov-profit.loss,
.sov-r.loss,
.sov-col-profit.loss {
  color: #f28b82;
  font-weight: 600;
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
