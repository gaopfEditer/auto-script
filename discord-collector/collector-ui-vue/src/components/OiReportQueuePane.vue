<script setup>
import { computed, onMounted, ref, watch } from "vue";
import { fetchOiReportQueue } from "../lib/oiReportQueueApi.js";

defineOptions({ name: "OiReportQueuePane" });

const props = defineProps({
  /** 侧栏预览刷新时由父组件递增 */
  reloadToken: { type: Number, default: 0 },
});

const emit = defineEmits(["loaded", "error"]);

const loading = ref(true);
const error = ref("");
const offline = ref(false);
const payload = ref(/** @type {Awaited<ReturnType<typeof fetchOiReportQueue>> | null} */ (null));
const expandedId = ref("");

const reports = computed(() => {
  const data = payload.value;
  if (!data) return [];
  /** @type {import('../lib/oiReportQueueApi.js').OiReportQueueReport[]} */
  const list = [];
  if (data.pending && data.pending.itemCount) list.push(data.pending);
  for (const r of data.reports || []) list.push(r);
  return list;
});

const selected = computed(() => {
  const id = expandedId.value;
  return reports.value.find((r) => r.id === id) || reports.value[0] || null;
});

async function load() {
  loading.value = !payload.value;
  error.value = "";
  try {
    const data = await fetchOiReportQueue({ limit: 96 });
    payload.value = data;
    offline.value = data.oiOnline === false;
    if (!expandedId.value) {
      expandedId.value = data.pending?.id || data.reports?.[0]?.id || "";
    }
    emit("loaded", data);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    error.value = msg;
    offline.value = /未能连接|fetch|503|oi_mornitor|未启动/i.test(msg);
    emit("error", msg);
  } finally {
    loading.value = false;
  }
}

function selectReport(id) {
  expandedId.value = id;
}

watch(() => props.reloadToken, () => {
  void load();
});

onMounted(() => {
  void load();
});
</script>

<template>
  <div class="oi-rq-pane">
    <p v-if="loading" class="oi-rq-status">加载报告队列…</p>
    <p v-else-if="error" class="oi-rq-status err">
      {{ error }}
      <span v-if="offline">（/oi 服务当前不可达，部署到本机并启动后才会有实盘数据）</span>
    </p>
    <p v-else-if="!reports.length" class="oi-rq-status">
      近窗暂无形态或 OI/持仓量异常。有信号时会每 5 分钟生成一份报告，空窗不会占位。
    </p>
    <div v-else class="oi-rq-body">
      <aside class="oi-rq-list">
        <button
          v-for="r in reports"
          :key="r.id"
          type="button"
          class="oi-rq-list-item"
          :class="{ active: selected?.id === r.id, pending: r.pending }"
          @click="selectReport(r.id)"
        >
          <span class="oi-rq-list-time">
            <span v-if="r.windowDateLabel" class="oi-rq-list-date">{{ r.windowDateLabel }}</span>
            {{ r.windowLabel }}
            <span v-if="r.pending" class="oi-rq-pending-tag">进行中</span>
          </span>
          <span class="oi-rq-list-preview">{{ r.preview || `${r.itemCount} 条` }}</span>
        </button>
      </aside>
      <section v-if="selected" class="oi-rq-detail">
        <header class="oi-rq-detail-head">
          <h2>
            {{ selected.windowDateLabel }} {{ selected.windowLabel }}
            <span v-if="selected.pending" class="oi-rq-pending-tag">进行中</span>
          </h2>
          <p>{{ selected.itemCount }} 条 · 周期最低 5m · 时区 UTC+8</p>
        </header>
        <div class="oi-rq-table-wrap">
          <table class="oi-rq-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>币种</th>
                <th>周期</th>
                <th>方向</th>
                <th>形态</th>
                <th>是否放量</th>
                <th>OI/持仓量异常</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="item in selected.items" :key="item.id">
                <td class="mono" :title="item.dateLabel">{{ item.timeLabel }}</td>
                <td class="sym">{{ item.symbol }}</td>
                <td>{{ item.interval }}</td>
                <td :class="item.side === 'bull' ? 'side-bull' : item.side === 'bear' ? 'side-bear' : ''">
                  {{ item.sideLabel || "—" }}
                </td>
                <td>{{ item.pattern || "—" }}</td>
                <td :class="{ 'vol-yes': item.volumeSurge === 'yes', 'vol-unknown': item.volumeSurge === 'unknown' }">
                  {{ item.volumeSurgeLabel || "未知" }}
                  <span v-if="item.volumeRatio != null" class="vol-ratio">{{ Number(item.volumeRatio).toFixed(2) }}x</span>
                </td>
                <td>
                  <span v-if="item.oiAnomaly" class="oi-flag">
                    是
                    <span v-if="item.oiHistoric">（历史级）</span>
                    <span v-if="item.oiWindows?.length" class="oi-windows">{{ item.oiWindows.join("/") }}</span>
                  </span>
                  <span v-else class="muted">否</span>
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.oi-rq-pane {
  display: flex;
  flex-direction: column;
  min-height: 100%;
  color: var(--text, #dbdee1);
  padding: 0.4rem 0.6rem 1rem;
}
.oi-rq-status {
  margin: 1.2rem 0.6rem;
  color: #b5bac1;
  font-size: 0.9rem;
  line-height: 1.5;
}
.oi-rq-status.err {
  color: #f23f43;
}
.oi-rq-body {
  display: grid;
  grid-template-columns: minmax(160px, 220px) 1fr;
  gap: 0.75rem;
  min-height: 0;
  flex: 1;
}
.oi-rq-list {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  overflow: auto;
  min-height: 0;
  padding-right: 0.15rem;
}
.oi-rq-list-item {
  display: flex;
  flex-direction: column;
  gap: 0.15rem;
  text-align: left;
  border: none;
  background: transparent;
  color: #b5bac1;
  border-radius: 6px;
  padding: 0.45rem 0.5rem;
  cursor: pointer;
}
.oi-rq-list-item:hover {
  background: #35373c;
  color: #fff;
}
.oi-rq-list-item.active {
  background: #3f4248;
  color: #fff;
}
.oi-rq-list-time {
  font-size: 0.82rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
  display: flex;
  flex-wrap: wrap;
  gap: 0.3rem;
  align-items: center;
}
.oi-rq-list-date {
  color: #8b919a;
  font-weight: 500;
}
.oi-rq-list-preview {
  font-size: 0.72rem;
  color: #8b919a;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.oi-rq-pending-tag {
  font-size: 0.65rem;
  font-weight: 700;
  color: #faa61a;
  letter-spacing: 0.02em;
}
.oi-rq-detail {
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.6rem;
}
.oi-rq-detail-head h2 {
  margin: 0;
  font-size: 1rem;
  font-weight: 650;
  display: flex;
  gap: 0.4rem;
  align-items: center;
}
.oi-rq-detail-head p {
  margin: 0.2rem 0 0;
  color: #8b919a;
  font-size: 0.75rem;
}
.oi-rq-table-wrap {
  overflow: auto;
  border: 1px solid #2b2d31;
  border-radius: 8px;
}
.oi-rq-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}
.oi-rq-table th,
.oi-rq-table td {
  padding: 0.4rem 0.55rem;
  text-align: left;
  border-bottom: 1px solid #2b2d31;
  vertical-align: top;
}
.oi-rq-table th {
  font-size: 0.7rem;
  color: #8b919a;
  font-weight: 650;
  letter-spacing: 0.03em;
  background: #2b2d31;
  position: sticky;
  top: 0;
}
.oi-rq-table tr:last-child td {
  border-bottom: none;
}
.mono {
  font-variant-numeric: tabular-nums;
  color: #b5bac1;
}
.sym {
  font-weight: 650;
}
.side-bull {
  color: #3ba55d;
}
.side-bear {
  color: #f23f43;
}
.vol-yes {
  color: #faa61a;
}
.vol-unknown,
.muted {
  color: #8b919a;
}
.vol-ratio {
  margin-left: 0.25rem;
  color: #8b919a;
  font-variant-numeric: tabular-nums;
}
.oi-flag {
  color: #ed4245;
  font-weight: 650;
}
.oi-windows {
  margin-left: 0.25rem;
  color: #b5bac1;
  font-weight: 500;
}
@media (max-width: 860px) {
  .oi-rq-body {
    grid-template-columns: 1fr;
  }
  .oi-rq-list {
    max-height: 160px;
    flex-direction: row;
    overflow-x: auto;
  }
  .oi-rq-list-item {
    min-width: 160px;
  }
}
</style>
