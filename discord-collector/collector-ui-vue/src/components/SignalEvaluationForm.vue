<script setup>
import { computed } from "vue";
import { OUTCOME_OPTIONS } from "../lib/signalExecution.js";

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
</script>

<template>
  <div class="signal-eval-form">
    <div class="signal-field-row compact">
      <label>买入</label>
      <input
        :value="modelValue.actual.buyPrice"
        @input="patchActual('buyPrice', ($event.target).value)"
      />
    </div>
    <div class="signal-field-row compact">
      <label>卖出</label>
      <input
        :value="modelValue.actual.sellPrice"
        @input="patchActual('sellPrice', ($event.target).value)"
      />
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
</style>
