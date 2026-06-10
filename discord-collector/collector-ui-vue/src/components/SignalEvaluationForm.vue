<script setup>
import { computed } from "vue";
import { OUTCOME_OPTIONS, calcProfitPercents, directionLabel, formatProfitPercent, resolveTradeDirection } from "../lib/signalExecution.js";

const props = defineProps({
  modelValue: { type: Object, required: true },
  actualTpText: { type: String, default: "" },
  note: { type: String, default: "" },
});

const emit = defineEmits(["update:modelValue", "update:actualTpText", "update:note", "change", "save"]);

/** @param {string} key @param {unknown} val */
function patchRoot(key, val) {
  emit("update:modelValue", { ...props.modelValue, [key]: val });
  emit("change");
}

/** @param {string} key @param {unknown} val */
function patchActual(key, val) {
  emit("update:modelValue", {
    ...props.modelValue,
    actual: { ...props.modelValue.actual, [key]: val },
  });
  emit("change");
}

const closedAtLocal = computed({
  get() {
    const v = props.modelValue?.actual?.closedAt;
    return v ? String(v).slice(0, 16) : "";
  },
  set(val) {
    patchActual("closedAt", val ? new Date(val).toISOString() : null);
  },
});

const tradeSide = computed(() => resolveTradeDirection(props.modelValue?.direction));

const profit = computed(() =>
  calcProfitPercents(
    props.modelValue?.actual?.buyPrice,
    props.modelValue?.actual?.sellPrice,
    props.modelValue?.direction
  )
);

/** @param {"long" | "short"} side */
function setTradeSide(side) {
  patchRoot("direction", side === "short" ? "空" : "多");
}
</script>

<template>
  <div class="signal-eval-form">
    <div class="signal-field-row compact">
      <label>方向</label>
      <div class="signal-side-toggle">
        <button
          type="button"
          class="signal-side-btn"
          :class="{ active: tradeSide === 'long' }"
          @click="setTradeSide('long')"
        >多</button>
        <button
          type="button"
          class="signal-side-btn"
          :class="{ active: tradeSide === 'short' }"
          @click="setTradeSide('short')"
        >空</button>
      </div>
    </div>
    <div class="signal-field-row compact">
      <label>入场</label>
      <input
        :value="modelValue.actual.buyPrice"
        placeholder="开仓价"
        @input="patchActual('buyPrice', ($event.target).value)"
      />
    </div>
    <div class="signal-field-row compact">
      <label>出场</label>
      <input
        :value="modelValue.actual.sellPrice"
        placeholder="平仓价"
        @input="patchActual('sellPrice', ($event.target).value)"
      />
    </div>
    <div v-if="profit" class="signal-profit-row" :class="{ gain: profit.spot > 0, loss: profit.spot < 0 }">
      <span>{{ directionLabel(profit.side) }} · 盈利 {{ formatProfitPercent(profit.spot) }}</span>
      <span>100x {{ formatProfitPercent(profit.leverage100) }}</span>
    </div>
    <div class="signal-field-row compact">
      <label>止盈</label>
      <input
        :value="actualTpText"
        placeholder="实际止盈价"
        @input="emit('update:actualTpText', ($event.target).value); emit('change')"
      />
    </div>
    <div class="signal-field-row compact">
      <label>止损</label>
      <input
        :value="modelValue.actual.stopLossPrice"
        @input="patchActual('stopLossPrice', ($event.target).value)"
      />
    </div>
    <div class="signal-field-row compact">
      <label>平仓</label>
      <input
        :value="modelValue.actual.exitPrice"
        @input="patchActual('exitPrice', ($event.target).value)"
      />
    </div>
    <div class="signal-field-row compact">
      <label>时间</label>
      <input v-model="closedAtLocal" type="datetime-local" />
    </div>
    <div class="signal-field-row compact">
      <label>结果</label>
      <select :value="modelValue.outcome" @change="patchRoot('outcome', ($event.target).value)">
        <option v-for="o in OUTCOME_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
    <div class="signal-field-row compact">
      <label>说明</label>
      <input
        :value="modelValue.outcomeNote"
        placeholder="结果备注"
        @input="patchRoot('outcomeNote', ($event.target).value)"
      />
    </div>
    <label class="signal-note-row">
      <span>备注</span>
      <textarea
        :value="note"
        rows="2"
        placeholder="策略备注…"
        @input="emit('update:note', ($event.target).value); emit('change')"
      />
    </label>
    <button type="button" class="signal-act primary eval-save" @click="emit('save')">保存评价</button>
  </div>
</template>

<style scoped>
@import "../styles/signal-card-theme.css";
.signal-eval-form {
  padding-top: 0.15rem;
}
.eval-save {
  width: 100%;
  margin-top: 0.35rem;
}
.signal-profit-row {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  font-size: 0.68rem;
  padding: 0.25rem 0.35rem;
  margin-bottom: 0.25rem;
  border-radius: 4px;
  background: #25262a;
  color: #949ba4;
}
.signal-profit-row.gain {
  color: #49e57a;
}
.signal-profit-row.loss {
  color: #f38688;
}
.signal-side-toggle {
  display: flex;
  gap: 0.35rem;
  flex: 1;
}
.signal-side-btn {
  flex: 1;
  padding: 0.2rem 0.5rem;
  font-size: 0.68rem;
  border-radius: 4px;
  border: 1px solid #3a3c42;
  background: #1e1f22;
  color: #949ba4;
  cursor: pointer;
}
.signal-side-btn.active {
  border-color: #5865f2;
  background: rgba(88, 101, 242, 0.2);
  color: #dbdee1;
  font-weight: 600;
}
</style>
