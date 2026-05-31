<script setup>
import { ref, computed, watch, onMounted } from "vue";
import {
  fetchSignalCards,
  fetchSignalConfig,
  resendSignalTelegram,
  updateSignalCard,
} from "../lib/discordSignalApi.js";

const props = defineProps({
  channelId: { type: String, default: "" },
});

const emit = defineEmits(["cardUpdated"]);

const cards = ref(/** @type {import("../lib/discordSignalApi.js").SignalCard[]} */ ([]));
const styles = ref(/** @type {Record<string, { label: string }>} */ ({}));
const loading = ref(false);
const error = ref("");
/** @type {Record<number, string>} */
const activeStyleByCard = ref({});

const sortedCards = computed(() =>
  [...cards.value].sort((a, b) => Number(b.id) - Number(a.id))
);

async function loadConfig() {
  const cfg = await fetchSignalConfig();
  styles.value = cfg.styles ?? {};
}

async function reload() {
  if (!props.channelId) {
    cards.value = [];
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
async function toggleStatus(card) {
  const next = isActive(card) ? "expired" : "active";
  try {
    const updated = await updateSignalCard(card.id, { status: next });
    const idx = cards.value.findIndex((c) => c.id === card.id);
    if (idx >= 0) cards.value[idx] = updated;
    emit("cardUpdated", updated);
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
    const idx = cards.value.findIndex((c) => c.id === card.id);
    if (idx >= 0) cards.value[idx] = updated;
    emit("cardUpdated", updated);
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
    <div class="signal-card-head">信号卡片</div>
    <div class="signal-card-scroll">
      <p v-if="error" class="signal-card-err">{{ error }}</p>
      <p v-if="loading" class="signal-card-wait">加载卡片…</p>
      <p v-else-if="!sortedCards.length" class="signal-card-wait">暂无卡片；监听到完整信号后将自动生成。</p>
      <article
        v-for="card in sortedCards"
        :key="card.id"
        class="signal-card"
        :class="{ inactive: !isActive(card) }"
      >
      <header class="signal-card-meta">
        <span class="signal-card-status" :class="isActive(card) ? 'on' : 'off'">
          {{ isActive(card) ? "有效" : "已失效" }}
        </span>
        <span class="signal-card-time">{{ card.createdAt ? new Date(card.createdAt).toLocaleString("zh-CN") : "" }}</span>
      </header>
      <div v-if="cardStyleIds(card).length > 1" class="signal-style-tabs">
        <button
          v-for="sid in cardStyleIds(card)"
          :key="sid"
          type="button"
          class="signal-style-tab"
          :class="{ active: activeStyle(card) === sid }"
          @click="activeStyleByCard[card.id] = sid"
        >{{ styleLabel(sid) }}</button>
      </div>
      <pre class="signal-card-body">{{ cardBody(card) }}</pre>
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
</style>
