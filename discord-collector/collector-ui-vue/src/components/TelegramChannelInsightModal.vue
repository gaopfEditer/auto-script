<script setup>
import { computed } from "vue";
import TelegramGroupEvalColStrip from "./TelegramGroupEvalColStrip.vue";
import TelegramCopySizingPanel from "./TelegramCopySizingPanel.vue";
import { isLocalClient } from "../lib/localClient.js";

const open = defineModel("open", { type: Boolean, default: false });

const props = defineProps({
  chatId: { type: String, default: "" },
  channelName: { type: String, default: "" },
  /** @type {(key: import("../lib/telegramGroupEvalApi.js").TgEvalWindowKey) => object | null} */
  metricsFor: { type: Function, default: () => () => null },
});

const emit = defineEmits(["open-detail"]);

const showCopySizing = computed(() => isLocalClient() && Boolean(props.chatId));

const title = computed(() => props.channelName || props.chatId || "频道");

function close() {
  open.value = false;
}

/** @param {import("../lib/telegramGroupEvalApi.js").TgEvalWindowKey} key */
function onOpenDetail(key) {
  emit("open-detail", key);
}
</script>

<template>
  <div
    v-if="open && chatId"
    class="modal insight-modal"
    role="dialog"
    aria-modal="true"
    aria-labelledby="channel-insight-title"
    @click.self="close"
  >
    <div class="modal-card wide">
      <header>
        <div>
          <strong id="channel-insight-title">{{ title }}</strong>
          <p class="muted tiny">双击群名打开 · 信号卡统计与跟单加成</p>
        </div>
        <button type="button" class="ghost" @click="close">关闭</button>
      </header>

      <TelegramGroupEvalColStrip
        :chat-id="chatId"
        variant="modal"
        :sticky="false"
        :metrics-for="metricsFor"
        @open-detail="onOpenDetail"
      />

      <TelegramCopySizingPanel
        v-if="showCopySizing"
        :chat-id="chatId"
        :channel-name="channelName"
      />
      <p v-else class="muted tiny copy-off-hint">跟单加成工具仅在本机 collect:ui 可用</p>
    </div>
  </div>
</template>

<style scoped>
.modal {
  position: fixed;
  inset: 0;
  z-index: 115;
  background: rgba(0, 0, 0, 0.62);
  display: grid;
  place-items: center;
  padding: 1rem;
}
.modal-card {
  width: min(520px, 100%);
  background: #2b2d31;
  border: 1px solid #4e5058;
  border-radius: 10px;
  padding: 0.85rem 1rem 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  color: #dbdee1;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
}
.modal-card header {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
}
.modal-card strong {
  font-size: 1.05rem;
  color: #f2f3f5;
}
.insight-modal .modal-card.wide {
  width: min(920px, 96vw);
  max-height: min(92vh, 900px);
  overflow: auto;
  scrollbar-gutter: stable;
  scrollbar-width: thin;
  scrollbar-color: #5c5f66 #2b2d31;
}
.insight-modal .modal-card.wide::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
.insight-modal .modal-card.wide::-webkit-scrollbar-track {
  background: #2b2d31;
  border-radius: 8px;
}
.insight-modal .modal-card.wide::-webkit-scrollbar-thumb {
  background: #5c5f66;
  border-radius: 8px;
  border: 2px solid #2b2d31;
}
.insight-modal .modal-card.wide::-webkit-scrollbar-thumb:hover {
  background: #6d7178;
}
button {
  border: 1px solid #4e5058;
  background: #383a40;
  color: #e8eaed;
  border-radius: 6px;
  padding: 0.35rem 0.7rem;
  font-size: 0.8rem;
  cursor: pointer;
}
button.ghost {
  background: transparent;
}
.muted {
  margin: 0;
  color: #949ba4;
  font-size: 0.82rem;
  line-height: 1.45;
}
.tiny {
  font-size: 0.72rem;
}
.copy-off-hint {
  margin: 0.25rem 0 0;
  padding-top: 0.75rem;
  border-top: 1px solid #383a40;
}
</style>
