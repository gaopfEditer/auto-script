<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  fetchKolvipBackfillStatus,
  fetchKolvipEvalSummary,
  pauseKolvipBackfill,
  startKolvipBackfillAll,
  startKolvipBackfillPilot,
  syncKolvipCatalog,
} from "../lib/kolvipApi.js";

defineOptions({ name: "KolvipBackfillPanel" });

const loading = ref(false);
const acting = ref(false);
const error = ref("");
const note = ref("");
const enabled = ref(false);
const shadow = ref(false);
const globalPaused = ref(false);
const catalogSyncedAt = ref("");
/** @type {import("vue").Ref<Record<string, any>>} */
const jobs = ref({});
/** @type {import("vue").Ref<Record<string, any>>} */
const config = ref({});
const curatedEval = ref(/** @type {any[]} */ ([]));
const candidateEval = ref(/** @type {any[]} */ ([]));
const pilotId = ref("16");
const filter = ref("all"); // all | curated | scan | active

/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null;

function statusCounts() {
  /** @type {Record<string, number>} */
  const c = { pending: 0, running: 0, done: 0, error: 0, paused: 0, other: 0 };
  for (const j of Object.values(jobs.value)) {
    const s = String(j?.status || "other");
    if (s in c) c[s] += 1;
    else c.other += 1;
  }
  return c;
}

const counts = computed(() => statusCounts());

const jobRows = computed(() => {
  const rows = Object.entries(jobs.value).map(([id, j]) => ({
    id,
    channelName: j?.channelName || `ch ${id}`,
    curated: !!j?.curated,
    status: String(j?.status || "—"),
    cardsCreated: Number(j?.cardsCreated) || 0,
    sampleCount: Number(j?.sampleCount) || 0,
    batchesDone: Number(j?.batchesDone) || 0,
    lastError: j?.lastError || null,
    updatedAt: j?.updatedAt || null,
    backfillCursor: j?.backfillCursor ?? null,
  }));
  rows.sort((a, b) => {
    const rank = { running: 0, error: 1, paused: 2, pending: 3, done: 4 };
    const ra = rank[a.status] ?? 9;
    const rb = rank[b.status] ?? 9;
    if (ra !== rb) return ra - rb;
    if (a.curated !== b.curated) return a.curated ? -1 : 1;
    return String(a.channelName).localeCompare(String(b.channelName), "zh");
  });
  return rows.filter((r) => {
    if (filter.value === "curated") return r.curated;
    if (filter.value === "scan") return !r.curated;
    if (filter.value === "active") return r.status === "running" || r.status === "pending" || r.status === "error";
    return true;
  });
});

const totals = computed(() => {
  let cards = 0;
  let samples = 0;
  for (const j of Object.values(jobs.value)) {
    cards += Number(j?.cardsCreated) || 0;
    samples += Number(j?.sampleCount) || 0;
  }
  return { cards, samples, jobs: Object.keys(jobs.value).length };
});

function fmtTime(iso) {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return d.toLocaleString("zh-CN", { hour12: false, timeZone: "Asia/Shanghai" });
}

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    const [st, ev] = await Promise.all([
      fetchKolvipBackfillStatus(),
      fetchKolvipEvalSummary({ days: Number(config.value?.days) || 30 }).catch(() => null),
    ]);
    enabled.value = !!st.enabled;
    shadow.value = !!st.shadow;
    globalPaused.value = !!st.globalPaused;
    catalogSyncedAt.value = st.catalogSyncedAt || "";
    jobs.value = st.jobs && typeof st.jobs === "object" ? st.jobs : {};
    config.value = st.config && typeof st.config === "object" ? st.config : {};
    if (ev) {
      curatedEval.value = ev.curated || [];
      candidateEval.value = ev.candidates || [];
      note.value = ev.note || "";
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

async function withAct(fn) {
  acting.value = true;
  error.value = "";
  try {
    await fn();
    await refresh();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    acting.value = false;
  }
}

function onSyncCatalog() {
  return withAct(() => syncKolvipCatalog());
}
function onStartAll() {
  return withAct(() => startKolvipBackfillAll());
}
function onPause() {
  return withAct(() => pauseKolvipBackfill());
}
function onStartPilot() {
  const id = String(pilotId.value || "").trim();
  if (!id) {
    error.value = "请填写 kolvip 频道 id（如 16）";
    return;
  }
  return withAct(() => startKolvipBackfillPilot(id));
}

onMounted(() => {
  void refresh();
  pollTimer = setInterval(() => void refresh(), 8000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div class="manual-stats kv-backfill-page">
    <header class="head">
      <div>
        <h1>巨鲸 kolvip 回溯</h1>
        <p>
          数据源 <code>kolvip.vip</code>（HTTP API）→ 建卡进
          <code>discord_signal_cards</code>，精选可跟单、全站备选仅评估。状态文件
          <code>data/kolvip-backfill.json</code>。胜率侧栏仍在
          <code>/show</code>。
        </p>
      </div>
    </header>

    <section class="panel">
      <div class="list-head">
        <h2>回溯控制</h2>
        <div class="filters control-row">
          <button type="button" class="btn" :disabled="loading || acting" @click="refresh">
            {{ loading ? "刷新中…" : "刷新状态" }}
          </button>
          <button type="button" class="btn" :disabled="acting" @click="onSyncCatalog">同步目录</button>
          <button type="button" class="btn primary" :disabled="acting || !enabled" @click="onStartAll">
            全站排队 start-all
          </button>
          <button type="button" class="btn danger" :disabled="acting" @click="onPause">全部暂停</button>
        </div>
        <div class="pilot-row">
          <label class="pilot-label">
            试点频道 id
            <input v-model="pilotId" class="pilot-input" :disabled="acting" placeholder="16" />
          </label>
          <button type="button" class="btn" :disabled="acting || !enabled" @click="onStartPilot">启动试点</button>
        </div>
      </div>

      <p v-if="error" class="warn">{{ error }}</p>
      <p v-if="!enabled" class="warn tiny">
        后端 <code>KOLVIP_BACKFILL_ENABLED</code> 未开或状态接口返回 enabled=false；请检查
        <code>discord-collector/.env</code> 后重启 <code>collect:ui</code>。
      </p>
      <p v-if="shadow" class="warn tiny">当前为 shadow 模式：只跑状态机，不真正 ingest。</p>
      <p v-if="globalPaused" class="run-banner">全局已暂停（globalPaused）</p>

      <div class="summary-grid">
        <div class="stat">
          <span class="stat-k">任务</span>
          <span class="stat-v">{{ totals.jobs }}</span>
        </div>
        <div class="stat">
          <span class="stat-k">running</span>
          <span class="stat-v">{{ counts.running }}</span>
        </div>
        <div class="stat">
          <span class="stat-k">pending</span>
          <span class="stat-v">{{ counts.pending }}</span>
        </div>
        <div class="stat">
          <span class="stat-k">done</span>
          <span class="stat-v">{{ counts.done }}</span>
        </div>
        <div class="stat">
          <span class="stat-k">cardsCreatedΣ</span>
          <span class="stat-v">{{ totals.cards }}</span>
        </div>
        <div class="stat">
          <span class="stat-k">sampleΣ</span>
          <span class="stat-v">{{ totals.samples }}</span>
        </div>
      </div>
      <p class="muted tiny">
        窗口 {{ config.days || 30 }} 天 · 批大小 {{ config.batchSize || "—" }} · 全站
        {{ config.allChannels ? "开" : "关" }} · 目录同步 {{ fmtTime(catalogSyncedAt) }}
      </p>
    </section>

    <section class="panel">
      <div class="list-head">
        <h2>频道任务</h2>
        <div class="filters control-row">
          <button
            v-for="opt in [
              { id: 'all', label: '全部' },
              { id: 'curated', label: '精选' },
              { id: 'scan', label: '全站备选' },
              { id: 'active', label: '进行中' },
            ]"
            :key="opt.id"
            type="button"
            class="btn tiny"
            :class="{ primary: filter === opt.id }"
            @click="filter = opt.id"
          >
            {{ opt.label }}
          </button>
        </div>
      </div>

      <div class="table-wrap">
        <table class="kv-table">
          <thead>
            <tr>
              <th>ch</th>
              <th>频道</th>
              <th>类型</th>
              <th>状态</th>
              <th>建卡</th>
              <th>采样</th>
              <th>批次</th>
              <th>更新(上海)</th>
              <th>错误</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in jobRows" :key="r.id">
              <td><code>{{ r.id }}</code></td>
              <td>{{ r.channelName }}</td>
              <td>{{ r.curated ? "精选" : "备选" }}</td>
              <td>
                <span class="pill" :class="r.status">{{ r.status }}</span>
              </td>
              <td>{{ r.cardsCreated }}</td>
              <td>{{ r.sampleCount }}</td>
              <td>{{ r.batchesDone }}</td>
              <td class="tiny">{{ fmtTime(r.updatedAt) }}</td>
              <td class="err tiny">{{ r.lastError || "—" }}</td>
            </tr>
            <tr v-if="!jobRows.length">
              <td colspan="9" class="muted">暂无任务。可先「同步目录」再「全站排队」或启动试点。</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="panel">
      <div class="list-head">
        <h2>胜率摘要（同 /show）</h2>
      </div>
      <p v-if="note" class="muted tiny">{{ note }}</p>
      <div class="eval-cols">
        <div>
          <h3 class="subh">精选</h3>
          <ul class="eval-list">
            <li v-for="row in curatedEval" :key="'c' + row.kolvipChannelId">
              <strong>{{ row.logicName }}</strong>
              <span class="muted">
                卡 {{ row.pushedCount || 0 }} ·
                <template v-if="row.metrics?.winRate != null">胜率 {{ row.metrics.winRate }}%</template>
                <template v-else>{{ row.displayState }}</template>
              </span>
            </li>
            <li v-if="!curatedEval.length" class="muted">暂无</li>
          </ul>
        </div>
        <div>
          <h3 class="subh">全站备选（节选）</h3>
          <ul class="eval-list">
            <li v-for="row in candidateEval.slice(0, 12)" :key="'a' + row.kolvipChannelId">
              <strong>{{ row.channelName || row.logicName }}</strong>
              <span class="muted">
                卡 {{ row.pushedCount || 0 }} ·
                <template v-if="row.metrics?.winRate != null">胜率 {{ row.metrics.winRate }}%</template>
                <template v-else>{{ row.displayState }}</template>
              </span>
            </li>
            <li v-if="!candidateEval.length" class="muted">暂无（多在扫描频道建卡后出现）</li>
          </ul>
        </div>
      </div>
    </section>
  </div>
</template>

<style scoped>
.kv-backfill-page {
  max-width: 1100px;
  margin: 0 auto;
  padding: 1rem 1.5rem 2.5rem;
  color: #dbdee1;
}
.head h1 {
  margin: 0 0 0.35rem;
  font-size: 1.35rem;
}
.head p {
  margin: 0;
  color: #949ba4;
  font-size: 0.9rem;
  line-height: 1.45;
}
.panel {
  margin-top: 1rem;
  padding: 1rem 1.1rem;
  border: 1px solid #404249;
  border-radius: 12px;
  background: #2b2d31;
}
.list-head {
  display: flex;
  flex-wrap: wrap;
  gap: 0.6rem 1rem;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 0.75rem;
}
.list-head h2 {
  margin: 0;
  font-size: 1.05rem;
}
.control-row,
.filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
  align-items: center;
}
.pilot-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
  width: 100%;
  margin-top: 0.35rem;
}
.pilot-label {
  display: inline-flex;
  gap: 0.4rem;
  align-items: center;
  font-size: 0.85rem;
  color: #b5bac1;
}
.pilot-input {
  width: 4.5rem;
  padding: 0.28rem 0.45rem;
  border-radius: 6px;
  border: 1px solid #404249;
  background: #1e1f22;
  color: #dbdee1;
}
.btn {
  border: 1px solid #404249;
  background: #1e1f22;
  color: #dbdee1;
  border-radius: 8px;
  padding: 0.38rem 0.7rem;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.btn.primary {
  background: #5865f2;
  border-color: #5865f2;
  color: #fff;
}
.btn.danger {
  background: #4a1d1f;
  border-color: #a12d37;
  color: #ffb4b8;
}
.btn.tiny {
  padding: 0.28rem 0.55rem;
  font-size: 0.8rem;
}
.summary-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
  gap: 0.5rem;
  margin: 0.75rem 0 0.5rem;
}
.stat {
  background: #1e1f22;
  border: 1px solid #404249;
  border-radius: 8px;
  padding: 0.55rem 0.65rem;
}
.stat-k {
  display: block;
  font-size: 0.72rem;
  color: #949ba4;
}
.stat-v {
  font-size: 1.15rem;
  font-weight: 700;
}
.table-wrap {
  overflow: auto;
}
.kv-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.86rem;
}
.kv-table th,
.kv-table td {
  text-align: left;
  padding: 0.45rem 0.5rem;
  border-bottom: 1px solid #3f4147;
  white-space: nowrap;
}
.kv-table th {
  color: #949ba4;
  font-weight: 600;
}
.pill {
  display: inline-block;
  padding: 0.12rem 0.45rem;
  border-radius: 999px;
  font-size: 0.75rem;
  font-weight: 700;
  background: #404249;
}
.pill.running {
  background: #3d4a1f;
  color: #c3e06a;
}
.pill.pending {
  background: #3a3d45;
  color: #c7ccd1;
}
.pill.done {
  background: #1f3d32;
  color: #6dd6a4;
}
.pill.error {
  background: #4a1d1f;
  color: #ffb4b8;
}
.warn {
  color: #f0b232;
  margin: 0.4rem 0;
}
.run-banner {
  margin: 0.5rem 0;
  padding: 0.55rem 0.7rem;
  border-radius: 8px;
  background: #3d4a1f;
  color: #e8f5b5;
}
.muted {
  color: #949ba4;
}
.tiny {
  font-size: 0.78rem;
}
.err {
  color: #ff8e95;
  max-width: 220px;
  white-space: normal;
}
.eval-cols {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}
@media (max-width: 800px) {
  .eval-cols {
    grid-template-columns: 1fr;
  }
}
.subh {
  margin: 0 0 0.4rem;
  font-size: 0.92rem;
}
.eval-list {
  list-style: none;
  margin: 0;
  padding: 0;
}
.eval-list li {
  display: flex;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.35rem 0;
  border-bottom: 1px solid #3f4147;
  font-size: 0.86rem;
}
code {
  font-size: 0.84em;
}
</style>
