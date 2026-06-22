<script setup>
import { ref, computed, onMounted, watch } from "vue";
import { RouterLink } from "vue-router";
import { fetchArchiveCards, fetchCardSources } from "../lib/cardArchiveApi.js";
import {
  cardExecution,
  directionLabel,
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
  { value: 7, label: "近 7 天" },
  { value: 30, label: "近 30 天" },
  { value: 90, label: "近 90 天" },
  { value: 0, label: "全部" },
];

const source = ref("");
const symbol = ref("");
const days = ref(30);
const loading = ref(false);
const error = ref("");
const cards = ref(/** @type {import("../lib/cardArchiveApi.js").ArchiveCard[]} */ ([]));
const selectedId = ref(0);
const sources = ref(/** @type {string[]} */ ([]));

const selected = computed(() => cards.value.find((c) => c.id === selectedId.value));

const groupedBySource = computed(() => {
  /** @type {Record<string, number>} */
  const m = {};
  for (const c of cards.value) {
    const k = c.sourceType || "unknown";
    m[k] = (m[k] ?? 0) + 1;
  }
  return m;
});

/** @param {unknown} v */
function fmtTime(v) {
  if (!v) return "—";
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString("zh-CN", { hour12: false });
}

/** @param {import("../lib/cardArchiveApi.js").ArchiveCard} card */
function verifyBadge(card) {
  const v3 = card.verify3h?.outcome;
  const v1 = card.verify1m?.outcome;
  if (v1 && v1 !== "pending") return `30d: ${outcomeLabel(String(v1))}`;
  if (v3 && v3 !== "pending") return `3h: ${outcomeLabel(String(v3))}`;
  return "待校验";
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    const d = Number(days.value);
    const data = await fetchArchiveCards({
      source: source.value || undefined,
      symbol: symbol.value.trim() || undefined,
      days: d > 0 ? d : 3650,
      limit: 200,
    });
    cards.value = data.cards;
    if (!selectedId.value && cards.value.length) selectedId.value = cards.value[0].id;
    if (selectedId.value && !cards.value.some((c) => c.id === selectedId.value)) {
      selectedId.value = cards.value[0]?.id ?? 0;
    }
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    loading.value = false;
  }
}

watch([source, symbol, days], () => void load());

onMounted(async () => {
  try {
    sources.value = await fetchCardSources();
  } catch {
    /* ignore */
  }
  await load();
});
</script>

<template>
  <div class="cards-page">
    <aside class="filters">
      <div class="head">
        <h2>卡片归档</h2>
        <RouterLink to="/signals" class="link">Discord 信号频道 →</RouterLink>
      </div>
      <p class="hint">统一归档 Discord / YouTube / API 卡片，支持按来源、币种、时间筛选。</p>

      <label class="field">
        <span>来源</span>
        <select v-model="source">
          <option v-for="o in SOURCE_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
        </select>
      </label>
      <label class="field">
        <span>币种</span>
        <input v-model="symbol" type="text" placeholder="BTC / ETH" />
      </label>
      <label class="field">
        <span>时间</span>
        <select v-model.number="days">
          <option v-for="p in PERIOD_OPTIONS" :key="p.value" :value="p.value">{{ p.label }}</option>
        </select>
      </label>
      <button type="button" class="btn" :disabled="loading" @click="load">刷新</button>

      <div v-if="Object.keys(groupedBySource).length" class="stats">
        <div v-for="(n, k) in groupedBySource" :key="k">{{ k }}: {{ n }}</div>
      </div>
      <p v-if="error" class="err">{{ error }}</p>
    </aside>

    <section class="list-panel">
      <p v-if="loading" class="muted">加载中…</p>
      <p v-else-if="cards.length === 0" class="muted">暂无卡片</p>
      <ul v-else class="card-list">
        <li
          v-for="c in cards"
          :key="c.id"
          :class="{ on: selectedId === c.id }"
          @click="selectedId = c.id"
        >
          <div class="row-top">
            <span class="badge src">{{ c.sourceType }}</span>
            <span class="sym">{{ c.symbol || cardExecution(c).symbol }}</span>
            <span class="dir">{{ directionLabel(cardExecution(c).direction) }}</span>
          </div>
          <div class="title">{{ c.cardFields?.title || c.rawContent?.slice(0, 60) }}</div>
          <div class="meta">{{ fmtTime(c.signalAt || c.createdAt) }} · {{ verifyBadge(c) }}</div>
        </li>
      </ul>
    </section>

    <section v-if="selected" class="detail-panel">
      <h3>{{ selected.cardFields?.title || `卡片 #${selected.id}` }}</h3>
      <p class="sub">
        来源 {{ selected.sourceType }}
        <template v-if="selected.sourceRef"> · {{ selected.sourceRef }}</template>
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

      <div class="block verify-grid">
        <div>
          <h4>3 小时校验</h4>
          <p v-if="selected.verify3h">
            {{ outcomeLabel(String(selected.verify3h.outcome ?? "pending")) }}
            <template v-if="selected.verify3h.hitLevel"> @ {{ selected.verify3h.hitLevel }}</template>
          </p>
          <p v-else class="muted">未满 3 小时或待执行</p>
        </div>
        <div>
          <h4>30 天校验</h4>
          <p v-if="selected.verify1m">
            {{ outcomeLabel(String(selected.verify1m.outcome ?? "pending")) }}
            <template v-if="selected.verify1m.hitLevel"> @ {{ selected.verify1m.hitLevel }}</template>
          </p>
          <p v-else class="muted">未满 30 天或待执行</p>
        </div>
      </div>

      <details v-if="selected.rawContent" class="raw">
        <summary>原始正文</summary>
        <pre>{{ selected.rawContent }}</pre>
      </details>
    </section>
  </div>
</template>

<style scoped>
.cards-page {
  display: grid;
  grid-template-columns: 220px 1fr 1.1fr;
  height: 100%;
  min-height: 0;
  background: #1e1f22;
}
.filters,
.list-panel,
.detail-panel {
  padding: 1rem;
  overflow: auto;
  border-right: 1px solid #2b2d31;
}
.detail-panel {
  border-right: none;
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
.card-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.card-list li {
  background: #2b2d31;
  border: 1px solid #3f4147;
  border-radius: 8px;
  padding: 0.55rem 0.65rem;
  cursor: pointer;
}
.card-list li.on {
  border-color: #5865f2;
  background: rgba(88, 101, 242, 0.12);
}
.row-top {
  display: flex;
  gap: 0.4rem;
  align-items: center;
  flex-wrap: wrap;
}
.badge.src {
  font-size: 0.68rem;
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  background: #3f4147;
  color: #dbdee1;
}
.sym {
  font-weight: 700;
  color: #f2f3f5;
}
.dir {
  color: #aeb4ff;
  font-size: 0.78rem;
}
.title {
  margin-top: 0.25rem;
  color: #dbdee1;
  font-size: 0.85rem;
}
.meta {
  margin-top: 0.2rem;
  font-size: 0.72rem;
  color: #949ba4;
}
.embed-preview {
  background: #2b2d31;
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
@media (max-width: 1000px) {
  .cards-page {
    grid-template-columns: 1fr;
  }
}
</style>
