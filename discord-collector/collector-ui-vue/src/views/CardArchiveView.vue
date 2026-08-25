<script setup>
import { ref, computed, onMounted, watch, onUnmounted } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import SignalCardItem from "../components/SignalCardItem.vue";
import SignalEvaluationForm from "../components/SignalEvaluationForm.vue";
import {
  fetchArchiveCard,
  fetchArchiveCards,
  fetchCardChannels,
  liquidateArchiveCards,
  clearArchiveCardLiquidation,
  deleteArchiveCard,
  deleteArchiveCards,
  canDeleteArchiveCard,
  buildArchivePeriodQuery,
} from "../lib/cardArchiveApi.js";
import {
  EXTRA_SOURCE_OPTIONS,
  PERIOD_OPTIONS,
  normalizeArchiveSourceList,
  archivePeriodShowsWeekDividers,
} from "../lib/cardArchiveFilters.js";
import {
  archiveListClientKey,
  mergeArchiveCards,
  readArchiveListCache,
  writeArchiveListCache,
  readArchiveChannelsCache,
  writeArchiveChannelsCache,
} from "../lib/cardArchiveListCache.js";
import { isLocalClient } from "../lib/localClient.js";
import { updateSignalCard, fetchSignalConfig, compareCardsByTimeDesc } from "../lib/discordSignalApi.js";
import { useNewCardNotifications } from "../composables/useNewCardNotifications.js";
import { useHideKolName } from "../composables/useHideKolName.js";
import {
  cardExecution,
  formatPlannedSummary,
  emptyExecution,
  buildExecutionPayload,
  executionEquals,
  seedActualFromPlanned,
  takeProfitText,
  hasEvaluation,
  evaluationSummaryLines,
} from "../lib/signalExecution.js";
import { resolveCardSourceLink } from "../lib/cardSourceLink.js";
import { groupCardsByWeek } from "../lib/weekLabel.js";

const route = useRoute();
const router = useRouter();
const { toasts: newCardToasts } = useNewCardNotifications();
const canManageCards = isLocalClient();
const { hideKolName, toggleHideKol, maskKolName } = useHideKolName();

const extraSources = ref(/** @type {string[]} */ ([]));
const channelId = ref("");
const symbol = ref("");
const period = ref(/** @type {string | number} */ ("today"));
const loading = ref(false);
const error = ref("");
const cards = ref(/** @type {import("../lib/cardArchiveApi.js").ArchiveCard[]} */ ([]));
const selectedId = ref(0);
const channelOptions = ref(/** @type {import("../lib/cardArchiveApi.js").ArchiveChannelOption[]} */ ([]));

const bloggerOptions = computed(() =>
  [...channelOptions.value].sort((a, b) =>
    String(a.channelName || a.channelId).localeCompare(String(b.channelName || b.channelId), "zh")
  )
);

/** @param {import("../lib/cardArchiveApi.js").ArchiveChannelOption} ch */
function bloggerOptionLabel(ch) {
  return maskKolName(ch.channelName || ch.channelId || "未命名");
}

const activeSources = computed(() => normalizeArchiveSourceList(extraSources.value));

const selected = computed(() => cards.value.find((c) => c.id === selectedId.value) ?? null);
const selectedSourceLink = computed(() =>
  selected.value ? resolveCardSourceLink(selected.value) : null
);
const canDeleteSelected = computed(() =>
  canManageCards && selected.value ? canDeleteArchiveCard(selected.value) : false
);
const selectedDeletableCount = computed(() => {
  if (!canManageCards) return 0;
  return selectedCardIds.value.filter((id) => {
    const card = cards.value.find((c) => c.id === id);
    return card && canDeleteArchiveCard(card);
  }).length;
});
const selectedCount = computed(() => selectedCardIds.value.length);
const allSelected = computed(
  () => cards.value.length > 0 && selectedCardIds.value.length === cards.value.length
);
const modalOpen = computed(() => selectedId.value > 0 && !!selected.value);

const execDraft = ref(emptyExecution());
const noteDraft = ref("");
const actualTpText = ref("");
const evalSaving = ref(false);
const evalError = ref("");
const liquidating = ref(false);
const liquidateMsg = ref("");
const deleting = ref(false);
const deleteError = ref("");
const selectedCardIds = ref(/** @type {number[]} */ ([]));
const clearing = ref(false);
/** @type {Record<number, ReturnType<typeof setTimeout>>} */
const saveTimers = {};

const groupedBySource = computed(() => {
  /** @type {Record<string, number>} */
  const m = {};
  for (const c of cards.value) {
    const k = c.sourceType || "unknown";
    m[k] = (m[k] ?? 0) + 1;
  }
  return m;
});

const cardWeekGroups = computed(() => groupCardsByWeek(cards.value));
const showWeekDividers = computed(() => archivePeriodShowsWeekDividers(period.value));

function periodQuery() {
  return buildArchivePeriodQuery(period.value);
}

function currentListCacheKey() {
  return archiveListClientKey({
    sources: activeSources.value,
    channelId: channelId.value || "",
    symbol: symbol.value.trim(),
    period: period.value,
    limit: 200,
  });
}

function channelsCacheKey() {
  return archiveListClientKey({
    sources: activeSources.value,
    symbol: symbol.value.trim(),
    period: period.value,
  });
}

/** @param {unknown} v */
function fmtTime(v) {
  if (!v) return "—";
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString("zh-CN", { hour12: false });
}

function closeModal() {
  selectedId.value = 0;
  deleteError.value = "";
}

/** @param {import("../lib/cardArchiveApi.js").ArchiveCard} card */
async function deleteCard(card) {
  if (!canManageCards || !canDeleteArchiveCard(card)) return;
  const label = card.uid || `SC-${card.id}`;
  if (!confirm(`永久删除外部来源卡片 ${label}？不可恢复。`)) return;
  deleting.value = true;
  deleteError.value = "";
  try {
    await deleteArchiveCard(card.id);
    cards.value = cards.value.filter((c) => c.id !== card.id);
    closeModal();
    await loadChannels();
  } catch (e) {
    deleteError.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    deleting.value = false;
  }
}

async function deleteSelectedCards() {
  if (!canManageCards) return;
  const ids = selectedCardIds.value.filter((id) => {
    const card = cards.value.find((c) => c.id === id);
    return card && canDeleteArchiveCard(card);
  });
  if (!ids.length) {
    error.value = "所选卡片中没有可删除的外部来源卡片";
    return;
  }
  if (!confirm(`永久删除已选 ${ids.length} 张外部来源卡片？不可恢复。`)) return;
  deleting.value = true;
  deleteError.value = "";
  error.value = "";
  try {
    const j = await deleteArchiveCards(ids);
    const parts = [`已删除 ${j.deleted ?? 0}`, `跳过 ${j.skipped ?? 0}`];
    if (j.failed) parts.push(`失败 ${j.failed}`);
    liquidateMsg.value = parts.join(" · ");
    if (selectedId.value && ids.includes(selectedId.value)) closeModal();
    selectedCardIds.value = selectedCardIds.value.filter((id) => !ids.includes(id));
    await reload();
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    deleting.value = false;
  }
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
  writeArchiveListCache(currentListCacheKey(), cards.value);
  if (selectedId.value === updated.id) initEvalDraft(updated);
}

/** @param {import("../lib/cardArchiveApi.js").ArchiveCard} card */
async function saveEvaluation(card) {
  if (!canManageCards) return;
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

async function loadChannels(opts = {}) {
  const key = channelsCacheKey();
  if (!opts.force) {
    const cached = readArchiveChannelsCache(key);
    if (cached?.length) channelOptions.value = cached;
  }
  try {
    const rows = await fetchCardChannels({
      sources: activeSources.value,
      symbol: symbol.value.trim() || undefined,
      ...periodQuery(),
      refresh: opts.force,
    });
    channelOptions.value = rows;
    writeArchiveChannelsCache(key, rows);
    if (channelId.value && !channelOptions.value.some((c) => c.channelId === channelId.value)) {
      channelId.value = "";
    }
  } catch {
    if (!channelOptions.value.length) channelOptions.value = [];
  }
}

async function load(opts = {}) {
  const force = Boolean(opts.force);
  const key = currentListCacheKey();
  if (!force) {
    const cached = readArchiveListCache(key);
    if (cached?.cards?.length) cards.value = cached.cards;
  }
  loading.value = !cards.value.length;
  error.value = "";
  try {
    const cached = readArchiveListCache(key);
    const sinceId = force ? undefined : cached?.maxId;
    const data = await fetchArchiveCards({
      sources: activeSources.value,
      channelId: channelId.value || undefined,
      symbol: symbol.value.trim() || undefined,
      limit: 200,
      ...periodQuery(),
      sinceId: sinceId && sinceId > 0 ? sinceId : undefined,
      refresh: force,
    });
    if (!data || !Array.isArray(data.cards)) {
      throw new Error("加载卡片失败（响应格式异常）");
    }
    if (data.incremental) {
      cards.value = mergeArchiveCards([...cards.value, ...data.cards]);
    } else {
      cards.value = data.cards;
    }
    cards.value.sort(compareCardsByTimeDesc);
    writeArchiveListCache(key, cards.value, data.maxId);
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    loading.value = false;
  }
}

async function reload() {
  await loadChannels({ force: true });
  await load({ force: true });
  syncSelectionAfterLoad();
}

/** @param {number} id */
function isCardSelected(id) {
  return selectedCardIds.value.includes(id);
}

/** @param {number} id */
function toggleCardSelect(id) {
  const n = Number(id);
  if (!Number.isFinite(n) || n <= 0) return;
  if (isCardSelected(n)) {
    selectedCardIds.value = selectedCardIds.value.filter((x) => x !== n);
  } else {
    selectedCardIds.value = [...selectedCardIds.value, n];
  }
}

function toggleSelectAll() {
  if (allSelected.value) {
    selectedCardIds.value = [];
  } else {
    selectedCardIds.value = cards.value.map((c) => c.id);
  }
}

function syncSelectionAfterLoad() {
  const ids = new Set(cards.value.map((c) => c.id));
  selectedCardIds.value = selectedCardIds.value.filter((id) => ids.has(id));
}

async function runClearLiquidation() {
  if (!canManageCards) return;
  const ids = [...selectedCardIds.value];
  if (!ids.length) {
    error.value = "请先勾选要清空结算的卡片";
    return;
  }
  if (!confirm(`清空已选 ${ids.length} 张卡片的自动清算结果？可再点「清算选中」重新核算。`)) return;
  clearing.value = true;
  liquidateMsg.value = "";
  error.value = "";
  try {
    const j = await clearArchiveCardLiquidation(ids);
    liquidateMsg.value = `已清空 ${j.cleared ?? 0} 张，跳过 ${j.skipped ?? 0}`;
    await reload();
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    clearing.value = false;
  }
}

async function runLiquidationSelected() {
  if (!canManageCards) return;
  const ids = [...selectedCardIds.value];
  if (!ids.length) {
    error.value = "请先勾选要清算的卡片";
    return;
  }
  liquidating.value = true;
  liquidateMsg.value = "";
  error.value = "";
  try {
    const j = await liquidateArchiveCards({ cardIds: ids });
    const parts = [
      `清算完成：处理 ${j.processed ?? 0}`,
      `跳过 ${j.skipped ?? 0}`,
      `失败 ${j.failed ?? 0}`,
    ];
    if (Array.isArray(j.errorHints) && j.errorHints.length) {
      parts.push(String(j.errorHints[0]).slice(0, 120));
    }
    liquidateMsg.value = parts.join(" · ");
    await reload();
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    liquidating.value = false;
  }
}

async function runLiquidation() {
  if (!canManageCards) return;
  liquidating.value = true;
  liquidateMsg.value = "";
  error.value = "";
  try {
    const body = {
      ...periodQuery(),
      channelId: channelId.value || undefined,
      sources: activeSources.value,
      symbol: symbol.value.trim() || undefined,
      limit: 300,
    };
    const j = await liquidateArchiveCards(body);
    const parts = [
      `清算完成：处理 ${j.processed ?? 0}`,
      `跳过 ${j.skipped ?? 0}`,
      `失败 ${j.failed ?? 0}`,
    ];
    if (Array.isArray(j.errorHints) && j.errorHints.length) {
      parts.push(String(j.errorHints[0]).slice(0, 120));
    }
    const samples = (j.items ?? [])
      .filter((/** @type {{ error?: string }} */ i) => i.error)
      .slice(0, 2)
      .map((/** @type {{ id?: number, error?: string }} */ i) => `#${i.id} ${i.error}`);
    if (samples.length) parts.push(samples.join("; "));
    liquidateMsg.value = parts.join(" · ");
    await reload();
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    liquidating.value = false;
  }
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

watch([extraSources, symbol, period], () => void reload(), { deep: true });
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
    if (cardId && cardId !== prev) void load();
  }
);

onMounted(async () => {
  window.addEventListener("keydown", onKeydown);
  try {
    await fetchSignalConfig();
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
    <aside class="filters" data-onboard="cards-filters">
      <div class="head">
        <h2>卡片归档</h2>
        <RouterLink to="/eval" class="link">Discord 信号频道 →</RouterLink>
      </div>
      <p class="hint">默认包含 Discord 信号卡片，可勾选其它来源一并展示；支持按博主、币种、时间筛选。</p>

      <div class="field source-field">
        <span>来源</span>
        <div class="source-checks">
          <label class="source-check fixed">
            <input type="checkbox" checked disabled />
            Discord（默认）
          </label>
          <label v-for="o in EXTRA_SOURCE_OPTIONS" :key="o.value" class="source-check">
            <input v-model="extraSources" type="checkbox" :value="o.value" />
            {{ o.label }}
          </label>
        </div>
      </div>
      <label class="field">
        <span>博主</span>
        <select v-model="channelId">
          <option value="">全部博主</option>
          <option v-for="ch in bloggerOptions" :key="ch.channelId" :value="ch.channelId">
            {{ bloggerOptionLabel(ch) }} ({{ ch.count }})
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
      <button
        v-if="canManageCards"
        type="button"
        class="btn btn-secondary"
        :disabled="loading || liquidating"
        title="按当前筛选日期范围，对未评价卡片拉交易所 K 线核算盈亏"
        @click="runLiquidation"
      >
        {{ liquidating ? "清算中…" : "清算筛选" }}
      </button>
      <p v-if="liquidateMsg" class="muted liquidate-msg">{{ liquidateMsg }}</p>

      <div v-if="Object.keys(groupedBySource).length" class="stats">
        <div v-for="(n, k) in groupedBySource" :key="k">{{ k }}: {{ n }}</div>
      </div>
      <p v-if="error" class="err">{{ error }}</p>
    </aside>

    <section class="grid-panel" data-onboard="cards-grid">
      <div class="grid-head">
        <span class="grid-count">
          <span class="grid-count-main">
            {{ loading ? "加载中…" : `共 ${cards.length} 张` }}
            <template v-if="selectedCount"> · 已选 {{ selectedCount }}</template>
          </span>
          <span class="grid-count-rules">
            结算规则：BTC / ETH / SOL 按 100x，其余山寨 20x；卡片未设止盈止损（仅有方向）时，默认 ±5% 止盈止损价清算
          </span>
        </span>
        <div v-if="canManageCards" class="grid-head-actions">
          <button type="button" class="btn tiny-btn" :disabled="!cards.length" @click="toggleSelectAll">
            {{ allSelected ? "取消全选" : "全选" }}
          </button>
          <button
            type="button"
            class="btn tiny-btn btn-danger-outline"
            :disabled="!selectedDeletableCount || deleting || liquidating || clearing"
            @click="deleteSelectedCards"
          >
            {{ deleting ? "删除中…" : `删除选中${selectedDeletableCount ? ` (${selectedDeletableCount})` : ""}` }}
          </button>
          <button
            type="button"
            class="btn tiny-btn"
            :disabled="!selectedCount || clearing || liquidating"
            @click="runClearLiquidation"
          >
            {{ clearing ? "清空中…" : "清空结算" }}
          </button>
          <button
            type="button"
            class="btn tiny-btn primary"
            :disabled="!selectedCount || liquidating || clearing"
            @click="runLiquidationSelected"
          >
            {{ liquidating ? "清算中…" : "清算选中" }}
          </button>
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
        <button
          v-else
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
        <template v-for="group in cardWeekGroups" :key="group.weekKey">
          <div v-if="showWeekDividers" class="week-divider">
            <span class="week-divider-line" aria-hidden="true" />
            <span class="week-divider-label">{{ group.label }}</span>
            <span class="week-divider-line" aria-hidden="true" />
          </div>
          <div
            v-for="c in group.cards"
            :key="c.id"
            class="card-select-wrap"
            :class="{ selected: isCardSelected(c.id) }"
          >
            <label v-if="canManageCards" class="card-select-label" @click.stop>
              <input
                type="checkbox"
                class="card-select-cb"
                :checked="isCardSelected(c.id)"
                @change="toggleCardSelect(c.id)"
              />
            </label>
            <SignalCardItem
              :card="c"
              show-channel
              :hide-kol-name="hideKolName"
              clickable
              @click="openCard(c)"
            />
          </div>
        </template>
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
            <div class="modal-head-actions">
              <button
                v-if="canDeleteSelected"
                type="button"
                class="btn-danger"
                :disabled="deleting"
                @click="deleteCard(selected)"
              >
                {{ deleting ? "删除中…" : "删除" }}
              </button>
              <button type="button" class="modal-close" aria-label="关闭" @click="closeModal">×</button>
            </div>
          </header>
          <div class="modal-body">
            <p v-if="deleteError" class="err">{{ deleteError }}</p>
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
              <template v-if="canManageCards">
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
              </template>
              <template v-else>
                <p v-if="hasEvaluation(cardExecution(selected), selected.note)" class="muted">
                  <span v-for="(line, i) in evaluationSummaryLines(cardExecution(selected), selected.note)" :key="i">
                    {{ line }}<br />
                  </span>
                </p>
                <p v-else class="muted">仅本机可编辑评价</p>
              </template>
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
.source-field .source-checks {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.source-check {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  font-size: 0.88rem;
  color: #dbdee1;
  cursor: pointer;
}
.source-check.fixed {
  cursor: default;
  color: #aeb4ff;
}
.source-check input {
  width: auto;
  margin: 0;
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
.btn-secondary {
  background: #3f4147;
  border-color: #4e5058;
}
.btn-secondary:hover:not(:disabled) {
  background: #4e5058;
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.liquidate-msg {
  margin-top: 0.35rem;
  font-size: 0.78rem;
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
.grid-head-actions {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  flex-wrap: wrap;
  justify-content: flex-end;
}
.tiny-btn {
  width: auto;
  margin-top: 0;
  font-size: 0.75rem;
  padding: 0.28rem 0.55rem;
  white-space: nowrap;
}
.tiny-btn.primary {
  background: #5865f2;
  border-color: #5865f2;
  color: #fff;
}
.tiny-btn.btn-danger-outline {
  background: rgba(237, 66, 69, 0.12);
  border-color: rgba(237, 66, 69, 0.45);
  color: #f38688;
}
.tiny-btn.btn-danger-outline:hover:not(:disabled) {
  background: rgba(237, 66, 69, 0.22);
  color: #fff;
}
.card-select-wrap {
  position: relative;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.card-select-wrap.selected :deep(.signal-card) {
  border-color: rgba(88, 101, 242, 0.65);
  box-shadow: 0 0 0 1px rgba(88, 101, 242, 0.35);
}
.card-select-label {
  position: absolute;
  top: 0.35rem;
  left: 0.35rem;
  z-index: 2;
  display: flex;
  cursor: pointer;
}
.card-select-cb {
  width: 0.95rem;
  height: 0.95rem;
  accent-color: #5865f2;
  cursor: pointer;
}
.grid-count {
  flex: 1 1 auto;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.82rem;
  color: #949ba4;
}
.grid-count-main {
  color: #dbdee1;
}
.grid-count-rules {
  font-size: 0.72rem;
  line-height: 1.45;
  color: #7a8088;
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
.week-divider {
  grid-column: 1 / -1;
  display: flex;
  align-items: center;
  gap: 0.65rem;
  margin: 0.35rem 0 0.55rem;
  padding: 0 0.15rem;
}
.week-divider:first-child {
  margin-top: 0;
}
.week-divider-line {
  flex: 1;
  height: 1px;
  background: linear-gradient(90deg, transparent, #3f4147 12%, #3f4147 88%, transparent);
}
.week-divider-label {
  flex-shrink: 0;
  font-size: 0.76rem;
  font-weight: 600;
  color: #b5bac1;
  letter-spacing: 0.02em;
  padding: 0.12rem 0.55rem;
  border-radius: 999px;
  background: rgba(63, 65, 71, 0.55);
  border: 1px solid #3f4147;
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
.modal-head-actions {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-shrink: 0;
}
.btn-danger {
  border: 1px solid rgba(237, 66, 69, 0.55);
  background: rgba(237, 66, 69, 0.15);
  color: #f38688;
  font-size: 0.78rem;
  font-weight: 600;
  padding: 0.28rem 0.65rem;
  border-radius: 6px;
  cursor: pointer;
}
.btn-danger:hover:not(:disabled) {
  background: rgba(237, 66, 69, 0.28);
  color: #fff;
}
.btn-danger:disabled {
  opacity: 0.55;
  cursor: not-allowed;
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
