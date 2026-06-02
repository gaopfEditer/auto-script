<script setup>
import { computed } from "vue";
import { dash, takeProfitText } from "../lib/signalExecution.js";

const props = defineProps({
  execution: { type: Object, required: true },
});

const rows = computed(() => {
  const ex = props.execution;
  /** @type {Array<{ label: string, value: string }>} */
  const list = [];
  if (ex.direction) list.push({ label: "方向", value: ex.direction });
  if (ex.planned?.entryPrice) list.push({ label: "入场", value: dash(ex.planned.entryPrice) });
  const tp = takeProfitText(ex.planned ?? {});
  if (tp) list.push({ label: "止盈", value: tp });
  if (ex.planned?.stopLossPrice) list.push({ label: "止损", value: dash(ex.planned.stopLossPrice) });
  return list;
});
</script>

<template>
  <dl v-if="rows.length" class="signal-exec-preview">
    <div v-for="row in rows" :key="row.label" class="signal-exec-preview-row">
      <dt>{{ row.label }}</dt>
      <dd>{{ row.value }}</dd>
    </div>
  </dl>
  <p v-else class="signal-exec-preview-empty">暂无计划价格</p>
</template>

<style scoped>
.signal-exec-preview {
  margin: 0;
  display: grid;
  gap: 0.2rem;
}
.signal-exec-preview-row {
  display: grid;
  grid-template-columns: 2rem 1fr;
  gap: 0.35rem;
  font-size: 0.68rem;
  line-height: 1.35;
}
.signal-exec-preview-row dt {
  color: #949ba4;
  margin: 0;
}
.signal-exec-preview-row dd {
  margin: 0;
  color: #dbdee1;
  word-break: break-word;
}
.signal-exec-preview-empty {
  margin: 0;
  font-size: 0.68rem;
  color: #6d7480;
}
</style>
