<script setup>
import { computed, nextTick, ref, watch } from "vue";
import { fetchTelegramGroupEvalCards } from "../lib/telegramGroupEvalApi.js";
import {
  DEFAULT_COPY_SIZING_PARAMS,
  formatCopySizingBrief,
  loadCopySizingParamsForChat,
  saveCopySizingParamsForChat,
} from "../lib/telegramCopySizingStorage.js";
import { replayFromEvalCards } from "../../../src/telegram-copy-sizing.js";

const props = defineProps({
  chatId: { type: String, required: true },
  channelName: { type: String, default: "" },
});

const EVAL_WINDOWS = [
  { key: "month", label: "近一个月" },
  { key: "week", label: "七天" },
  { key: "all", label: "总计" },
];

const params = ref({ ...DEFAULT_COPY_SIZING_PARAMS });
let paramsHydrating = false;
/** @type {import('vue').Ref<"month"|"week"|"all">} */
const replayWindow = ref("all");
const fetching = ref(false);
const fetchError = ref("");
/** @type {import('vue').Ref<{ replayCount: number, suggestedNextPosition: number, cumulativeSimPnl: number, steps: import("../../../src/telegram-copy-sizing.js").CopySizingReplayStep[] } | null>} */
const replay = ref(null);

const replayStepsDesc = computed(() => {
  const steps = replay.value?.steps;
  if (!Array.isArray(steps) || !steps.length) return [];
  return [...steps].reverse();
});

function loadParams() {
  if (!props.chatId) return;
  paramsHydrating = true;
  params.value = loadCopySizingParamsForChat(props.chatId);
  void nextTick(() => {
    paramsHydrating = false;
  });
}

watch(
  () => props.chatId,
  () => {
    replay.value = null;
    fetchError.value = "";
    loadParams();
  },
  { immediate: true },
);

watch(
  params,
  (v) => {
    if (paramsHydrating || !props.chatId) return;
    saveCopySizingParamsForChat(props.chatId, v);
  },
  { deep: true },
);

function restoreDefaults() {
  params.value = { ...DEFAULT_COPY_SIZING_PARAMS };
  saveCopySizingParamsForChat(props.chatId, params.value);
}

function trimDecimal(v, digits = 4) {
  const n = Number(v);
  if (!Number.isFinite(n)) return "—";
  return String(Number(n.toFixed(digits)));
}

function formatU(n) {
  const body = trimDecimal(n);
  if (body === "—") return "—";
  return `${body} U`;
}

function formatPnlU(n) {
  const v = Number(n);
  if (!Number.isFinite(v)) return "—";
  const sign = v >= 0 ? "+" : "";
  return `${sign}${trimDecimal(v)} U`;
}

function formatTime(raw) {
  const t = Date.parse(String(raw || ""));
  if (!Number.isFinite(t)) return String(raw || "—");
  return new Date(t).toLocaleString("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour12: false,
  });
}

function settledLabel(step) {
  if (step.settledAtMs > 0) {
    return new Date(step.settledAtMs).toLocaleString("zh-CN", {
      timeZone: "Asia/Shanghai",
      hour12: false,
    });
  }
  return formatTime(step.signalAt);
}

function stepOutcomeLabel(outcome) {
  return outcome === "win" ? "赢" : "亏";
}

async function fetchHistoricalBonus() {
  fetchError.value = "";
  replay.value = null;
  if (!props.chatId) {
    fetchError.value = "无效频道";
    return;
  }
  fetching.value = true;
  try {
    const cfg = saveCopySizingParamsForChat(props.chatId, params.value);
    const data = await fetchTelegramGroupEvalCards(props.chatId, replayWindow.value);
    replay.value = {
      ...replayFromEvalCards(data.cards, cfg),
      paramBrief: formatCopySizingBrief(cfg),
    };
  } catch (e) {
    fetchError.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    fetching.value = false;
  }
}
</script>

<template>
  <section class="copy-panel" aria-label="跟单加成回放">
    <header class="copy-panel-head">
      <div>
        <h3>跟单加成 · 历史回放</h3>
        <p class="muted tiny">本频道独立参数 · 本机 localStorage · 不触达实盘</p>
      </div>
    </header>

    <input type="hidden" :value="channelName" aria-hidden="true" />

    <p class="param-brief-line muted tiny" v-if="chatId">
      当前：{{ formatCopySizingBrief(params) }}
    </p>

    <div class="param-grid">
      <label class="field">
        <span>底仓（U）</span>
        <input v-model.number="params.basePosition" type="number" min="0.0001" step="0.1" />
      </label>
      <label class="field">
        <span>赢后下一单 × (1 + %)</span>
        <input v-model.number="params.winBumpPct" type="number" min="0" step="0.5" />
      </label>
      <label class="field">
        <span>亏后下一单 × (1 − %)</span>
        <input v-model.number="params.lossCutPct" type="number" min="0" max="100" step="0.5" />
      </label>
      <label class="field">
        <span>最低仓位（U）</span>
        <input v-model.number="params.minPosition" type="number" min="0.0001" step="0.1" />
      </label>
    </div>

    <div class="replay-actions">
      <label class="field">
        <span>回放周期</span>
        <select v-model="replayWindow">
          <option v-for="w in EVAL_WINDOWS" :key="w.key" :value="w.key">{{ w.label }}</option>
        </select>
      </label>
      <button type="button" :disabled="fetching" @click="fetchHistoricalBonus">
        {{ fetching ? "拉取中…" : "获取历史加成" }}
      </button>
      <button type="button" class="ghost" @click="restoreDefaults">恢复默认</button>
    </div>

    <p class="muted tiny algo-note">
      回放口径与群组评估一致；单笔模拟 ±100%×当时仓位（U），按本频道参数递推下一单仓位。
    </p>
    <p v-if="fetchError" class="err">{{ fetchError }}</p>

    <div v-if="replay" class="replay-summary">
      <span>回放 {{ replay.replayCount }} 笔</span>
      <span>建议下一单 <strong class="mono">{{ formatU(replay.suggestedNextPosition) }}</strong></span>
      <span
        >模拟累计
        <strong
          class="mono"
          :class="{
            gain: replay.cumulativeSimPnl > 0,
            loss: replay.cumulativeSimPnl < 0,
          }"
          >{{ formatPnlU(replay.cumulativeSimPnl) }}</strong
        ></span
      >
    </div>

    <div v-if="replay?.steps?.length" class="detail-table-wrap">
      <table class="detail-table">
        <thead>
          <tr>
            <th>#</th>
            <th>时间</th>
            <th>币种</th>
            <th>结果</th>
            <th>本单仓位</th>
            <th>模拟盈亏</th>
            <th>累计</th>
            <th>下一单</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(s, idx) in replayStepsDesc" :key="chatId + '-d-' + idx">
            <td class="mono">{{ replayStepsDesc.length - idx }}</td>
            <td class="tiny">{{ settledLabel(s) }}</td>
            <td class="mono">{{ s.symbol || "—" }}</td>
            <td :class="s.outcome === 'win' ? 'gain' : 'loss'">
              {{ stepOutcomeLabel(s.outcome) }}
            </td>
            <td class="mono">{{ formatU(s.position) }}</td>
            <td class="mono" :class="{ gain: s.simulatedPnl > 0, loss: s.simulatedPnl < 0 }">
              {{ formatPnlU(s.simulatedPnl) }}
            </td>
            <td
              class="mono"
              :class="{ gain: s.cumulativePnl > 0, loss: s.cumulativePnl < 0 }"
            >
              {{ formatPnlU(s.cumulativePnl) }}
            </td>
            <td class="mono">{{ formatU(s.nextPosition) }}</td>
          </tr>
        </tbody>
      </table>
    </div>
    <p v-else-if="replay && !replay.steps.length" class="muted tiny empty-hint">该窗口无已决议单</p>
  </section>
</template>

<style scoped>
.copy-panel {
  display: flex;
  flex-direction: column;
  gap: 0.55rem;
  padding: 0.75rem 0;
  border-top: 1px solid #383a40;
}
.copy-panel-head h3 {
  margin: 0;
  font-size: 0.92rem;
  color: #e8eaed;
}
.muted {
  margin: 0;
  color: #949ba4;
  font-size: 0.82rem;
  line-height: 1.45;
}
.tiny {
  font-size: 0.72rem;
}
.err {
  color: #f23f43;
  font-size: 0.85rem;
  margin: 0;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.25rem;
  min-width: 9rem;
  font-size: 0.72rem;
  color: #949ba4;
}
.field select,
.field input {
  border: 1px solid #4e5058;
  background: #1e1f22;
  color: #e8eaed;
  border-radius: 6px;
  padding: 0.35rem 0.5rem;
  font-size: 0.85rem;
}
button {
  border: 1px solid #4e5058;
  background: #383a40;
  color: #e8eaed;
  border-radius: 6px;
  padding: 0.35rem 0.7rem;
  font-size: 0.8rem;
  cursor: pointer;
}
button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
button.ghost {
  background: transparent;
}
.param-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 0.65rem 0.85rem;
}
.replay-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.65rem 0.85rem;
}
.algo-note {
  line-height: 1.45;
}
.replay-summary {
  display: flex;
  flex-wrap: wrap;
  gap: 0.65rem 1.25rem;
  font-size: 0.82rem;
  color: #b5bac1;
  padding: 0.45rem 0.55rem;
  border-radius: 8px;
  background: #1e1f22;
  border: 1px solid #404249;
}
.detail-table-wrap {
  overflow: auto;
  max-height: 38vh;
  border: 1px solid #383a40;
  border-radius: 8px;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: #5c5f66 #1e1f22;
}
.detail-table-wrap::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
.detail-table-wrap::-webkit-scrollbar-track {
  background: #1e1f22;
  border-radius: 8px;
}
.detail-table-wrap::-webkit-scrollbar-thumb {
  background: #5c5f66;
  border-radius: 8px;
  border: 2px solid #1e1f22;
}
.detail-table-wrap::-webkit-scrollbar-thumb:hover {
  background: #6d7178;
}
.detail-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}
.detail-table th,
.detail-table td {
  padding: 0.35rem 0.5rem;
  border-bottom: 1px solid #33363d;
  text-align: left;
}
.detail-table th {
  position: sticky;
  top: 0;
  background: #25262a;
  color: #9aa0a6;
  font-weight: 600;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.gain {
  color: #81c995;
}
.loss {
  color: #f28b82;
}
.empty-hint {
  margin: 0;
  text-align: center;
  padding: 0.5rem;
}
</style>
