<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import PageLoadingBlock from "../components/PageLoadingBlock.vue";
import SignalChannelOverviewSection from "../components/SignalChannelOverviewSection.vue";
import { emptyEvalMetrics, fetchEvalSummary } from "../lib/cardEvalApi.js";
import { fetchCardChannels, fetchCardSources } from "../lib/cardArchiveApi.js";
import {
  SOURCE_OPTIONS,
  PERIOD_OPTIONS,
  buildArchiveListQuery,
} from "../lib/cardArchiveFilters.js";
import { useHideKolName } from "../composables/useHideKolName.js";
import { pnlToneClass } from "../lib/pnlTone.js";

const source = ref("kolvip");
const channelId = ref("");
const symbol = ref("");
const period = ref(/** @type {string | number} */ (30));
const loading = ref(false);
const hasLoadedOnce = ref(false);
const error = ref("");
const note = ref("");
const overall = ref(/** @type {import("../lib/cardEvalApi.js").EvalMetrics | null} */ (null));
const channels = ref(/** @type {import("../lib/cardEvalApi.js").EvalChannelRow[]} */ ([]));
const channelOptions = ref(/** @type {import("../lib/cardArchiveApi.js").ArchiveChannelOption[]} */ ([]));
const rankedChannelIds = ref(/** @type {string[]} */ ([]));
const dailyTopOverview = ref(/** @type {import("../lib/cardEvalApi.js").EvalChannelRow[]} */ ([]));
const kolvipEvalTopN = ref(20);
const kolvipSigAvailable = ref(false);
const kolvipSigRange = ref("");
const sigRankRows = ref(/** @type {import("../lib/cardEvalApi.js").EvalChannelRow[]} */ ([]));
const kolvipWeb = ref(/** @type {Record<string, unknown> | null} */ (null));

const { hideKolName, toggleHideKol, maskKolName, maskPercent } = useHideKolName();

const listQuery = computed(() =>
  buildArchiveListQuery({
    source: source.value,
    channelId: channelId.value,
    symbol: symbol.value.trim(),
    period: period.value,
  })
);

const isKolvipSource = computed(() => String(source.value ?? "").trim().toLowerCase() === "kolvip");

const showKolvipOverview = computed(() => isKolvipSource.value);

const periodLabel = computed(() => {
  const hit = PERIOD_OPTIONS.find((p) => p.value === period.value);
  return hit?.label ?? "当前时段";
});

/** 胜率榜前 N：以 sigRankRows（网页 R + 本地路径对照）为准 */
const kolvipRankedEvalChannels = computed(() => {
  if (sigRankRows.value.length) return sigRankRows.value;
  const ids = rankedChannelIds.value;
  if (!ids.length) return channels.value;
  const byId = new Map(channels.value.map((c) => [String(c.channelId), c]));
  const nameById = new Map(dailyTopOverview.value.map((r) => [String(r.channelId), String(r.channelName)]));
  return ids.map((id, idx) => {
    const hit = byId.get(id);
    if (hit) return { ...hit, rank: idx + 1 };
    return {
      rank: idx + 1,
      channelId: id,
      channelName: nameById.get(id) || "—",
      ...emptyEvalMetrics(),
    };
  });
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

function fmtR(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  const sign = n > 0 ? "+" : "";
  return `${sign}${n.toFixed(2)} R`;
}

function displayR(v) {
  return maskPercent(fmtR(v));
}

function fmtPl(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  return Number(v).toFixed(2);
}

/** @param {import("../lib/cardEvalApi.js").EvalChannelRow} ch */
function displayLocalWinRate(ch) {
  const lp = ch.localPath;
  if (!lp?.cardCount) return "—";
  return displayWinRate(lp.winRate);
}

/** @param {import("../lib/cardEvalApi.js").EvalMetrics | null | undefined} row */
function displayPrimaryPnl(row) {
  if (!row) return "—";
  if (row.pnlDisplayUnit === "R") return displayR(row.totalPnlPct);
  if (row.pnlDisplayUnit === "none" || row.pathPnlReliable === false) return "—";
  return displayPct(row.totalPnlPct);
}

/** @param {import("../lib/cardEvalApi.js").EvalChannelRow | import("../lib/cardEvalApi.js").EvalMetrics} ch */
function displayLocalPathPnl(ch) {
  const lp = ch?.localPath;
  if (!lp?.pathPnlReliable) return "—";
  return displayPct(lp.totalPnlPct);
}

/** @param {import("../lib/cardEvalApi.js").EvalChannelRow} ch */
function displayWinLossWeb(ch) {
  if (!hideKolName.value) return `${ch.winCount}/${ch.lossCount}`;
  return "***/***";
}

/** @param {import("../lib/cardEvalApi.js").EvalChannelRow} ch */
function displayWinLossLocal(ch) {
  const lp = ch.localPath;
  if (!lp) return "—";
  if (!hideKolName.value) return `${lp.winCount}/${lp.lossCount}`;
  return "***/***";
}

/** @param {import("../lib/cardEvalApi.js").EvalMetrics | null | undefined} row */
function displayAvgPnl(row) {
  if (!row) return "—";
  if (row.pnlDisplayUnit === "R") return displayR(row.avgPnlPct);
  if (row.pathPnlReliable === false && row.avgPnlPct == null) return "—";
  return displayPct(row.avgPnlPct);
}

/** @param {import("../lib/cardEvalApi.js").EvalChannelRow} ch */
function displaySigSub(ch) {
  if (!kolvipSigAvailable.value || !ch.sig) return "";
  const n = ch.sig.count ?? 0;
  if (!n) return "";
  return `网页 ${n} 笔`;
}

/** @param {number} win @param {number} loss @param {number} pending */
function displayWinLossSub(win, loss, pending) {
  if (!hideKolName.value) return `${win}胜 / ${loss}负 · 进行中 ${pending}`;
  return "***胜 / ***负 · 进行中 ***";
}

/** @param {import("../lib/cardEvalApi.js").EvalChannelRow | string} ch */
function channelBloggerLabel(ch) {
  if (typeof ch === "string") return maskKolName(ch || "—");
  const name = ch.sig?.bloggerName || ch.channelName || ch.channelId || "—";
  return maskKolName(name);
}

const kolvipWebReady = computed(
  () =>
    isKolvipSource.value &&
    (kolvipSigAvailable.value || sigRankRows.value.some((r) => r?.metricsSource === "kolvip_web" || r?.sig))
);

/** 巨鲸源不展示本地路径 % 汇总（-25411% 等），仅展示网页 R 或提示同步 */
const showEvalOverall = computed(() => {
  if (!overall.value) return false;
  if (!isKolvipSource.value) return true;
  return kolvipWebReady.value;
});

/** @param {import("../lib/cardEvalApi.js").EvalChannelRow} ch */
function rowUsesKolvipWeb(ch) {
  return ch?.metricsSource === "kolvip_web" || Boolean(ch?.sig);
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
    rankedChannelIds.value = j?.kolvipEval?.rankedChannelIds ?? [];
    dailyTopOverview.value = Array.isArray(j?.kolvipEval?.dailyTopOverview)
      ? j.kolvipEval.dailyTopOverview
      : [];
    kolvipEvalTopN.value = Number(j?.kolvipEval?.topN) || 20;
    kolvipSigAvailable.value = Boolean(j?.kolvipEval?.sigAvailable);
    kolvipSigRange.value = String(j?.kolvipEval?.sigRange ?? "");
    sigRankRows.value = Array.isArray(j?.kolvipEval?.sigRankRows) ? j.kolvipEval.sigRankRows : [];
    kolvipWeb.value =
      j?.kolvipEval?.kolvipWeb && typeof j.kolvipEval.kolvipWeb === "object" ? j.kolvipEval.kolvipWeb : null;
    note.value = j?.note ?? "";
  } catch (e) {
    overall.value = null;
    channels.value = [];
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    loading.value = false;
    if (!error.value) hasLoadedOnce.value = true;
  }
}

async function reload() {
  await loadSummary();
  await loadChannels();
}

watch([source, symbol, period], () => void reload());
watch(channelId, () => void loadSummary());
onMounted(() => void reload());
</script>

<template>
  <div class="eval-page">
    <aside class="filters" data-onboard="eval-filters">
      <div class="head">
        <h2>卡片评估</h2>
        <RouterLink to="/cards" class="link">卡片归档 →</RouterLink>
        <RouterLink v-if="isKolvipSource" to="/local/manual-stats/kolvip-sig" class="link">博主胜率 →</RouterLink>
      </div>
      <p class="hint">默认来源为巨鲸（kolvip）；可调时间窗口，在下方网格勾选频道后生成汇总表。</p>

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
      <label class="field" data-onboard="eval-period">
        <span>时间</span>
        <select v-model="period">
          <option v-for="p in PERIOD_OPTIONS" :key="String(p.value)" :value="p.value">{{ p.label }}</option>
        </select>
      </label>
      <button type="button" class="btn" :disabled="loading" @click="reload">刷新</button>
      <p v-if="error" class="err">{{ error }}</p>
    </aside>

    <main class="eval-main" data-onboard="eval-summary">
      <PageLoadingBlock
        v-if="loading && !hasLoadedOnce"
        message="加载频道评估…"
        hint="首次打开会汇总卡片样本与巨鲸信号频道盈利明细，数据量大时可能需十数秒"
      />
      <header class="eval-head">
        <div>
          <h1>评估汇总</h1>
          <p class="eval-sub">
            {{
              isKolvipSource && kolvipWebReady
                ? "主指标 = kolvip「博主胜率统计」（累计 R / 胜率 / 笔数）· 与 /local/manual-stats/kolvip-sig 同源"
                : "档位胜率与损益统计 · 与当前筛选一致的卡片样本"
            }}
          </p>
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

      <p v-if="isKolvipSource && !kolvipWebReady" class="eval-note eval-err-banner">
        巨鲸评估需新版 API + kolvip-sig：请重启 collect:ui（或 collector-ui-server）后硬刷新；并确保「博主胜率」已同步（POST /api/kolvip/sig/sync）。未就绪前<strong>不展示</strong>本地路径 % 汇总。
      </p>
      <p v-if="note" class="eval-note">{{ note }}</p>
      <p v-if="loading && hasLoadedOnce" class="eval-wait">刷新中…</p>

      <section v-if="showEvalOverall" class="eval-overall">
        <div class="eval-stat">
          <span class="eval-stat-label">{{ isKolvipSource && kolvipWebReady ? "有结果单（网页）" : "已入场卡片" }}</span>
          <span class="eval-stat-val">{{ overall.cardCount }}</span>
          <span v-if="isKolvipSource && kolvipWebReady && overall.localPath?.cardCount" class="eval-stat-sub">
            本地卡 {{ overall.localPath.cardCount }}
          </span>
        </div>
        <div class="eval-stat">
          <span class="eval-stat-label">胜率</span>
          <span class="eval-stat-val">{{ displayWinRate(overall.winRate) }}</span>
          <span class="eval-stat-sub">
            {{ displayWinLossSub(overall.winCount, overall.lossCount, overall.pendingCount) }}
            <template v-if="isKolvipSource && kolvipWebReady"> · 进行中 {{ overall.pendingCount }}</template>
          </span>
        </div>
        <div class="eval-stat">
          <span class="eval-stat-label">{{ isKolvipSource && kolvipWebReady ? "累计 R" : "总损益" }}</span>
          <span
            class="eval-stat-val"
            :class="{ gain: (overall.totalPnlPct ?? 0) > 0, loss: (overall.totalPnlPct ?? 0) < 0 }"
          >{{ displayPrimaryPnl(overall) }}</span>
          <span v-if="overall.kolvipScopeLabel" class="eval-stat-sub">{{ overall.kolvipScopeLabel }}</span>
        </div>
        <div class="eval-stat">
          <span class="eval-stat-label">{{ isKolvipSource && kolvipWebReady ? "笔均 R" : "平均损益" }}</span>
          <span
            class="eval-stat-val"
            :class="{ gain: (overall.avgPnlPct ?? 0) > 0, loss: (overall.avgPnlPct ?? 0) < 0 }"
          >{{ displayAvgPnl(overall) }}</span>
        </div>
        <div v-if="isKolvipSource && kolvipWebReady" class="eval-stat">
          <span class="eval-stat-label">盈亏比（加权）</span>
          <span class="eval-stat-val">{{ fmtPl(overall.kolvipAvgPl ?? kolvipWeb?.topNAggregate?.avgPl) }}</span>
        </div>
        <div v-if="isKolvipSource && kolvipWebReady" class="eval-stat">
          <span class="eval-stat-label">全站进行中</span>
          <span class="eval-stat-val">{{ kolvipWeb?.openTotal ?? "—" }}</span>
          <span class="eval-stat-sub">榜内 {{ overall.pendingCount ?? 0 }}</span>
        </div>
        <div v-if="!isKolvipSource || !kolvipWebReady" class="eval-stat">
          <span class="eval-stat-label">TP 命中</span>
          <span class="eval-stat-val sm">TP1 {{ overall.tp1Hits }} · TP2 {{ overall.tp2Hits }} · TP3 {{ overall.tp3Hits }}</span>
        </div>
      </section>
      <section
        v-if="isKolvipSource && kolvipWebReady && kolvipWeb?.boardAggregate"
        class="eval-overall eval-board-agg"
      >
        <p class="eval-section-inline-h">
          全站上榜博主合计（{{ kolvipWeb.rangeLabel }} · ≥{{ kolvipWeb.minCount }} 单上榜）
        </p>
        <div class="eval-stat sm">
          <span class="eval-stat-label">胜率</span>
          <span class="eval-stat-val">{{ displayWinRate(kolvipWeb.boardAggregate.winRate) }}</span>
          <span class="eval-stat-sub">
            {{ kolvipWeb.boardAggregate.wins }}/{{ kolvipWeb.boardAggregate.losses }}
            · {{ kolvipWeb.boardAggregate.count }} 笔
          </span>
        </div>
        <div class="eval-stat sm">
          <span class="eval-stat-label">累计 R</span>
          <span
            class="eval-stat-val"
            :class="pnlToneClass(kolvipWeb.boardAggregate.totalR)"
          >{{ displayR(kolvipWeb.boardAggregate.totalR) }}</span>
        </div>
        <div class="eval-stat sm">
          <span class="eval-stat-label">笔均 R</span>
          <span
            class="eval-stat-val"
            :class="pnlToneClass(kolvipWeb.boardAggregate.avgR)"
          >{{ displayR(kolvipWeb.boardAggregate.avgR) }}</span>
        </div>
        <div class="eval-stat sm">
          <span class="eval-stat-label">加权盈亏比</span>
          <span class="eval-stat-val">{{ fmtPl(kolvipWeb.boardAggregate.avgPl) }}</span>
        </div>
      </section>
      <p v-if="isKolvipSource && overall?.noteLocalPath" class="eval-note eval-local-note">{{ overall.noteLocalPath }}</p>

      <section v-if="isKolvipSource && kolvipRankedEvalChannels.length" class="eval-table-wrap eval-channel-summary">
        <h3 class="eval-section-h3">kolvip 胜率榜前 {{ kolvipEvalTopN }} <span class="eval-muted">（与站内榜单同行）</span></h3>
        <table class="eval-table">
          <thead>
            <tr>
              <th>#</th>
              <th>博主</th>
              <th>笔数</th>
              <th>胜率</th>
              <th>赢/亏</th>
              <th>盈亏比</th>
              <th>笔均 R</th>
              <th>累计 R</th>
              <th>最大连亏</th>
              <th>进行中</th>
              <th class="eval-muted">本地卡</th>
              <th class="eval-muted">本地胜率</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="ch in kolvipRankedEvalChannels" :key="ch.channelId || '_'">
              <td class="eval-muted">{{ ch.rank ?? "—" }}</td>
              <td>{{ channelBloggerLabel(ch) }}</td>
              <td>{{ rowUsesKolvipWeb(ch) ? ch.cardCount : "—" }}</td>
              <td>{{ rowUsesKolvipWeb(ch) ? displayWinRate(ch.winRate) : "—" }}</td>
              <td class="eval-muted">{{ rowUsesKolvipWeb(ch) ? displayWinLossWeb(ch) : "—" }}</td>
              <td class="eval-muted">{{ rowUsesKolvipWeb(ch) ? fmtPl(ch.sig?.pl) : "—" }}</td>
              <td class="eval-r" :class="rowUsesKolvipWeb(ch) ? pnlToneClass(ch.avgPnlPct) : {}">
                {{ rowUsesKolvipWeb(ch) ? displayR(ch.avgPnlPct) : "—" }}
              </td>
              <td class="eval-r" :class="rowUsesKolvipWeb(ch) ? pnlToneClass(ch.totalPnlPct) : {}">
                {{ rowUsesKolvipWeb(ch) ? displayR(ch.totalPnlPct) : "—" }}
              </td>
              <td class="eval-muted">{{ rowUsesKolvipWeb(ch) ? (ch.sig?.maxLose ?? "—") : "—" }}</td>
              <td>{{ rowUsesKolvipWeb(ch) ? (ch.pendingCount ?? 0) : "—" }}</td>
              <td class="eval-muted">
                {{ ch.localPath?.cardCount ?? 0 }}
                <span v-if="ch.localPath?.excludedCorrupt" class="eval-muted"> · 剔{{ ch.localPath.excludedCorrupt }}</span>
              </td>
              <td class="eval-muted">{{ displayLocalWinRate(ch) }}</td>
            </tr>
          </tbody>
        </table>
      </section>

      <SignalChannelOverviewSection
        v-if="showKolvipOverview"
        :list-query="listQuery"
        :channel-id="channelId"
        :eval-channels="kolvipRankedEvalChannels"
        :eval-top-n="kolvipEvalTopN"
        :period-label="periodLabel"
        kolvip-select-mode
        :parent-loading="loading"
      />
      <p v-else class="eval-wait">仅「巨鲸」来源显示下方频道网格；其它来源请用上方汇总表。</p>

      <section v-if="isKolvipSource && dailyTopOverview.length" class="eval-table-wrap eval-daily-overview">
        <h3 class="eval-section-h3">当日卡片一览 · 胜率榜前 {{ kolvipEvalTopN }}</h3>
        <p class="eval-sub" style="margin: 0 0 0.65rem">按上海自然日统计发单卡片数（与左侧时间筛选无关）</p>
        <table class="eval-table">
          <thead>
            <tr>
              <th>#</th>
              <th>频道 / 博主</th>
              <th>当日卡片</th>
              <th>胜率</th>
              <th>当日总 PnL</th>
              <th>胜/负</th>
              <th>进行中</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="row in dailyTopOverview" :key="'d-' + row.channelId">
              <td class="eval-muted">{{ row.rank }}</td>
              <td>{{ maskKolName(row.channelName || row.channelId) }}</td>
              <td>{{ row.cardCount }}</td>
              <td>{{ displayWinRate(row.winRate) }}</td>
              <td :class="{ gain: row.totalPnlPct > 0, loss: row.totalPnlPct < 0 }">{{ displayPct(row.totalPnlPct) }}</td>
              <td class="eval-muted">
                {{ hideKolName ? "***" : row.winCount }}/{{ hideKolName ? "***" : row.lossCount }}
              </td>
              <td>{{ row.pendingCount }}</td>
            </tr>
          </tbody>
        </table>
      </section>
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
  position: relative;
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
  color: #dbdee1;
  border-radius: 6px;
  padding: 0.4rem 0.5rem;
}
.btn {
  width: 100%;
  margin-top: 0.5rem;
  padding: 0.45rem;
  border-radius: 6px;
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
.eval-local-note {
  opacity: 0.85;
  font-size: 0.75rem;
}
.eval-err-banner {
  color: #f5a97f;
  border: 1px solid rgba(245, 169, 127, 0.35);
  padding: 0.5rem 0.65rem;
  border-radius: 6px;
  background: rgba(245, 169, 127, 0.08);
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
.eval-board-agg {
  margin-top: -0.35rem;
  padding-top: 0.5rem;
  border-top: 1px dashed #3a3d44;
}
.eval-section-inline-h {
  width: 100%;
  margin: 0 0 0.35rem;
  font-size: 0.78rem;
  color: #9aa0a6;
}
.eval-stat.sm {
  min-width: 7rem;
  padding: 0.55rem 0.75rem;
}
.eval-stat.sm .eval-stat-val {
  font-size: 1.05rem;
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
.eval-r {
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.eval-table td.eval-r.gain,
.eval-table td.eval-r.loss,
.eval-stat-val.gain,
.eval-stat-val.loss {
  font-weight: 700;
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
.eval-section-h3 {
  margin: 0;
  padding: 0.65rem 0.75rem;
  font-size: 0.88rem;
  font-weight: 650;
  color: #e8eaed;
  border-bottom: 1px solid #2d3136;
}
.eval-daily-overview {
  margin-top: 1.25rem;
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
