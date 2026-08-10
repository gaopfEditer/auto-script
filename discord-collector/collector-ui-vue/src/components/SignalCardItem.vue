<script setup>
import { computed } from "vue";
import { RouterLink } from "vue-router";
import {
  cardExecution,
  outcomeLabel,
  hasEvaluation,
  calcProfitPercents,
  formatProfitPercent,
  formatCardId,
} from "../lib/signalExecution.js";
import { resolveCardSourceLink } from "../lib/cardSourceLink.js";

const props = defineProps({
  /** @type {import("vue").PropType<Record<string, unknown>>} */
  card: { type: Object, required: true },
  clickable: { type: Boolean, default: false },
  showChannel: { type: Boolean, default: false },
  /** 隐藏频道/KOL 名称（显示 *****） */
  hideKolName: { type: Boolean, default: false },
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

/** @param {string} type */
function actionTypeLabel(type) {
  switch (String(type)) {
    case "new":
      return "新开仓";
    case "continue":
      return "持仓更新";
    case "toend":
      return "临近目标";
    case "end":
      return "已结束";
    default:
      return "";
  }
}

/** paste / coin-watch 卡片：用结构化信号，不用文稿全文 */
/** @param {Record<string, unknown>} card */
function pasteStructuredBody(card) {
  const p = card.parsedJson;
  if (!p || typeof p !== "object") return "";
  const parsed = /** @type {Record<string, unknown>} */ (p);
  if (!parsed.paste && !parsed.coinWatch) return "";

  const ex = cardExecution(/** @type {import("../lib/discordSignalApi.js").SignalCard} */ (card));
  /** @type {string[]} */
  const lines = [];
  const typeLabel = actionTypeLabel(String(parsed.actionType ?? "new"));
  if (typeLabel) lines.push(typeLabel);
  if (ex.direction) lines.push(String(ex.direction));
  const band = /** @type {Record<string, unknown>} */ (parsed.coinWatch ?? {}).bandPct;
  if (band) lines.push(`监听 ±${band}%`);
  if (ex.planned?.entryPrice) lines.push(`入场 ${ex.planned.entryPrice}`);
  const tps = Array.isArray(ex.planned?.takeProfitPrices)
    ? ex.planned.takeProfitPrices.filter(Boolean)
    : [];
  if (tps.length) lines.push(`止盈 ${tps.join(" / ")}`);
  if (ex.planned?.stopLossPrice) lines.push(`止损 ${ex.planned.stopLossPrice}`);
  const note = String(parsed.description ?? "").trim();
  if (note) lines.push(`备注 ${note.slice(0, 120)}`);
  return lines.join("\n");
}

/** @param {Record<string, unknown>} card */
function cardBody(card) {
  const structured = pasteStructuredBody(card);
  if (structured) return structured;

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
const sourceLink = computed(() => resolveCardSourceLink(props.card));
const channelLabel = computed(() => {
  const name = String(props.card.channelName ?? "").trim();
  if (!name) return "";
  return props.hideKolName ? "*****" : name;
});
const sourceDisplayName = computed(() => {
  const name = sourceLink.value?.displayName || "";
  if (!name) return "";
  return props.hideKolName ? "*****" : name;
});
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
        <span v-if="showChannel && channelLabel" class="signal-card-channel-tag">
          {{ channelLabel }}
        </span>
        <RouterLink
          v-if="sourceLink"
          class="signal-card-source-tag"
          :class="sourceLink.kind"
          :to="sourceLink.to"
          :title="hideKolName ? '打开来源' : `打开来源：${sourceLink.title}`"
          @click.stop
        >
          {{ sourceLink.label }} · {{ sourceDisplayName }}
        </RouterLink>
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
.signal-card-source-tag {
  font-size: 0.6rem;
  padding: 0.05rem 0.35rem;
  border-radius: 3px;
  text-decoration: none;
  max-width: 12rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  border: 1px solid transparent;
}
.signal-card-source-tag.article {
  background: rgba(87, 242, 135, 0.12);
  color: #57f287;
  border-color: rgba(87, 242, 135, 0.35);
}
.signal-card-source-tag.youtube {
  background: rgba(255, 92, 92, 0.12);
  color: #ff8e8e;
  border-color: rgba(255, 92, 92, 0.35);
}
.signal-card-source-tag:hover {
  filter: brightness(1.15);
  text-decoration: underline;
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
