<script setup>
import { ref, computed, onMounted, watch, onUnmounted } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import SignalCardItem from "../components/SignalCardItem.vue";
import {
  fetchArchiveCard,
  fetchArchiveCards,
  fetchCardChannels,
  fetchCardSources,
  buildArchivePeriodQuery,
} from "../lib/cardArchiveApi.js";
import { useNewCardNotifications } from "../composables/useNewCardNotifications.js";
import {
  cardExecution,
  formatPlannedSummary,
  outcomeLabel,
} from "../lib/signalExecution.js";

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
const period = ref(/** @type {string | number} */ (7));
const loading = ref(false);
const error = ref("");
const cards = ref(/** @type {import("../lib/cardArchiveApi.js").ArchiveCard[]} */ ([]));
const selectedId = ref(0);
const sources = ref(/** @type {string[]} */ ([]));
const channelOptions = ref(/** @type {import("../lib/cardArchiveApi.js").ArchiveChannelOption[]} */ ([]));

const selected = computed(() => cards.value.find((c) => c.id === selectedId.value) ?? null);
const modalOpen = computed(() => selectedId.value > 0 && !!selected.value);

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

/** @param {import("../lib/cardArchiveApi.js").ArchiveCard} card */
function verifyModeText(mode) {
  if (mode === "30d") return "长周期";
  if (mode === "3h") return "3h";
  return "1天";
}

/** @param {import("../lib/cardArchiveApi.js").ArchiveCard} card */
function verifyPanelTitle(card) {
  if (card.verifyMode === "30d") return "长周期校验（股票）";
  if (card.verifyMode === "3h") return "3 小时校验";
  return "1 天校验（加密 · Binance）";
}

/** @param {import("../lib/cardArchiveApi.js").ArchiveCard} card */
function activeVerifyResult(card) {
  return card.verifyMode === "30d" ? card.verify1m : card.verify3h;
}

function closeModal() {
  selectedId.value = 0;
}

/** @param {import("../lib/cardArchiveApi.js").ArchiveCard} card */
function openCard(card) {
  selectedId.value = card.id;
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
      cards.value = [card, ...cards.value.filter((c) => c.id !== id)];
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
      </div>
      <p v-if="!loading && cards.length === 0" class="muted empty-hint">暂无卡片</p>
      <div v-else class="card-grid">
        <SignalCardItem
          v-for="c in cards"
          :key="c.id"
          :card="c"
          show-channel
          clickable
          @click="openCard(c)"
        />
      </div>
    </section>

    <Teleport to="body">
      <div v-if="modalOpen && selected" class="modal-backdrop" @click.self="closeModal">
        <div class="modal-panel" role="dialog" aria-modal="true">
          <header class="modal-head">
            <h3>{{ selected.cardFields?.title || `卡片 #${selected.id}` }}</h3>
            <button type="button" class="modal-close" aria-label="关闭" @click="closeModal">×</button>
          </header>
          <div class="modal-body">
            <p class="sub">
              来源 {{ selected.sourceType }}
              <template v-if="selected.channelName"> · 频道 {{ selected.channelName }}</template>
              <template v-if="selected.sourceRef"> · {{ selected.sourceRef }}</template>
              · {{ fmtTime(selected.signalAt || selected.createdAt) }}
              · 校验周期
              {{ selected.verifyMode === "30d" ? "长周期(股票)" : selected.verifyMode === "3h" ? "3小时" : "1天" }}
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

            <div class="block verify-grid">
              <div>
                <h4>{{ verifyPanelTitle(selected) }}</h4>
                <p v-if="activeVerifyResult(selected)">
                  {{ outcomeLabel(String(activeVerifyResult(selected)?.outcome ?? "pending")) }}
                  <template v-if="activeVerifyResult(selected)?.hitLevel">
                    @ {{ activeVerifyResult(selected)?.hitLevel }}
                  </template>
                  <template v-if="activeVerifyResult(selected)?.entry">
                    · 入场均价 {{ activeVerifyResult(selected)?.entry }}
                  </template>
                  <template v-if="activeVerifyResult(selected)?.pnl100x?.pnlLabel">
                    · {{ activeVerifyResult(selected)?.pnl100x?.pnlLabel }}
                  </template>
                  <span v-if="activeVerifyResult(selected)?.error" class="muted">
                    （{{ activeVerifyResult(selected)?.error }}）
                  </span>
                </p>
                <p v-else class="muted">
                  {{
                    selected.verifyMode === "30d"
                      ? "未满长周期窗口或待执行"
                      : selected.verifyMode === "3h"
                        ? "未满 3 小时或待执行"
                        : "未满 1 天或待执行"
                  }}
                </p>
              </div>
              <div v-if="selected.verifyMode !== '30d' && selected.verify1m">
                <h4>补充长周期记录</h4>
                <p>{{ outcomeLabel(String(selected.verify1m.outcome ?? "pending")) }}</p>
              </div>
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
}
.grid-count {
  font-size: 0.82rem;
  color: #949ba4;
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
  width: min(640px, 100%);
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
.verify-grid {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.75rem;
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
  .verify-grid {
    grid-template-columns: 1fr;
  }
}
</style>
