<script setup>
/** @typedef {import("../lib/telegramGroupEvalApi.js").TgWindowMetrics} TgWindowMetrics */

const props = defineProps({
  /** @type {import('vue').PropType<TgWindowMetrics | null | undefined>} */
  metrics: { type: Object, default: null },
  /** winloss | winrate | pnl */
  kind: {
    type: String,
    default: "winloss",
  },
});

const decided = () => {
  const m = props.metrics;
  if (!m) return 0;
  return (Number(m.winCount) || 0) + (Number(m.lossCount) || 0);
};

function pnlToneClass(pnl) {
  const v = Number(pnl);
  if (!Number.isFinite(v) || v === 0) return "flat";
  return v > 0 ? "gain" : "loss";
}

function winRateToneClass() {
  const m = props.metrics;
  if (!m || m.winRate == null || !decided()) return "flat";
  const w = Number(m.winRate);
  if (!Number.isFinite(w)) return "flat";
  if (w >= 50) return "gain";
  return "loss";
}
</script>

<template>
  <template v-if="kind === 'winloss'">
    <span v-if="!metrics || !decided()" class="tone-flat">0笔</span>
    <span v-else class="win-loss-pair">
      <span class="tone-gain">{{ metrics.winCount }}盈</span>
      <span class="tone-sep"> / </span>
      <span class="tone-loss">{{ metrics.lossCount }}亏</span>
    </span>
  </template>
  <template v-else-if="kind === 'winrate'">
    <span v-if="!metrics || !decided() || metrics.winRate == null" class="tone-flat">—</span>
    <span v-else class="tone-mono" :class="winRateToneClass()">
      {{ Number(metrics.winRate).toFixed(1) }}%
    </span>
  </template>
  <template v-else-if="kind === 'pnl'">
    <span
      class="tone-mono"
      :class="pnlToneClass(metrics?.totalPnlPct)"
    >
      <template v-if="metrics && Number.isFinite(Number(metrics.totalPnlPct))">
        {{ Number(metrics.totalPnlPct) >= 0 ? "+" : ""
        }}{{ Number(metrics.totalPnlPct).toFixed(2) }}%
      </template>
      <template v-else>—</template>
    </span>
  </template>
</template>

<style scoped>
.tone-gain {
  color: #3ba55d;
  font-weight: 600;
}
.tone-loss {
  color: #ed4245;
  font-weight: 600;
}
.tone-flat {
  color: #949ba4;
}
.tone-sep {
  color: #6d7178;
  font-weight: 400;
}
.tone-mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
  font-weight: 700;
}
.tone-mono.gain {
  color: #3ba55d;
}
.tone-mono.loss {
  color: #ed4245;
}
.tone-mono.flat {
  color: #c9cdd2;
  font-weight: 500;
}
</style>
