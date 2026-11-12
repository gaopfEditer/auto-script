<script setup>
import { computed, ref, watch } from "vue";
import { fetchTelegramGroupEvalCards } from "../lib/telegramGroupEvalApi.js";
import {
  DEFAULT_COPY_SIZING_PARAMS,
  loadCopySizingParams,
  saveCopySizingParams,
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

const params = ref(loadCopySizingParams());
/** @type {import('vue').Ref<"month"|"week"|"all">} */
const replayWindow = ref("all");
const fetching = ref(false);
const fetchError = ref("");

/** @type {import('vue').Ref<Array<{ chatId: string, name: string, replayCount: number, suggestedNextPosition: number, cumulativeSimPnl: number, steps: import("../../../src/telegram-copy-sizing.js").CopySizingReplayStep[] }>>} */
const groupResults = ref([]);

const expandedChatId = ref("");

watch(
  params,
  (v) => {
    saveCopySizingParams(v);
  },
  { deep: true },
);

function restoreDefaults() {
  params.value = { ...DEFAULT_COPY_SIZING_PARAMS };
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
    "回放口径：与群组评估一致（任意 TP=赢、先 SL=亏、Asia/Shanghai 窗口）；单笔盈亏按 ±100% × 当时仓位（U），不使用卡片实际 pnl%。",
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
    const cfg = saveCopySizingParams(params.value);
    await Promise.all(
      list.map(async (ch) => {
        try {
          const data = await fetchTelegramGroupEvalCards(ch.chatId, replayWindow.value);
          const replay = replayFromEvalCards(data.cards, cfg);
          out.push({
            chatId: ch.chatId,
            name: data.name || ch.name || ch.chatId,
            replayCount: replay.replayCount,
            suggestedNextPosition: replay.suggestedNextPosition,
            cumulativeSimPnl: replay.cumulativeSimPnl,
            steps: replay.steps,
          });
        } catch (e) {
          out.push({
            chatId: ch.chatId,
            name: ch.name || ch.chatId,
            replayCount: 0,
            suggestedNextPosition: cfg.basePosition,
            cumulativeSimPnl: 0,
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
  <div v-if="open" class="modal copy-sizing-modal" role="dialog" aria-modal="true">
    <div class="modal-card wide">
      <header>
        <div>
          <strong>跟单加成 · 历史回放</strong>
          <p class="muted tiny">仅本机可见 · 配置存 localStorage · 不触达实盘下单</p>
        </div>
        <button type="button" class="ghost" @click="close">关闭</button>
      </header>

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
                <td class="tiny muted">{{ expandedChatId === row.chatId ? "收起" : "明细" }}</td>
              </tr>
              <tr v-if="expandedChatId === row.chatId" class="detail-row">
                <td colspan="5">
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
.copy-sizing-modal .modal-card.wide {
  max-width: min(960px, 96vw);
  max-height: min(90vh, 880px);
  overflow: auto;
}
.param-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(160px, 1fr));
  gap: 0.75rem 1rem;
  margin: 0.75rem 0;
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
