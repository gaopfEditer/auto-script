<script setup>
import { ref, computed, onMounted, watch, onUnmounted } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import SignalCardItem from "../components/SignalCardItem.vue";
import SignalEvaluationForm from "../components/SignalEvaluationForm.vue";
import {
  fetchArchiveCard,
  fetchArchiveCards,
  fetchCardChannels,
  fetchCardSources,
  buildArchivePeriodQuery,
} from "../lib/cardArchiveApi.js";
import { updateSignalCard, fetchSignalConfig, compareCardsByTimeDesc } from "../lib/discordSignalApi.js";
import { useNewCardNotifications } from "../composables/useNewCardNotifications.js";
import {
  cardExecution,
  formatPlannedSummary,
  emptyExecution,
  buildExecutionPayload,
  executionEquals,
  seedActualFromPlanned,
  takeProfitText,
  hasEvaluation,
} from "../lib/signalExecution.js";
import { resolveCardSourceLink } from "../lib/cardSourceLink.js";

const SOURCE_OPTIONS = [
  { value: "", label: "全部来源" },
  { value: "discord", label: "Discord" },
  { value: "youtube", label: "YouTube" },
  { value: "api", label: "外部 API" },
  { value: "manual", label: "手动" },
];

const PERIOD_OPTIONS = [
  { value: "today", label: "今天" },
  { value: 2, label: "近 2 天" },
  { value: 7, label: "近一周" },
  { value: 30, label: "近 30 天" },
  { value: 90, label: "近 90 天" },
  { value: 0, label: "全部" },
];

const route = useRoute();
const router = useRouter();
const { toasts: newCardToasts } = useNewCardNotifications();

const source = ref("");
const channelId = ref("");
const symbol = ref("");
const period = ref(/** @type {string | number} */ ("today"));
const loading = ref(false);
const error = ref("");
const cards = ref(/** @type {import("../lib/cardArchiveApi.js").ArchiveCard[]} */ ([]));
const selectedId = ref(0);
const sources = ref(/** @type {string[]} */ ([]));
const channelOptions = ref(/** @type {import("../lib/cardArchiveApi.js").ArchiveChannelOption[]} */ ([]));

const selected = computed(() => cards.value.find((c) => c.id === selectedId.value) ?? null);
const selectedSourceLink = computed(() =>
  selected.value ? resolveCardSourceLink(selected.value) : null
);
const modalOpen = computed(() => selectedId.value > 0 && !!selected.value);

const execDraft = ref(emptyExecution());
const noteDraft = ref("");
const actualTpText = ref("");
const evalSaving = ref(false);
const evalError = ref("");
/** @type {Record<number, ReturnType<typeof setTimeout>>} */
const saveTimers = {};

const HIDE_KOL_KEY = "dc_archive_hide_kol";
const hideKolName = ref(false);
try {
  hideKolName.value = localStorage.getItem(HIDE_KOL_KEY) === "1";
} catch {
  /* ignore */
}

function toggleHideKol() {
  hideKolName.value = !hideKolName.value;
  try {
    localStorage.setItem(HIDE_KOL_KEY, hideKolName.value ? "1" : "0");
  } catch {
    /* ignore */
  }
}

const groupedBySource = computed(() => {
  /** @type {Record<string, number>} */
  const m = {};
  for (const c of cards.value) {
    const k = c.sourceType || "unknown";
    m[k] = (m[k] ?? 0) + 1;
  }
  return m;
});

function periodQuery() {
  return buildArchivePeriodQuery(period.value);
}

/** @param {unknown} v */
function fmtTime(v) {
  if (!v) return "—";
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString("zh-CN", { hour12: false });
}

function closeModal() {
  selectedId.value = 0;
}

/** @param {import("../lib/cardArchiveApi.js").ArchiveCard} card */
function initEvalDraft(card) {
  execDraft.value = structuredClone(cardExecution(card));
  seedActualFromPlanned(execDraft.value);
  actualTpText.value = takeProfitText(execDraft.value.actual);
  noteDraft.value = card.note ?? "";
  evalError.value = "";
}

/** @param {import("../lib/cardArchiveApi.js").ArchiveCard} updated */
function applyCardUpdate(updated) {
  const idx = cards.value.findIndex((c) => c.id === updated.id);
  if (idx >= 0) cards.value[idx] = updated;
  else cards.value.push(updated);
  cards.value.sort(compareCardsByTimeDesc);
  if (selectedId.value === updated.id) initEvalDraft(updated);
}

/** @param {import("../lib/cardArchiveApi.js").ArchiveCard} card */
async function saveEvaluation(card) {
  const payload = buildExecutionPayload(execDraft.value, { actualTp: actualTpText.value });
  const note = String(noteDraft.value ?? "").trim();
  const prevEx = cardExecution(card);
  const prevNote = String(card.note ?? "").trim();
  if (executionEquals(payload, prevEx) && note === prevNote) return;

  evalSaving.value = true;
  evalError.value = "";
  try {
    await updateSignalCard(card.id, { note: note || null, execution: payload });
    const fresh = await fetchArchiveCard(card.id);
    applyCardUpdate(fresh);
  } catch (e) {
    evalError.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    evalSaving.value = false;
  }
}

/** @param {import("../lib/cardArchiveApi.js").ArchiveCard} card */
function scheduleSave(card) {
  const id = card.id;
  if (saveTimers[id]) clearTimeout(saveTimers[id]);
  saveTimers[id] = setTimeout(() => void saveEvaluation(card), 500);
}

/** @param {import("../lib/cardArchiveApi.js").ArchiveCard} card */
function openCard(card) {
  selectedId.value = card.id;
  initEvalDraft(card);
}

/** @param {KeyboardEvent} e */
function onKeydown(e) {
  if (e.key === "Escape" && modalOpen.value) closeModal();
}

async function loadChannels() {
  try {
    channelOptions.value = await fetchCardChannels({
      source: source.value || undefined,
      symbol: symbol.value.trim() || undefined,
      ...periodQuery(),
    });
    if (channelId.value && !channelOptions.value.some((c) => c.channelId === channelId.value)) {
      channelId.value = "";
    }
  } catch {
    channelOptions.value = [];
  }
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const data = await fetchArchiveCards({
      source: source.value || undefined,
      channelId: channelId.value || undefined,
      symbol: symbol.value.trim() || undefined,
      limit: 200,
      ...periodQuery(),
    });
    cards.value = data.cards;
    cards.value.sort(compareCardsByTimeDesc);
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    loading.value = false;
  }
}

async function reload() {
  await loadChannels();
  await load();
}

/** @param {number} id */
async function openCardById(id) {
  if (!Number.isFinite(id) || id <= 0) return;
  if (!cards.value.some((c) => c.id === id)) {
    try {
      const card = await fetchArchiveCard(id);
      cards.value = [card, ...cards.value.filter((c) => c.id !== id)].sort(compareCardsByTimeDesc);
    } catch {
      return;
    }
  }
  selectedId.value = id;
}

async function applyOpenQuery() {
  const raw = route.query.open;
  const id = Number(Array.isArray(raw) ? raw[0] : raw);
  if (!Number.isFinite(id) || id <= 0) return;
  await openCardById(id);
  const q = { ...route.query };
  delete q.open;
  void router.replace({ query: q });
}

watch(
  () => selected.value?.id ?? 0,
  (id) => {
    const card = selected.value;
    if (id > 0 && card) initEvalDraft(card);
  }
);

watch([source, symbol, period], () => void reload());
watch(channelId, () => void load());
watch(
  () => route.query.open,
  () => {
    void applyOpenQuery();
  }
);
watch(
  () => newCardToasts.value[0]?.cardId ?? 0,
  (cardId, prev) => {
    if (cardId && cardId !== prev) void reload();
  }
);

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  try {
    await fetchSignalConfig();
  } catch {
    /* ignore */
  }
  try {
    sources.value = await fetchCardSources();
  } catch {
    /* ignore */
  }
  await reload();
  await applyOpenQuery();
});

onUnmounted(() => {
  window.removeEventListener("keydown", onKeydown);
});
</script>

<template>
  <div class="cards-page">
    <aside class="filters">
      <div class="head">
        <h2>卡片归档</h2>
        <RouterLink to="/signals" class="link">Discord 信号频道 →</RouterLink>
      </div>
      <p class="hint">统一归档 Discord / YouTube / API 卡片，支持按来源、发车频道、币种、时间筛选。</p>

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
      <label class="field">
        <span>时间</span>
        <select v-model="period">
          <option v-for="p in PERIOD_OPTIONS" :key="String(p.value)" :value="p.value">{{ p.label }}</option>
        </select>
      </label>
      <button type="button" class="btn" :disabled="loading" @click="reload">刷新</button>

      <div v-if="Object.keys(groupedBySource).length" class="stats">
        <div v-for="(n, k) in groupedBySource" :key="k">{{ k }}: {{ n }}</div>
      </div>
      <p v-if="error" class="err">{{ error }}</p>
    </aside>

    <section class="grid-panel">
      <div class="grid-head">
        <span class="grid-count">{{ loading ? "加载中…" : `共 ${cards.length} 张卡片` }}</span>
        <button
          type="button"
          class="btn hide-kol-btn"
          :class="{ on: hideKolName }"
          :title="hideKolName ? '显示 KOL 名称' : '隐藏 KOL 名称'"
          @click="toggleHideKol"
        >
          {{ hideKolName ? "显示 KOL" : "隐藏 KOL" }}
        </button>
      </div>
      <p v-if="!loading && cards.length === 0" class="muted empty-hint">暂无卡片</p>
      <div v-else class="card-grid">
        <SignalCardItem
          v-for="c in cards"
          :key="c.id"
          :card="c"
          show-channel
          :hide-kol-name="hideKolName"
          clickable
          @click="openCard(c)"
        />
      </div>
    </section>

    <Teleport to="body">
      <div v-if="modalOpen && selected" class="modal-backdrop" @click.self="closeModal">
        <div class="modal-panel" role="dialog" aria-modal="true">
          <header class="modal-head">
            <h3>
              <span v-if="selected.uid || selected.id" class="modal-card-id">{{ selected.uid || `SC-${selected.id}` }}</span>
              {{ selected.cardFields?.title || "卡片详情" }}
            </h3>
            <button type="button" class="modal-close" aria-label="关闭" @click="closeModal">×</button>
          </header>
          <div class="modal-body">
            <p class="sub">
              来源
              <RouterLink
                v-if="selectedSourceLink"
                class="source-article-link"
                :to="selectedSourceLink.to"
                :title="hideKolName ? '打开来源' : selectedSourceLink.title"
              >
                {{ selectedSourceLink.label }} ·
                {{ hideKolName ? "*****" : selectedSourceLink.displayName }}
              </RouterLink>
              <template v-else>{{ selected.sourceType }}</template>
              <template v-if="selected.channelName">
                · 频道 {{ hideKolName ? "*****" : selected.channelName }}
              </template>
              <template v-if="!selectedSourceLink && selected.sourceRef">
                · {{ hideKolName ? "*****" : selected.sourceRef }}
              </template>
              · {{ fmtTime(selected.signalAt || selected.createdAt) }}
            </p>

            <div v-if="selected.cardFields?.fields?.length" class="embed-preview">
              <div v-if="selected.cardFields.description" class="embed-desc">{{ selected.cardFields.description }}</div>
              <div class="embed-fields">
                <div
                  v-for="(f, i) in selected.cardFields.fields"
                  :key="i"
                  class="embed-field"
                  :class="{ inline: f.inline }"
                >
                  <div class="fn">{{ f.name }}</div>
                  <div class="fv">{{ f.value }}</div>
                </div>
              </div>
            </div>

            <div class="block">
              <h4>计划价位</h4>
              <p>{{ formatPlannedSummary(cardExecution(selected)) }}</p>
            </div>

            <div class="block eval-block">
              <h4>评价 / 实际成交</h4>
              <p v-if="hasEvaluation(cardExecution(selected), selected.note)" class="muted eval-hint">
                已填写评价，可在下方修改
              </p>
              <SignalEvaluationForm
                v-model="execDraft"
                v-model:note="noteDraft"
                v-model:actual-tp-text="actualTpText"
                :symbol="selected.symbol || cardExecution(selected).symbol"
                @change="scheduleSave(selected)"
                @save="saveEvaluation(selected)"
              />
              <p v-if="evalSaving" class="muted">保存中…</p>
              <p v-if="evalError" class="err">{{ evalError }}</p>
            </div>

            <details v-if="selected.rawContent" class="raw">
              <summary>原始正文</summary>
              <pre>{{ selected.rawContent }}</pre>
            </details>
          </div>
        </div>
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
.cards-page {
  display: grid;
  grid-template-columns: 220px 1fr;
  height: 100%;
  min-height: 0;
  background: #1e1f22;
}
.filters,
.grid-panel {
  padding: 1rem;
  overflow: auto;
  border-right: 1px solid #2b2d31;
}
.grid-panel {
  border-right: none;
  min-width: 0;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: baseline;
  gap: 0.5rem;
}
.modal-head h3 {
  display: flex;
  align-items: baseline;
  gap: 0.45rem;
  flex-wrap: wrap;
}
.modal-card-id {
  font-size: 0.88rem;
  font-weight: 700;
  color: #aeb4ff;
  font-variant-numeric: tabular-nums;
  flex-shrink: 0;
}
h2,
h3 {
  margin: 0;
  color: #f2f3f5;
  font-size: 1.05rem;
}
.link {
  font-size: 0.78rem;
  color: #5865f2;
  text-decoration: none;
}
.hint,
.muted,
.sub {
  color: #949ba4;
  font-size: 0.82rem;
  line-height: 1.45;
}
.source-article-link {
  color: #57f287;
  text-decoration: none;
  border-bottom: 1px solid rgba(87, 242, 135, 0.45);
  margin: 0 0.15rem;
}
.source-article-link:hover {
  color: #7dffab;
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
  border: 1px solid #3f4147;
  color: #dbdee1;
  border-radius: 6px;
  padding: 0.4rem 0.5rem;
}
.btn {
  width: 100%;
  margin-top: 0.5rem;
  padding: 0.45rem;
  border-radius: 6px;
  border: 1px solid #3f4147;
  background: #5865f2;
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}
.stats {
  margin-top: 0.75rem;
  font-size: 0.78rem;
  color: #949ba4;
}
.err {
  color: #f38688;
  font-size: 0.82rem;
}
.grid-head {
  margin-bottom: 0.65rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
}
.grid-count {
  flex: 1 1 auto;
  min-width: 0;
  font-size: 0.82rem;
  color: #949ba4;
}
.hide-kol-btn {
  flex: 0 0 auto;
  width: auto;
  margin-top: 0;
  font-size: 0.78rem;
  padding: 0.28rem 0.7rem;
  white-space: nowrap;
}
.hide-kol-btn.on {
  background: rgba(88, 101, 242, 0.22);
  border-color: rgba(88, 101, 242, 0.55);
  color: #c7ceff;
}
.empty-hint {
  padding: 2rem 0;
  text-align: center;
}
.card-grid {
  display: grid;
  grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
  gap: 0.5rem;
  align-content: start;
}
.card-grid :deep(.signal-card) {
  margin-bottom: 0;
  height: 100%;
}
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
}
.modal-panel {
  width: min(720px, 100%);
  max-height: min(85vh, 900px);
  background: #2b2d31;
  border: 1px solid #3f4147;
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid #3f4147;
  flex-shrink: 0;
}
.modal-close {
  border: none;
  background: #35373c;
  color: #dbdee1;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 6px;
  font-size: 1.2rem;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}
.modal-close:hover {
  background: #5865f2;
  color: #fff;
}
.modal-body {
  padding: 0.85rem 1rem 1rem;
  overflow: auto;
}
.embed-preview {
  background: #232428;
  border-left: 4px solid #5865f2;
  border-radius: 4px;
  padding: 0.65rem 0.75rem;
  margin: 0.75rem 0;
}
.embed-desc {
  color: #dbdee1;
  font-size: 0.85rem;
  margin-bottom: 0.5rem;
}
.embed-fields {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.45rem;
}
.embed-field.inline {
  grid-column: span 1;
}
.embed-field:not(.inline) {
  grid-column: 1 / -1;
}
.fn {
  font-size: 0.72rem;
  font-weight: 700;
  color: #b5bac1;
}
.fv {
  font-size: 0.82rem;
  color: #f2f3f5;
}
.block {
  margin: 0.75rem 0;
}
.block h4 {
  margin: 0 0 0.25rem;
  font-size: 0.8rem;
  color: #b5bac1;
}
.eval-block {
  border-top: 1px solid #3f4147;
  padding-top: 0.75rem;
}
.eval-hint {
  margin-bottom: 0.35rem;
}
.raw pre {
  white-space: pre-wrap;
  font-size: 0.78rem;
  color: #949ba4;
  max-height: 200px;
  overflow: auto;
}
@media (max-width: 900px) {
  .cards-page {
    grid-template-columns: 1fr;
  }
  .card-grid {
    grid-template-columns: 1fr;
  }
}
</style>
