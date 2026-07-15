<script setup>
import { computed } from "vue";
import {
  cardExecution,
  outcomeLabel,
  hasEvaluation,
  calcProfitPercents,
  formatProfitPercent,
  formatCardId,
} from "../lib/signalExecution.js";

const props = defineProps({
  /** @type {import("vue").PropType<Record<string, unknown>>} */
  card: { type: Object, required: true },
  clickable: { type: Boolean, default: false },
  showChannel: { type: Boolean, default: false },
});

const emit = defineEmits(["click"]);

/** @param {Record<string, unknown>} card */
function cardTitle(card) {
  const ex = cardExecution(/** @type {import("../lib/discordSignalApi.js").SignalCard} */ (card));
  if (ex.symbol) return ex.symbol.replace(/^\$/, "");
  const sym = String(card.symbol ?? "").trim();
  if (sym) return sym.replace(/USDT$/i, "").replace(/^\$/, "");
  const p = card.parsedJson;
  if (p && typeof p === "object") {
    const fromParsed = String(
      /** @type {Record<string, unknown>} */ (p).symbol ??
        /** @type {Record<string, unknown>} */ (p).asset ??
        ""
    ).trim();
    if (fromParsed) return fromParsed.replace(/^\$/, "");
  }
  return "";
}

/** @param {Record<string, unknown>} card */
function cardBody(card) {
  const styles = /** @type {Record<string, string>} */ (card.cardsByStyle ?? {});
  const first = Object.keys(styles)[0];
  if (first && styles[first]) return styles[first];
  return String(card.rawContent ?? "");
}

/** @param {Record<string, unknown>} card */
function isExpired(card) {
  if (card.status === "expired") return true;
  if (!card.expiresAt) return false;
  return new Date(String(card.expiresAt)).getTime() <= Date.now();
}

/** @param {Record<string, unknown>} card */
function isActive(card) {
  return card.status !== "expired" && !isExpired(card);
}

/** @param {Record<string, unknown>} card */
function cardHasEvaluation(card) {
  const ex = cardExecution(/** @type {import("../lib/discordSignalApi.js").SignalCard} */ (card));
  return hasEvaluation(ex, String(card.note ?? ""));
}

/** @param {Record<string, unknown>} card */
function cardEvalProfitBadge(card) {
  const ex = cardExecution(/** @type {import("../lib/discordSignalApi.js").SignalCard} */ (card));
  const profit = calcProfitPercents(
    ex.actual.buyPrice,
    ex.actual.sellPrice,
    ex.direction,
    undefined,
    ex.symbol || card.symbol
  );
  if (!profit) return null;
  const pct = profit.leveragePct;
  return {
    text: formatProfitPercent(pct),
    gain: pct > 0,
    loss: pct < 0,
  };
}

const title = computed(() => cardTitle(props.card));
const body = computed(() => cardBody(props.card));
const active = computed(() => isActive(props.card));
const evaluated = computed(() => cardHasEvaluation(props.card));
const profitBadge = computed(() => cardEvalProfitBadge(props.card));
const exec = computed(() =>
  cardExecution(/** @type {import("../lib/discordSignalApi.js").SignalCard} */ (props.card))
);
const displayTime = computed(() => {
  const raw = props.card.signalAt ?? props.card.createdAt;
  if (!raw) return "";
  const d = new Date(String(raw));
  return Number.isNaN(d.getTime()) ? String(raw) : d.toLocaleString("zh-CN");
});

function onClick() {
  if (props.clickable) emit("click");
}
</script>

<template>
  <article
    class="signal-card"
    :class="{
      inactive: !active,
      manual: card.isManual,
      clickable,
    }"
    @click="onClick"
  >
    <header class="signal-card-top">
      <div class="signal-card-top-left">
        <span v-if="formatCardId(card.id)" class="signal-card-id">{{ formatCardId(card.id) }}</span>
        <span class="signal-card-symbol">{{ title || "—" }}</span>
        <span class="signal-card-status" :class="active ? 'on' : 'off'">
          {{ active ? "有效" : "已失效" }}
        </span>
        <span v-if="showChannel && card.channelName" class="signal-card-channel-tag">
          {{ card.channelName }}
        </span>
        <span v-if="card.isManual" class="signal-card-manual-tag">手动</span>
        <span
          v-if="exec.outcome && exec.outcome !== 'pending'"
          class="signal-card-outcome-tag"
        >{{ outcomeLabel(exec.outcome) }}</span>
        <span v-else-if="evaluated" class="signal-card-eval-tags">
          <span class="signal-card-outcome-tag noted">已评价</span>
          <span
            v-if="profitBadge"
            class="signal-card-profit-tag"
            :class="{ gain: profitBadge.gain, loss: profitBadge.loss }"
          >{{ profitBadge.text }}</span>
        </span>
      </div>
    </header>
    <div class="signal-card-time">{{ displayTime }}</div>
    <pre v-if="body" class="signal-card-body">{{ body }}</pre>
  </article>
</template>

<style scoped>
@import "../styles/signal-card-theme.css";

.signal-card.clickable {
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.signal-card.clickable:hover {
  border-color: #5865f2;
  background: rgba(88, 101, 242, 0.08);
}
.signal-card-channel-tag {
  font-size: 0.6rem;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  background: rgba(88, 101, 242, 0.18);
  color: #aeb4ff;
  max-width: 8rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
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
