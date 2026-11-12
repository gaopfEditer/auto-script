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

const open = defineModel("open", { type: Boolean, default: false });

const props = defineProps({
  /** @type {import('vue').PropType<{ chatId: string, name: string }[]>} */
  channels: { type: Array, default: () => [] },
});

const EVAL_WINDOWS = [
  { key: "month", label: "近一个月" },
  { key: "week", label: "七天" },
  { key: "all", label: "总计" },
];

const selectedChatId = ref("");
const params = ref({ ...DEFAULT_COPY_SIZING_PARAMS });
let paramsHydrating = false;
/** @type {import('vue').Ref<"month"|"week"|"all">} */
const replayWindow = ref("all");
const fetching = ref(false);
const fetchError = ref("");

/** @type {import('vue').Ref<Array<{ chatId: string, name: string, replayCount: number, suggestedNextPosition: number, cumulativeSimPnl: number, paramBrief?: string, steps: import("../../../src/telegram-copy-sizing.js").CopySizingReplayStep[], error?: string }>>} */
const groupResults = ref([]);

const expandedChatId = ref("");

const selectedChannelName = computed(() => {
  const hit = props.channels.find(
    (c) => c.chatId === selectedChatId.value || String(c.chatId) === selectedChatId.value,
  );
  return hit?.name || selectedChatId.value || "—";
});

function ensureSelectedChannel() {
  const list = props.channels.filter((c) => c?.chatId);
  if (!list.length) {
    selectedChatId.value = "";
    return;
  }
  const ok = list.some((c) => c.chatId === selectedChatId.value);
  if (!ok) selectedChatId.value = list[0].chatId;
}

function loadParamsForSelected() {
  paramsHydrating = true;
  params.value = selectedChatId.value
    ? loadCopySizingParamsForChat(selectedChatId.value)
  : { ...DEFAULT_COPY_SIZING_PARAMS };
  void nextTick(() => {
    paramsHydrating = false;
  });
}

watch(
  () => props.channels,
  () => {
    ensureSelectedChannel();
    loadParamsForSelected();
  },
  { immediate: true, deep: true },
);

watch(open, (v) => {
  if (v) {
    ensureSelectedChannel();
    loadParamsForSelected();
  }
});

watch(selectedChatId, () => {
  loadParamsForSelected();
});

watch(
  params,
  (v) => {
    if (paramsHydrating || !selectedChatId.value) return;
    saveCopySizingParamsForChat(selectedChatId.value, v);
  },
  { deep: true },
);

function restoreDefaults() {
  params.value = { ...DEFAULT_COPY_SIZING_PARAMS };
  if (selectedChatId.value) {
    saveCopySizingParamsForChat(selectedChatId.value, params.value);
  }
}

/** @param {string} chatId */
function focusChannelParams(chatId) {
  selectedChatId.value = chatId;
  expandedChatId.value = "";
}

function close() {
  open.value = false;
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

const summaryNote = computed(
  () =>
    "每个频道独立保存底仓/加减仓比例（localStorage）；回放按各群自己的参数递推。口径：任意 TP=赢、先 SL=亏；单笔模拟 ±100%×当时仓位（U）。",
);

async function fetchHistoricalBonus() {
  fetchError.value = "";
  groupResults.value = [];
  expandedChatId.value = "";
  const list = props.channels.filter((c) => c?.chatId);
  if (!list.length) {
    fetchError.value = "暂无群组可回放";
    return;
  }
  fetching.value = true;
  try {
    /** @type {typeof groupResults.value} */
    const out = [];
    if (selectedChatId.value) {
      saveCopySizingParamsForChat(selectedChatId.value, params.value);
    }
    await Promise.all(
      list.map(async (ch) => {
        const cfg = loadCopySizingParamsForChat(ch.chatId);
        try {
          const data = await fetchTelegramGroupEvalCards(ch.chatId, replayWindow.value);
          const replay = replayFromEvalCards(data.cards, cfg);
          out.push({
            chatId: ch.chatId,
            name: data.name || ch.name || ch.chatId,
            replayCount: replay.replayCount,
            suggestedNextPosition: replay.suggestedNextPosition,
            cumulativeSimPnl: replay.cumulativeSimPnl,
            paramBrief: formatCopySizingBrief(cfg),
            steps: replay.steps,
          });
        } catch (e) {
          out.push({
            chatId: ch.chatId,
            name: ch.name || ch.chatId,
            replayCount: 0,
            suggestedNextPosition: cfg.basePosition,
            cumulativeSimPnl: 0,
            paramBrief: formatCopySizingBrief(cfg),
            steps: [],
            error: String(/** @type {Error} */ (e).message ?? e),
          });
        }
      }),
    );
    out.sort((a, b) => String(a.name).localeCompare(String(b.name), "zh-CN"));
    groupResults.value = out;
  } catch (e) {
    fetchError.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    fetching.value = false;
  }
}

function toggleExpand(chatId) {
  expandedChatId.value = expandedChatId.value === chatId ? "" : chatId;
}

function stepOutcomeLabel(outcome) {
  return outcome === "win" ? "赢" : "亏";
}
</script>

<template>
  <div
    v-if="open"
    class="modal copy-sizing-modal"
    role="dialog"
    aria-modal="true"
    @click.self="close"
  >
    <div class="modal-card wide">
      <header>
        <div>
          <strong>跟单加成 · 历史回放</strong>
          <p class="muted tiny">每频道独立参数 · 本机 localStorage · 不触达实盘</p>
        </div>
        <button type="button" class="ghost" @click="close">关闭</button>
      </header>

      <section class="channel-pick" aria-label="编辑参数的频道">
        <label class="field channel-pick-field">
          <span>当前编辑频道</span>
          <select v-model="selectedChatId" :disabled="!channels.length">
            <option v-for="c in channels" :key="c.chatId" :value="c.chatId">{{ c.name }}</option>
          </select>
        </label>
        <p class="muted tiny channel-pick-hint">
          正在配置：<strong>{{ selectedChannelName }}</strong> 的底仓 / 加减仓（与其它频道互不影响）
        </p>
      </section>

      <section class="param-grid" aria-label="策略参数">
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
      </section>

      <section class="replay-actions">
        <label class="field">
          <span>回放周期</span>
          <select v-model="replayWindow">
            <option v-for="w in EVAL_WINDOWS" :key="w.key" :value="w.key">{{ w.label }}</option>
          </select>
        </label>
        <button type="button" :disabled="fetching" @click="fetchHistoricalBonus">
          {{ fetching ? "拉取中…" : "一键获取历史加成" }}
        </button>
        <button type="button" class="ghost" @click="restoreDefaults">恢复默认</button>
      </section>

      <p class="muted tiny algo-note">{{ summaryNote }}</p>
      <p v-if="fetchError" class="err">{{ fetchError }}</p>

      <div v-if="groupResults.length" class="result-table-wrap">
        <table class="result-table">
          <thead>
            <tr>
              <th>群组</th>
              <th>回放笔数</th>
              <th>建议下一单仓位</th>
              <th>模拟累计盈亏</th>
              <th>加成参数</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <template v-for="row in groupResults" :key="row.chatId">
              <tr
                class="result-row"
                :class="{ expanded: expandedChatId === row.chatId }"
                @click="toggleExpand(row.chatId)"
              >
                <td>
                  <strong>{{ row.name }}</strong>
                  <span v-if="row.error" class="err tiny"> · {{ row.error }}</span>
                </td>
                <td class="mono">{{ row.replayCount }}</td>
                <td class="mono">{{ formatU(row.suggestedNextPosition) }}</td>
                <td
                  class="mono"
                  :class="{
                    gain: row.cumulativeSimPnl > 0,
                    loss: row.cumulativeSimPnl < 0,
                  }"
                >
                  {{ formatPnlU(row.cumulativeSimPnl) }}
                </td>
                <td class="tiny param-brief-cell">
                  <span class="param-brief">{{ row.paramBrief || "—" }}</span>
                  <button
                    type="button"
                    class="link-btn"
                    @click.stop="focusChannelParams(row.chatId)"
                  >
                    改参数
                  </button>
                </td>
                <td class="tiny muted">{{ expandedChatId === row.chatId ? "收起" : "明细" }}</td>
              </tr>
              <tr v-if="expandedChatId === row.chatId" class="detail-row">
                <td colspan="6">
                  <h4 class="tiny">回放明细 · {{ row.name }}</h4>
                  <table class="detail-table">
                    <thead>
                      <tr>
                        <th>成交序</th>
                        <th>时间</th>
                        <th>币种</th>
                        <th>结果</th>
                        <th>本单仓位</th>
                        <th>模拟盈亏</th>
                        <th>累计</th>
                        <th>下一单仓位</th>
                      </tr>
                    </thead>
                    <tbody>
                      <tr v-for="(s, idx) in row.steps" :key="row.chatId + '-' + idx">
                        <td class="mono">{{ idx + 1 }}</td>
                        <td class="tiny">{{ settledLabel(s) }}</td>
                        <td class="mono">{{ s.symbol || "—" }}</td>
                        <td>{{ stepOutcomeLabel(s.outcome) }}</td>
                        <td class="mono">{{ formatU(s.position) }}</td>
                        <td
                          class="mono"
                          :class="{ gain: s.simulatedPnl > 0, loss: s.simulatedPnl < 0 }"
                        >
                          {{ formatPnlU(s.simulatedPnl) }}
                        </td>
                        <td class="mono">{{ formatPnlU(s.cumulativePnl) }}</td>
                        <td class="mono">{{ formatU(s.nextPosition) }}</td>
                      </tr>
                      <tr v-if="!row.steps.length">
                        <td colspan="8" class="empty-cell">该窗口无已决议单</td>
                      </tr>
                    </tbody>
                  </table>
                </td>
              </tr>
            </template>
          </tbody>
        </table>
      </div>
    </div>
  </div>
</template>

<style scoped>
/* 本组件独立挂载，不能依赖 TelegramPromView 的 scoped .modal */
.modal {
  position: fixed;
  inset: 0;
  z-index: 120;
  background: rgba(0, 0, 0, 0.62);
  display: grid;
  place-items: center;
  padding: 1rem;
}
.modal-card {
  width: min(520px, 100%);
  background: #2b2d31;
  border: 1px solid #4e5058;
  border-radius: 10px;
  padding: 0.85rem 1rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  color: #dbdee1;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
}
.modal-card header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
}
.modal-card strong {
  font-size: 1rem;
  color: #f2f3f5;
}
.copy-sizing-modal .modal-card.wide {
  width: min(960px, 96vw);
  max-width: min(960px, 96vw);
  max-height: min(90vh, 880px);
  overflow: auto;
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
  margin: 0.35rem 0 0;
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
.channel-pick {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  padding: 0.55rem 0.65rem;
  border-radius: 8px;
  border: 1px solid #404249;
  background: #232428;
}
.channel-pick-field {
  min-width: 12rem;
}
.channel-pick-hint {
  margin: 0;
}
.channel-pick-hint strong {
  color: #dee0fc;
}
.param-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 0.75rem 1rem;
  margin: 0.75rem 0;
}
.param-brief-cell {
  max-width: 11rem;
}
.param-brief {
  display: block;
  color: #b5bac1;
  line-height: 1.35;
}
.link-btn {
  margin-top: 0.2rem;
  padding: 0;
  border: none;
  background: none;
  color: #5865f2;
  font-size: 0.68rem;
  cursor: pointer;
}
.link-btn:hover {
  text-decoration: underline;
}
.replay-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-end;
  gap: 0.75rem 1rem;
  margin-bottom: 0.5rem;
}
.algo-note {
  margin: 0.25rem 0 0.75rem;
  line-height: 1.45;
}
.result-table-wrap {
  overflow: auto;
  border: 1px solid #383a40;
  border-radius: 8px;
}
.result-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.88rem;
}
.result-table th,
.result-table td {
  padding: 0.5rem 0.65rem;
  border-bottom: 1px solid #2e3035;
  text-align: left;
}
.result-table th {
  color: #9aa0a6;
  font-weight: 600;
  background: #25262a;
}
.result-row {
  cursor: pointer;
}
.result-row:hover {
  background: #2a2d33;
}
.result-row.expanded {
  background: #2c3140;
}
.detail-row td {
  background: #1e2128;
  padding: 0.75rem;
}
.detail-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.82rem;
}
.detail-table th,
.detail-table td {
  padding: 0.35rem 0.5rem;
  border-bottom: 1px solid #33363d;
}
.gain {
  color: #81c995;
}
.loss {
  color: #f28b82;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
}
.empty-cell {
  text-align: center;
  color: #9aa0a6;
  padding: 0.75rem;
}
</style>
