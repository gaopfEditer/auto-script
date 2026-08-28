<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import { subscribeCollectorSocket } from "../composables/useCollectorSocket.js";

const channelId = ref("");
const days = ref(7);
const fromIso = ref("");
const toIso = ref("");
const loading = ref(false);
const validating = ref(false);
const error = ref("");
const groups = ref(/** @type {{ main_monitored: string[], monitored: string[] }} */ ({
  main_monitored: [],
  monitored: [],
}));
const inspect = ref(/** @type {Record<string, unknown> | null} */ (null));
const selected = ref(/** @type {Set<string>} */ (new Set()));
const validateLog = ref(/** @type {string[]} */ ([]));
const jobId = ref("");

const cards = computed(() => {
  const list = inspect.value?.cards;
  return Array.isArray(list) ? list : [];
});

const signals = computed(() => {
  const list = inspect.value?.signals;
  return Array.isArray(list) ? list : [];
});

const selectedSignals = computed(() => {
  const all = signals.value;
  if (!selected.value.size) return all;
  return all.filter((s) => selected.value.has(String(s.id)));
});

function pushLog(line) {
  validateLog.value = [...validateLog.value.slice(-80), line];
}

async function loadGroups() {
  try {
    const r = await fetch("/api/telegram/prom/groups");
    const j = await r.json();
    if (j.ok) {
      groups.value = {
        main_monitored: j.main_monitored || [],
        monitored: j.monitored || [],
      };
    }
  } catch (e) {
    /* ignore */
  }
}

async function runInspect() {
  loading.value = true;
  error.value = "";
  inspect.value = null;
  selected.value = new Set();
  try {
    const body = {
      channelId: channelId.value.trim() || undefined,
      days: Number(days.value) || 7,
    };
    if (fromIso.value.trim()) body.from = new Date(fromIso.value).toISOString();
    if (toIso.value.trim()) body.to = new Date(toIso.value).toISOString();
    const r = await fetch("/api/telegram/prom/inspect", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    inspect.value = j;
    pushLog(
      `检查完成：卡片 ${j.total} 张（#prom ${j.promCount}）· signals ${j.signals?.length ?? 0}`,
    );
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    loading.value = false;
  }
}

function toggleSelect(id) {
  const next = new Set(selected.value);
  const key = String(id);
  if (next.has(key)) next.delete(key);
  else next.add(key);
  selected.value = next;
}

function selectAll() {
  selected.value = new Set(signals.value.map((s) => String(s.id)));
}

function clearSelect() {
  selected.value = new Set();
}

function useGroup(id) {
  channelId.value = String(id);
}

async function runValidate() {
  const list = selectedSignals.value;
  if (!list.length) {
    error.value = "没有可回测的 signals，请先检查并确保卡片有币种";
    return;
  }
  validating.value = true;
  error.value = "";
  jobId.value = "";
  pushLog(`启动回测：${list.length} 条…`);
  try {
    const r = await fetch("/api/cards/validate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        signals: list.map((s) => ({
          id: s.id,
          symbol: s.symbol,
          direction: s.direction,
          signalAt: s.signalAt,
          entry: s.entry,
          entryMode: s.entryMode,
        })),
      }),
    });
    const j = await r.json();
    if (!j.ok) throw new Error(j.error || `HTTP ${r.status}`);
    jobId.value = String(j.jobId || "");
    pushLog(`jobId=${j.jobId} mock=${j.mock} · 监听 WS card_validate_*`);
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    validating.value = false;
  }
}

/** @param {Record<string, unknown>} msg */
function onWs(msg) {
  if (msg.channel !== "meta") return;
  const kind = String(msg.kind ?? "");
  if (!kind.startsWith("card_validate")) return;
  if (jobId.value && msg.jobId && String(msg.jobId) !== jobId.value) return;
  if (kind === "card_validate_started") {
    pushLog(`回测开始 · 共 ${msg.total} 张`);
  } else if (kind === "card_validate_item") {
    const it = /** @type {Record<string, unknown>} */ (msg.item || {});
    pushLog(
      `  #${it.signalId || it.cardId} ${it.symbol} max=${it.maxProfitPct}% min=${it.minProfitPct}%`,
    );
  } else if (kind === "card_validate_done") {
    pushLog(`回测完成 · items=${Array.isArray(msg.items) ? msg.items.length : 0}`);
  } else if (kind === "card_validate_error") {
    pushLog(`回测失败：${msg.error}`);
  }
}

let unsub = /** @type {null | (() => void)} */ (null);
onMounted(() => {
  void loadGroups();
  unsub = subscribeCollectorSocket(onWs);
});
onUnmounted(() => {
  unsub?.();
});
</script>

<template>
  <div class="tg-page">
    <header class="tg-head">
      <h1>Telegram · #prom</h1>
      <p class="muted">
        检查群组频道卡片（按 id / 时间），再发起历史回测。实时 #prom 建卡由
        <code>telegram/listen.py</code> 监听并 POST 卡片 API；10 分钟内补充消息合并同一张卡。
      </p>
    </header>

    <section class="tg-panel">
      <h2>监听群配置</h2>
      <div class="chips" v-if="groups.main_monitored.length || groups.monitored.length">
        <button
          v-for="id in groups.main_monitored"
          :key="'m' + id"
          type="button"
          class="chip main"
          @click="useGroup(id)"
        >
          主群 {{ id }}
        </button>
        <button
          v-for="id in groups.monitored"
          :key="'o' + id"
          type="button"
          class="chip"
          @click="useGroup(id)"
        >
          {{ id }}
        </button>
      </div>
      <p v-else class="muted">未读到 monitored_groups.txt，可手动填 channelId。</p>
    </section>

    <section class="tg-panel">
      <h2>检查范围</h2>
      <div class="row">
        <label>
          频道 / 群 channelId
          <input v-model="channelId" placeholder="-100xxxxxxxxxx 或 profile 映射 id" />
        </label>
        <label>
          近 N 天
          <input v-model.number="days" type="number" min="1" max="90" />
        </label>
        <label>
          from（可选）
          <input v-model="fromIso" type="datetime-local" />
        </label>
        <label>
          to（可选）
          <input v-model="toIso" type="datetime-local" />
        </label>
      </div>
      <div class="actions">
        <button type="button" class="primary" :disabled="loading" @click="runInspect">
          {{ loading ? "检查中…" : "检查卡片" }}
        </button>
        <button
          type="button"
          class="primary"
          :disabled="validating || !signals.length"
          @click="runValidate"
        >
          {{ validating ? "回测中…" : `回测 ${selectedSignals.length || 0} 条` }}
        </button>
        <button type="button" :disabled="!signals.length" @click="selectAll">全选 signals</button>
        <button type="button" :disabled="!selected.size" @click="clearSelect">清空选择</button>
      </div>
      <p v-if="error" class="err">{{ error }}</p>
    </section>

    <section v-if="inspect" class="tg-panel">
      <h2>
        结果 · {{ inspect.total }} 卡 · #prom {{ inspect.promCount }} · signals
        {{ signals.length }}
      </h2>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th></th>
              <th>id</th>
              <th>币种</th>
              <th>方向</th>
              <th>时间</th>
              <th>频道</th>
              <th>备注</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in cards" :key="c.id">
              <td>
                <input
                  type="checkbox"
                  :checked="selected.has(String(c.id))"
                  @change="toggleSelect(c.id)"
                />
              </td>
              <td class="mono">{{ c.id }}</td>
              <td>{{ c.symbol || "—" }}</td>
              <td>{{ c.execution?.direction || "—" }}</td>
              <td class="mono">{{ String(c.signalAt || c.createdAt || "").slice(0, 19) }}</td>
              <td>{{ c.channelName || c.channelId }}</td>
              <td class="note">{{ c.note || "" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section class="tg-panel">
      <h2>回测日志</h2>
      <pre class="log">{{ validateLog.join("\n") || "（尚未运行）" }}</pre>
    </section>
  </div>
</template>

<style scoped>
.tg-page {
  height: 100%;
  overflow: auto;
  padding: 1rem 1.25rem 2rem;
  color: #dbdee1;
  background: #1e1f22;
}
.tg-head h1 {
  margin: 0 0 0.35rem;
  font-size: 1.25rem;
}
.muted {
  color: #949ba4;
  font-size: 0.85rem;
  margin: 0;
}
.tg-panel {
  margin-top: 1rem;
  padding: 0.85rem 1rem;
  border: 1px solid #3f4147;
  border-radius: 10px;
  background: #2b2d31;
}
.tg-panel h2 {
  margin: 0 0 0.65rem;
  font-size: 0.95rem;
}
.row {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
  gap: 0.65rem;
}
label {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  font-size: 0.78rem;
  color: #b5bac1;
}
input {
  border: 1px solid #4e5058;
  background: #1e1f22;
  color: #e8eaed;
  border-radius: 6px;
  padding: 0.4rem 0.55rem;
  font-size: 0.85rem;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  margin-top: 0.75rem;
}
button {
  border: 1px solid #4e5058;
  background: #383a40;
  color: #e8eaed;
  border-radius: 6px;
  padding: 0.4rem 0.75rem;
  font-size: 0.82rem;
  cursor: pointer;
}
button.primary {
  background: #5865f2;
  border-color: #5865f2;
}
button:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.err {
  color: #f23f43;
  margin: 0.5rem 0 0;
  font-size: 0.85rem;
}
.chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.chip {
  font-size: 0.75rem;
  font-family: ui-monospace, monospace;
}
.chip.main {
  border-color: #5865f2;
  color: #c9cdfb;
}
.table-wrap {
  overflow: auto;
  max-height: 360px;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}
th,
td {
  border-bottom: 1px solid #3f4147;
  padding: 0.35rem 0.45rem;
  text-align: left;
}
.mono {
  font-family: ui-monospace, monospace;
  font-size: 0.75rem;
}
.note {
  max-width: 220px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  color: #949ba4;
}
.log {
  margin: 0;
  max-height: 220px;
  overflow: auto;
  font-size: 0.75rem;
  line-height: 1.45;
  color: #b5bac1;
  white-space: pre-wrap;
}
code {
  font-size: 0.8em;
  color: #c9cdfb;
}
</style>
