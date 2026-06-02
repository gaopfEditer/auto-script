<script setup>
import { computed } from "vue";
import { OUTCOME_OPTIONS } from "../lib/signalExecution.js";

const props = defineProps({
  modelValue: { type: Object, required: true },
  plannedTpText: { type: String, default: "" },
  actualTpText: { type: String, default: "" },
  compact: { type: Boolean, default: true },
});

const emit = defineEmits(["update:modelValue", "update:plannedTpText", "update:actualTpText", "change"]);

/** @param {string} key @param {unknown} val */
function patchRoot(key, val) {
  emit("update:modelValue", { ...props.modelValue, [key]: val });
  emit("change");
}

/** @param {"planned" | "actual"} leg @param {string} key @param {unknown} val */
function patchLeg(leg, key, val) {
  emit("update:modelValue", {
    ...props.modelValue,
    [leg]: { ...props.modelValue[leg], [key]: val },
  });
  emit("change");
}

const closedAtLocal = computed({
  get() {
    const v = props.modelValue?.actual?.closedAt;
    return v ? String(v).slice(0, 16) : "";
  },
  set(val) {
    patchLeg("actual", "closedAt", val ? new Date(val).toISOString() : null);
  },
});
</script>

<template>
  <div class="signal-exec-form" :class="{ compact }">
    <div class="signal-field-row" :class="{ compact }">
      <label>币种</label>
      <input :value="modelValue.symbol" @input="patchRoot('symbol', ($event.target).value)" />
    </div>
    <div class="signal-field-row" :class="{ compact }">
      <label>方向</label>
      <input :value="modelValue.direction" @input="patchRoot('direction', ($event.target).value)" />
    </div>

    <fieldset class="signal-exec-block">
      <legend>信号计划</legend>
      <div class="signal-field-row" :class="{ compact }">
        <label>入场</label>
        <input
          :value="modelValue.planned.entryPrice"
          @input="patchLeg('planned', 'entryPrice', ($event.target).value)"
        />
      </div>
      <div class="signal-field-row" :class="{ compact }">
        <label>止盈</label>
        <input
          :value="plannedTpText"
          placeholder="多个用逗号分隔"
          @input="emit('update:plannedTpText', ($event.target).value); emit('change')"
        />
      </div>
      <div class="signal-field-row" :class="{ compact }">
        <label>止损</label>
        <input
          :value="modelValue.planned.stopLossPrice"
          @input="patchLeg('planned', 'stopLossPrice', ($event.target).value)"
        />
      </div>
    </fieldset>

    <fieldset class="signal-exec-block actual">
      <legend>实际成交</legend>
      <div class="signal-field-row" :class="{ compact }">
        <label>买入</label>
        <input
          :value="modelValue.actual.buyPrice"
          @input="patchLeg('actual', 'buyPrice', ($event.target).value)"
        />
      </div>
      <div class="signal-field-row" :class="{ compact }">
        <label>卖出</label>
        <input
          :value="modelValue.actual.sellPrice"
          @input="patchLeg('actual', 'sellPrice', ($event.target).value)"
        />
      </div>
      <div class="signal-field-row" :class="{ compact }">
        <label>止盈</label>
        <input
          :value="actualTpText"
          placeholder="实际止盈价"
          @input="emit('update:actualTpText', ($event.target).value); emit('change')"
        />
      </div>
      <div class="signal-field-row" :class="{ compact }">
        <label>止损</label>
        <input
          :value="modelValue.actual.stopLossPrice"
          @input="patchLeg('actual', 'stopLossPrice', ($event.target).value)"
        />
      </div>
      <div class="signal-field-row" :class="{ compact }">
        <label>平仓</label>
        <input
          :value="modelValue.actual.exitPrice"
          @input="patchLeg('actual', 'exitPrice', ($event.target).value)"
        />
      </div>
      <div class="signal-field-row" :class="{ compact }">
        <label>时间</label>
        <input v-model="closedAtLocal" type="datetime-local" />
      </div>
    </fieldset>

    <div class="signal-field-row" :class="{ compact }">
      <label>结果</label>
      <select :value="modelValue.outcome" @change="patchRoot('outcome', ($event.target).value)">
        <option v-for="o in OUTCOME_OPTIONS" :key="o.value" :value="o.value">{{ o.label }}</option>
      </select>
    </div>
    <div class="signal-field-row" :class="{ compact }">
      <label>说明</label>
      <input
        :value="modelValue.outcomeNote"
        placeholder="结果备注"
        @input="patchRoot('outcomeNote', ($event.target).value)"
      />
    </div>
  </div>
</template>

<style scoped>
@import "../styles/signal-card-theme.css";
.signal-exec-block {
  border: 1px solid #3a3c42;
  border-radius: 6px;
  margin: 0.35rem 0;
  padding: 0.35rem 0.4rem 0.25rem;
  background: #25262a;
}
.signal-exec-block.actual {
  border-color: rgba(88, 101, 242, 0.35);
  background: rgba(88, 101, 242, 0.06);
}
.signal-exec-block legend {
  font-size: 0.62rem;
  color: #949ba4;
  padding: 0 0.25rem;
}
</style>
