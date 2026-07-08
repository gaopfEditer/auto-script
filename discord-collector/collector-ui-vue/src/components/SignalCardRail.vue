<script setup>
import { ref, computed, watch, onMounted, reactive } from "vue";
import { RouterLink } from "vue-router";
import {
  fetchSignalCards,
  fetchSignalConfig,
  resendSignalTelegram,
  updateSignalCard,
  createSignalCard,
  formatCardTime,
} from "../lib/discordSignalApi.js";
import SignalEvaluationForm from "./SignalEvaluationForm.vue";
import {
  cardExecution,
  canTraceMessage,
  emptyExecution,
  outcomeLabel,
  takeProfitText,
  buildExecutionPayload,
  executionEquals,
  hasEvaluation,
  evaluationSummaryLines,
  seedActualFromPlanned,
  calcProfitPercents,
  formatProfitPercent,
} from "../lib/signalExecution.js";

const props = defineProps({
  channelId: { type: String, default: "" },
  guildId: { type: String, default: "" },
});

const emit = defineEmits(["cardUpdated", "cardsChange", "scrollToMessage"]);

const cards = ref(/** @type {import("../lib/discordSignalApi.js").SignalCard[]} */ ([]));
const styles = ref(/** @type {Record<string, { label: string }>} */ ({}));
const loading = ref(false);
const error = ref("");
const showManualForm = ref(false);
/** @type {Record<number, string>} */
const activeStyleByCard = ref({});
/** @type {Record<number, string>} */
const noteDraftById = ref({});
/** @type {Record<number, import("../lib/signalExecution.js").SignalExecution>} */
const executionDraftById = reactive({});
/** @type {Record<number, string>} */
const plannedTpTextById = ref({});
/** @type {Record<number, string>} */
const actualTpTextById = ref({});
/** @type {Record<number, ReturnType<typeof setTimeout>>} */
const saveTimers = {};
/** @type {Record<number, boolean>} */
const evalExpandedById = ref({});

const manualForm = ref({
  symbol: "",
  direction: "",
  plannedEntry: "",
  plannedTp: "",
  plannedSl: "",
  note: "",
});

const sortedCards = computed(() =>
  [...cards.value].sort((a, b) => Number(b.id) - Number(a.id))
);

const renderedCards = computed(() => {
  for (const c of sortedCards.value) ensureExecDraft(c);
  return sortedCards.value;
});

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function cloneExecDraft(card) {
  const ex = structuredClone(cardExecution(card));
  executionDraftById[card.id] = ex;
  plannedTpTextById.value[card.id] = takeProfitText(ex.planned);
  actualTpTextById.value[card.id] = takeProfitText(ex.actual);
}

function syncCardDrafts(list) {
  for (const c of list) {
    noteDraftById.value[c.id] = c.note ?? "";
    cloneExecDraft(c);
  }
}

async function loadConfig() {
  const cfg = await fetchSignalConfig();
  styles.value = cfg.styles ?? {};
}

async function reload() {
  if (!props.channelId) {
    cards.value = [];
    emit("cardsChange", []);
    return;
  }
  loading.value = true;
  error.value = "";
  try {
    cards.value = await fetchSignalCards(props.channelId);
    for (const c of cards.value) {
      if (!activeStyleByCard.value[c.id]) {
        const first = Object.keys(c.cardsByStyle ?? {})[0];
        if (first) activeStyleByCard.value[c.id] = first;
      }
    }
    syncCardDrafts(cards.value);
    emit("cardsChange", cards.value);
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    loading.value = false;
  }
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function cardStyleIds(card) {
  return Object.keys(card.cardsByStyle ?? {});
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function activeStyle(card) {
  return activeStyleByCard.value[card.id] ?? cardStyleIds(card)[0] ?? "";
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function cardBody(card) {
  const sid = activeStyle(card);
  return card.cardsByStyle?.[sid] ?? card.rawContent ?? "";
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function styleLabel(styleId) {
  return styles.value[styleId]?.label ?? styleId;
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function isExpired(card) {
  if (card.status === "expired") return true;
  if (!card.expiresAt) return false;
  return new Date(card.expiresAt).getTime() <= Date.now();
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function isActive(card) {
  return card.status === "active" && !isExpired(card);
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function ensureExecDraft(card) {
  if (!executionDraftById[card.id]) cloneExecDraft(card);
  if (noteDraftById.value[card.id] === undefined) {
    noteDraftById.value[card.id] = card.note ?? "";
  }
  return executionDraftById[card.id];
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function cardTitle(card) {
  const ex = cardExecution(card);
  if (ex.symbol) return ex.symbol.replace(/^\$/, "");
  const p = card.parsedJson;
  if (p && typeof p === "object") {
    const sym = String(/** @type {Record<string, unknown>} */ (p).symbol ?? /** @type {Record<string, unknown>} */ (p).asset ?? "").trim();
    if (sym) return sym.replace(/^\$/, "");
  }
  return `#${card.id}`;
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} updated */
function applyUpdated(updated) {
  const idx = cards.value.findIndex((c) => c.id === updated.id);
  if (idx >= 0) cards.value[idx] = updated;
  noteDraftById.value[updated.id] = updated.note ?? "";
  cloneExecDraft(updated);
  emit("cardUpdated", updated);
  emit("cardsChange", cards.value);
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function cardHasEvaluation(card) {
  const ex = cardExecution(card);
  return hasEvaluation(ex, card.note ?? "");
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function cardEvalProfit(card) {
  const ex = cardExecution(card);
  return calcProfitPercents(ex.actual.buyPrice, ex.actual.sellPrice, ex.direction);
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function cardEvalProfitBadge(card) {
  const profit = cardEvalProfit(card);
  if (!profit) return null;
  return {
    text: formatProfitPercent(profit.spot),
    gain: profit.spot > 0,
    loss: profit.spot < 0,
  };
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function cardEvalSummary(card) {
  return evaluationSummaryLines(cardExecution(card), card.note ?? "");
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function openEvalPanel(card) {
  ensureExecDraft(card);
  const draft = executionDraftById[card.id];
  seedActualFromPlanned(draft);
  actualTpTextById.value[card.id] = takeProfitText(draft.actual);
  evalExpandedById.value[card.id] = true;
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function toggleEvalPanel(card) {
  if (evalExpandedById.value[card.id]) {
    evalExpandedById.value[card.id] = false;
    return;
  }
  openEvalPanel(card);
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function scheduleSave(card) {
  const id = card.id;
  if (saveTimers[id]) clearTimeout(saveTimers[id]);
  saveTimers[id] = setTimeout(() => void saveCardFields(card), 500);
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
async function saveCardFields(card) {
  const draft = executionDraftById[card.id] ?? emptyExecution();
  const payload = buildExecutionPayload(draft, {
    plannedTp: plannedTpTextById.value[card.id] ?? "",
    actualTp: actualTpTextById.value[card.id] ?? "",
  });
  const note = String(noteDraftById.value[card.id] ?? "").trim();
  const prevEx = cardExecution(card);
  const prevNote = String(card.note ?? "").trim();
  if (executionEquals(payload, prevEx) && note === prevNote) return;
  try {
    const updated = await updateSignalCard(card.id, {
      note: note || null,
      execution: payload,
    });
    applyUpdated(updated);
    error.value = "";
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  }
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
async function toggleStatus(card) {
  const next = isActive(card) ? "expired" : "active";
  try {
    const updated = await updateSignalCard(card.id, { status: next });
    applyUpdated(updated);
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  }
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card @param {string} iso */
async function setExpiresAt(card, iso) {
  try {
    const updated = await updateSignalCard(card.id, {
      expiresAt: iso || null,
      status: iso && new Date(iso).getTime() <= Date.now() ? "expired" : card.status,
    });
    applyUpdated(updated);
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  }
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
async function pushTelegram(card) {
  try {
    await resendSignalTelegram(card.id, activeStyle(card));
    error.value = "";
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  }
}

/** @param {import("../lib/discordSignalApi.js").SignalCard} card */
function upsertCard(card) {
  const idx = cards.value.findIndex((c) => c.id === card.id);
  if (idx >= 0) cards.value[idx] = card;
  else cards.value.unshift(card);
  const first = Object.keys(card.cardsByStyle ?? {})[0];
  if (first) activeStyleByCard.value[card.id] = first;
  noteDraftById.value[card.id] = card.note ?? "";
  cloneExecDraft(card);
  emit("cardsChange", cards.value);
}

async function submitManualCard() {
  if (!props.channelId) return;
  const symbol = manualForm.value.symbol.trim();
  if (!symbol) {
    error.value = "请填写币种";
    return;
  }
  try {
    const created = await createSignalCard({
      channelId: props.channelId,
      guildId: props.guildId,
      symbol,
      direction: manualForm.value.direction.trim(),
      entryPrice: manualForm.value.plannedEntry.trim(),
      takeProfitPrices: manualForm.value.plannedTp.split(/[,，;\s]+/).map((s) => s.trim()).filter(Boolean),
      stopLossPrice: manualForm.value.plannedSl.trim(),
      execution: {
        symbol,
        direction: manualForm.value.direction.trim(),
        planned: {
          entryPrice: manualForm.value.plannedEntry.trim(),
          takeProfitPrices: manualForm.value.plannedTp.split(/[,，;\s]+/).map((s) => s.trim()).filter(Boolean),
          stopLossPrice: manualForm.value.plannedSl.trim(),
        },
        actual: {
          buyPrice: "",
          sellPrice: "",
          takeProfitPrices: [],
          stopLossPrice: "",
          exitPrice: "",
          closedAt: null,
        },
        outcome: "pending",
        outcomeNote: "",
      },
      note: manualForm.value.note.trim() || undefined,
    });
    upsertCard(created);
    manualForm.value = {
      symbol: "",
      direction: "",
      plannedEntry: "",
      plannedTp: "",
      plannedSl: "",
      note: "",
    };
    showManualForm.value = false;
    error.value = "";
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  }
}

defineExpose({ reload, upsertCard });

watch(() => props.channelId, () => void reload());

onMounted(async () => {
  await loadConfig();
  await reload();
});
</script>

<template>
  <aside class="signal-card-rail">
    <div class="signal-card-head">
      <span>信号卡片</span>
      <div class="signal-head-actions">
        <RouterLink to="/signals" class="signal-head-link" title="频道概览与历史">概览</RouterLink>
        <button type="button" class="signal-head-btn" @click="showManualForm = !showManualForm">
          {{ showManualForm ? "取消" : "+ 手动" }}
        </button>
      </div>
    </div>
    <div class="signal-card-scroll">
      <form v-if="showManualForm" class="signal-manual-form" @submit.prevent="submitManualCard">
        <div class="signal-field-row">
          <label>币种</label>
          <input v-model="manualForm.symbol" placeholder="BTC/USDT" required />
        </div>
        <div class="signal-field-row">
          <label>方向</label>
          <input v-model="manualForm.direction" placeholder="多 / 空" />
        </div>
        <fieldset class="signal-exec-block">
          <legend>计划</legend>
          <div class="signal-field-row">
            <label>入场</label>
            <input v-model="manualForm.plannedEntry" placeholder="入场价" />
          </div>
          <div class="signal-field-row">
            <label>止盈</label>
            <input v-model="manualForm.plannedTp" placeholder="多个用逗号分隔" />
          </div>
          <div class="signal-field-row">
            <label>止损</label>
            <input v-model="manualForm.plannedSl" placeholder="止损价" />
          </div>
        </fieldset>
        <div class="signal-field-row">
          <label>备注</label>
          <textarea v-model="manualForm.note" rows="2" placeholder="可选" />
        </div>
        <button type="submit" class="signal-act primary">创建卡片</button>
      </form>

      <p v-if="error" class="signal-card-err">{{ error }}</p>
      <p v-if="loading" class="signal-card-wait">加载卡片…</p>
      <p v-else-if="!sortedCards.length && !showManualForm" class="signal-card-wait">
        暂无卡片；监听到完整信号后将自动生成，或点击「+ 手动」创建。
      </p>

      <article
        v-for="card in renderedCards"
        :key="card.id"
        class="signal-card"
        :class="{ inactive: !isActive(card), manual: card.isManual }"
      >
        <header class="signal-card-top">
          <div class="signal-card-top-left">
            <span class="signal-card-symbol">{{ cardTitle(card) }}</span>
            <span class="signal-card-status" :class="isActive(card) ? 'on' : 'off'">
              {{ isActive(card) ? "有效" : "已失效" }}
            </span>
            <span v-if="card.isManual" class="signal-card-manual-tag">手动</span>
            <span
              v-if="cardExecution(card).outcome && cardExecution(card).outcome !== 'pending'"
              class="signal-card-outcome-tag"
            >{{ outcomeLabel(cardExecution(card).outcome) }}</span>
            <span v-else-if="cardHasEvaluation(card)" class="signal-card-eval-tags">
              <span class="signal-card-outcome-tag noted">已评价</span>
              <span
                v-if="cardEvalProfitBadge(card)"
                class="signal-card-profit-tag"
                :class="{ gain: cardEvalProfitBadge(card).gain, loss: cardEvalProfitBadge(card).loss }"
              >{{ cardEvalProfitBadge(card).text }}</span>
            </span>
          </div>
          <div class="signal-card-top-actions">
            <div
              class="signal-eval-wrap"
              :class="{ open: evalExpandedById[card.id], filled: cardHasEvaluation(card) }"
            >
              <button
                type="button"
                class="signal-eval-btn"
                :class="{ active: evalExpandedById[card.id] }"
                @click="toggleEvalPanel(card)"
              >评价</button>
              <div v-if="cardHasEvaluation(card) && !evalExpandedById[card.id]" class="signal-eval-popover">
                <p v-for="(line, i) in cardEvalSummary(card)" :key="i">{{ line }}</p>
              </div>
            </div>
            <button
              v-if="canTraceMessage(card)"
              type="button"
              class="signal-icon-btn"
              title="追溯原始消息"
              @click="emit('scrollToMessage', card.messageId)"
            >↗</button>
          </div>
        </header>
        <div class="signal-card-time">
          {{ formatCardTime(card) }}
        </div>

        <pre v-if="cardBody(card)" class="signal-card-body">{{ cardBody(card) }}</pre>

        <section v-if="evalExpandedById[card.id]" class="signal-eval-panel">
          <header class="signal-eval-panel-head">评价 / 实际成交</header>
          <SignalEvaluationForm
            v-if="executionDraftById[card.id]"
            v-model="executionDraftById[card.id]"
            v-model:actual-tp-text="actualTpTextById[card.id]"
            v-model:note="noteDraftById[card.id]"
            @change="scheduleSave(card)"
            @save="saveCardFields(card)"
          />
        </section>

        <div class="signal-card-actions">
          <button type="button" class="signal-act" @click="toggleStatus(card)">
            {{ isActive(card) ? "设为失效" : "恢复有效" }}
          </button>
          <button type="button" class="signal-act" title="推送到 Telegram" @click="pushTelegram(card)">TG</button>
        </div>
        <label class="signal-expire-row">
          <span>过期</span>
          <input
            type="datetime-local"
            :value="card.expiresAt ? card.expiresAt.slice(0, 16) : ''"
            @change="setExpiresAt(card, ($event.target).value ? new Date(($event.target).value).toISOString() : '')"
          />
          <button v-if="card.expiresAt" type="button" class="signal-act mini" @click="setExpiresAt(card, '')">清除</button>
        </label>
      </article>
    </div>
  </aside>
</template>

<style scoped>
@import "../styles/signal-card-theme.css";
.signal-head-actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
}
.signal-head-link {
  font-size: 0.65rem;
  color: #949ba4;
  text-decoration: none;
  padding: 0.15rem 0.35rem;
  border-radius: 4px;
  border: 1px solid #3f4147;
}
.signal-head-link:hover {
  color: #fff;
  border-color: #5865f2;
}
.signal-exec-block {
  border: 1px solid #3a3c42;
  border-radius: 6px;
  margin: 0.35rem 0;
  padding: 0.35rem 0.4rem 0.25rem;
  background: #25262a;
}
.signal-exec-block.actual {
  border-color: rgba(88, 101, 242, 0.35);
}
.signal-exec-block legend {
  font-size: 0.62rem;
  color: #949ba4;
  padding: 0 0.25rem;
}
.signal-eval-wrap {
  position: relative;
}
.signal-eval-btn {
  border: 1px solid #3f4147;
  background: #35373c;
  color: #dbdee1;
  font-size: 0.62rem;
  padding: 0.15rem 0.4rem;
  border-radius: 4px;
  cursor: pointer;
  font-weight: 600;
}
.signal-eval-btn:hover,
.signal-eval-btn.active {
  border-color: #5865f2;
  background: rgba(88, 101, 242, 0.18);
  color: #fff;
}
.signal-eval-wrap.filled .signal-eval-btn {
  border-color: rgba(73, 229, 122, 0.45);
  color: #49e57a;
}
.signal-eval-popover {
  display: none;
  position: absolute;
  right: 0;
  top: calc(100% + 4px);
  z-index: 20;
  min-width: 10rem;
  max-width: 14rem;
  padding: 0.4rem 0.5rem;
  background: #1e1f22;
  border: 1px solid #5865f2;
  border-radius: 6px;
  box-shadow: 0 4px 16px rgba(0, 0, 0, 0.45);
  pointer-events: none;
}
.signal-eval-popover p {
  margin: 0;
  font-size: 0.62rem;
  line-height: 1.45;
  color: #dbdee1;
  white-space: pre-wrap;
  word-break: break-word;
}
.signal-eval-popover p + p {
  margin-top: 0.15rem;
}
.signal-eval-wrap:hover:not(.open) .signal-eval-popover {
  display: block;
}
.signal-eval-panel {
  margin: 0.35rem 0 0.45rem;
  padding: 0.4rem 0.45rem 0.5rem;
  background: rgba(88, 101, 242, 0.08);
  border: 1px solid rgba(88, 101, 242, 0.35);
  border-radius: 6px;
}
.signal-eval-panel-head {
  font-size: 0.62rem;
  font-weight: 700;
  color: #949ba4;
  margin-bottom: 0.35rem;
}
.signal-card-eval-tags {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
}
.signal-card-profit-tag {
  font-size: 0.6rem;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  background: rgba(148, 155, 164, 0.15);
  color: #949ba4;
  font-weight: 600;
}
.signal-card-profit-tag.gain {
  background: rgba(73, 229, 122, 0.15);
  color: #49e57a;
}
.signal-card-profit-tag.loss {
  background: rgba(243, 134, 136, 0.15);
  color: #f38688;
}
</style>
