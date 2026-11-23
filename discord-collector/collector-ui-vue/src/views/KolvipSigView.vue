<script setup>
import { ref, computed, onMounted, watch } from "vue";
import {
  fetchKolvipSigBlogger,
  fetchKolvipSigMeta,
  fetchKolvipSigRank,
  syncKolvipSigLocal,
} from "../lib/kolvipSigApi.js";

defineOptions({ name: "KolvipSigView" });

/** @type {import('vue').Ref<'7'|'30'|'all'>} */
const range = ref("30");
const loading = ref(false);
const syncing = ref(false);
const error = ref("");
const meta = ref(/** @type {Record<string, unknown>|null} */ (null));
/** @type {import('vue').Ref<Record<string, unknown>|null>} */
const rank = ref(null);
/** @type {import('vue').Ref<Record<string, unknown>|null>} */
const blogger = ref(null);
const selectedName = ref("");

const rangeLabels = { 7: "近 7 天", 30: "近 30 天", all: "全部" };

async function loadRank() {
  loading.value = true;
  error.value = "";
  try {
    const j = await fetchKolvipSigRank(range.value);
    if (!j?.ok) throw new Error(j?.error || "加载失败");
    rank.value = j;
    const list = Array.isArray(j.list) ? j.list : [];
    const ranked = list.filter((x) => x.ranked);
    if (!selectedName.value || !list.some((x) => x.name === selectedName.value)) {
      selectedName.value = (ranked[0] || list[0] || {}).name || "";
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    rank.value = null;
  } finally {
    loading.value = false;
  }
}

async function loadBlogger() {
  if (!selectedName.value) {
    blogger.value = null;
    return;
  }
  try {
    const j = await fetchKolvipSigBlogger(selectedName.value, range.value);
    if (!j?.ok) throw new Error(j?.error || "加载博主失败");
    blogger.value = j;
  } catch (e) {
    blogger.value = null;
  }
}

async function loadMeta() {
  try {
    meta.value = await fetchKolvipSigMeta();
  } catch {
    meta.value = null;
  }
}

async function onSync() {
  syncing.value = true;
  error.value = "";
  try {
    const j = await syncKolvipSigLocal();
    if (j?.ok === false) throw new Error(j.error || "同步失败");
    await loadMeta();
    await loadRank();
    await loadBlogger();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    syncing.value = false;
  }
}

const rankedList = computed(() => {
  const list = Array.isArray(rank.value?.list) ? rank.value.list : [];
  return list.filter((x) => x.ranked);
});

const moreList = computed(() => {
  const list = Array.isArray(rank.value?.list) ? rank.value.list : [];
  return list.filter((x) => !x.ranked).slice(0, 30);
});

const stat = computed(() => blogger.value?.stat || null);
const history = computed(() => (Array.isArray(blogger.value?.history) ? blogger.value.history : []));
const openList = computed(() => (Array.isArray(blogger.value?.open) ? blogger.value.open : []));

function fmtR(r) {
  const n = Number(r);
  if (!Number.isFinite(n)) return "–";
  return `${n > 0 ? "+" : ""}${Math.round(n * 100) / 100}R`;
}

function sideLabel(s) {
  return Number(s) > 0 ? "多" : "空";
}

/** @param {{ name?: string }} row */
function pickRow(row) {
  selectedName.value = row.name || "";
}

watch([range, selectedName], () => {
  void loadBlogger();
});

onMounted(() => {
  void loadMeta();
  void loadRank().then(() => loadBlogger());
});
</script>

<template>
  <div class="kv-sig-page">
    <header class="kv-sig-head">
      <div>
        <h1>博主胜率统计 <span class="kv-sig-ai">✦ AI 分析</span></h1>
        <p class="kv-sig-sub">
          口径与 kolvip「博主胜率分析」一致（/webu/sig/*），数据来自本地 <code>data/kolvip-sig</code>
        </p>
      </div>
      <div class="kv-sig-actions">
        <button type="button" class="kv-sig-btn" :disabled="syncing" @click="onSync">
          {{ syncing ? "同步中…" : "从巨鲸拉取更新" }}
        </button>
        <span v-if="meta?.lastSyncAt" class="kv-sig-meta">上次同步 {{ meta.lastSyncAt }}</span>
      </div>
    </header>

    <div class="kv-sig-seg">
      <button
        v-for="(label, key) in rangeLabels"
        :key="key"
        type="button"
        class="kv-sig-seg-btn"
        :class="{ on: range === key }"
        @click="range = key; loadRank()"
      >
        {{ label }}
      </button>
      <span v-if="rank?.open != null" class="kv-sig-live">● {{ rank.open }} 单进行中</span>
    </div>

    <p v-if="error" class="kv-sig-err">{{ error }}</p>
    <p v-else-if="loading && !rank" class="kv-sig-muted">加载中…</p>

    <div v-else class="kv-sig-grid">
      <section class="kv-sig-list card">
        <h2>榜单 <small>上榜需 ≥ {{ rank?.min_count ?? 5 }} 单有结果</small></h2>
        <ul>
          <li
            v-for="(row, i) in rankedList"
            :key="row.name"
            class="kv-sig-row"
            :class="{ on: row.name === selectedName }"
            @click="pickRow(row)"
          >
            <span class="rk">{{ ["🥇", "🥈", "🥉"][i] || i + 1 }}</span>
            <div class="t">
              <b>{{ row.name }}</b>
              <small>{{ row.count }} 单 · 盈亏比 {{ row.pl || "–" }} · {{ fmtR(row.r) }}</small>
            </div>
            <span class="wr" :class="row.win_rate >= 50 ? 'up' : 'dn'">
              {{ row.count ? row.win_rate + "%" : "–" }}
            </span>
          </li>
        </ul>
        <template v-if="moreList.length">
          <h3>样本不足</h3>
          <ul>
            <li
              v-for="row in moreList"
              :key="'m-' + row.name"
              class="kv-sig-row alt"
              :class="{ on: row.name === selectedName }"
              @click="pickRow(row)"
            >
              <span class="rk">–</span>
              <div class="t">
                <b>{{ row.name }}</b>
                <small>{{ row.count }} 单</small>
              </div>
              <span class="wr muted">{{ row.count ? row.win_rate + "%" : "–" }}</span>
            </li>
          </ul>
        </template>
      </section>

      <section v-if="selectedName" class="kv-sig-detail card">
        <h2>{{ stat?.name || selectedName }}</h2>
        <div v-if="stat" class="kv-sig-kpis">
          <div><b :class="stat.win_rate >= 50 ? 'up' : 'dn'">{{ stat.count ? stat.win_rate + "%" : "–" }}</b><small>胜率</small></div>
          <div><b>{{ stat.pl || "–" }}</b><small>盈亏比</small></div>
          <div><b :class="stat.r >= 0 ? 'up' : 'dn'">{{ fmtR(stat.r) }}</b><small>累计收益</small></div>
          <div><b>{{ stat.wins }} / {{ stat.losses }}</b><small>赢 / 亏</small></div>
          <div><b class="dn">{{ stat.max_lose }}</b><small>最大连亏</small></div>
        </div>

        <h3>进行中 <span v-if="openList.length" class="kv-sig-live">● {{ openList.length }}</span></h3>
        <p v-if="!openList.length" class="kv-sig-muted">无进行中单子</p>
        <ul v-else class="kv-sig-open">
          <li v-for="s in openList" :key="s.id">
            <b>{{ s.coin }}</b> {{ sideLabel(s.side) }}
            <small>{{ s.status }}</small>
          </li>
        </ul>

        <h3>历史单子 <small>最近 {{ history.length }} 单</small></h3>
        <div class="kv-sig-tbl-wrap">
          <table class="kv-sig-tbl">
            <thead>
              <tr>
                <th>币种</th>
                <th>方向</th>
                <th>结果</th>
                <th>收益</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="s in history" :key="s.id">
                <td><b>{{ s.coin }}</b></td>
                <td :class="s.side > 0 ? 'up' : 'dn'">{{ sideLabel(s.side) }}</td>
                <td>{{ s.status }}</td>
                <td class="n" :class="s.r > 0 ? 'up' : s.r < 0 ? 'dn' : ''">{{ fmtR(s.r) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.kv-sig-page {
  max-width: 1100px;
  margin: 0 auto;
  padding: 1rem 1.5rem 2rem;
  color: #dbdee1;
}
.kv-sig-head {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1rem;
}
.kv-sig-head h1 {
  margin: 0;
  font-size: 1.25rem;
}
.kv-sig-ai {
  font-size: 0.75rem;
  color: #c38a2c;
  font-weight: 600;
}
.kv-sig-sub {
  margin: 0.35rem 0 0;
  font-size: 0.8rem;
  color: #949ba4;
}
.kv-sig-actions {
  display: flex;
  flex-direction: column;
  align-items: flex-end;
  gap: 0.35rem;
}
.kv-sig-btn {
  padding: 0.45rem 0.9rem;
  border-radius: 8px;
  border: none;
  background: #5865f2;
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}
.kv-sig-btn:disabled {
  opacity: 0.6;
  cursor: default;
}
.kv-sig-meta {
  font-size: 0.72rem;
  color: #949ba4;
}
.kv-sig-seg {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin-bottom: 1rem;
}
.kv-sig-seg-btn {
  padding: 0.35rem 0.75rem;
  border-radius: 8px;
  border: 1px solid #404249;
  background: #2b2d31;
  color: #949ba4;
  cursor: pointer;
  font-weight: 600;
  font-size: 0.82rem;
}
.kv-sig-seg-btn.on {
  background: #5865f2;
  border-color: #5865f2;
  color: #fff;
}
.kv-sig-live {
  margin-left: auto;
  font-size: 0.75rem;
  color: #49e57a;
}
.kv-sig-grid {
  display: grid;
  grid-template-columns: 1fr 1.1fr;
  gap: 1rem;
  align-items: start;
}
@media (max-width: 900px) {
  .kv-sig-grid {
    grid-template-columns: 1fr;
  }
}
.card {
  background: #2b2d31;
  border: 1px solid #404249;
  border-radius: 10px;
  padding: 0.85rem 1rem;
}
.card h2,
.card h3 {
  margin: 0 0 0.65rem;
  font-size: 0.95rem;
}
.card h3 {
  margin-top: 1rem;
  font-size: 0.85rem;
  color: #b5bac1;
}
.kv-sig-list ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.kv-sig-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.35rem;
  border-radius: 6px;
  cursor: pointer;
}
.kv-sig-row:hover,
.kv-sig-row.on {
  background: rgba(88, 101, 242, 0.15);
}
.kv-sig-row .rk {
  width: 1.5rem;
  text-align: center;
  flex-shrink: 0;
}
.kv-sig-row .t {
  flex: 1;
  min-width: 0;
}
.kv-sig-row .t b {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kv-sig-row .t small {
  color: #949ba4;
  font-size: 0.68rem;
}
.kv-sig-row .wr {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.up {
  color: #49e57a;
}
.dn {
  color: #f23f43;
}
.muted {
  color: #949ba4;
}
.kv-sig-kpis {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(4.5rem, 1fr));
  gap: 0.5rem;
  margin-bottom: 0.5rem;
}
.kv-sig-kpis b {
  display: block;
  font-size: 1rem;
}
.kv-sig-kpis small {
  color: #949ba4;
  font-size: 0.65rem;
}
.kv-sig-tbl-wrap {
  overflow-x: auto;
}
.kv-sig-tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.78rem;
}
.kv-sig-tbl th,
.kv-sig-tbl td {
  padding: 0.35rem 0.4rem;
  border-bottom: 1px solid #404249;
  text-align: left;
}
.kv-sig-err {
  color: #f23f43;
}
.kv-sig-muted {
  color: #949ba4;
  font-size: 0.85rem;
}
</style>