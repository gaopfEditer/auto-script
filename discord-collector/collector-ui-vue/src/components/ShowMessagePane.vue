<script setup>
import { computed, reactive, ref } from "vue";
import PageLoadingBlock from "./PageLoadingBlock.vue";
import {
  attachmentDisplayUrl,
  fmtMsgTime,
  groupChannelMessages,
  isImageAttachment,
  messageTextContent,
  messageAttachmentsMemoKey,
  msgAttachments,
  msgAvatarUrl,
  msgDisplayName,
} from "../lib/discordShow.js";
import {
  isAttachmentImgDead,
  markAttachmentImgDead,
  stableAttachmentImgKey,
} from "../lib/showAttachmentImages.js";

const props = defineProps({
  /** @type {import('vue').PropType<Array<Record<string, unknown>>>} */
  messages: { type: Array, default: () => [] },
  loading: { type: Boolean, default: false },
  loadingOlder: { type: Boolean, default: false },
  snapshotWarming: { type: Boolean, default: false },
  highlightMessageId: { type: String, default: "" },
  emptyHint: { type: String, default: "" },
});

defineExpose({ scrollRoot: null });

const groupedMessages = computed(() => groupChannelMessages(props.messages));

const avatarFailed = reactive(/** @type {Record<string, true>} */ ({}));
/** 触发模板在 markAttachmentImgDead 后更新 */
const attachmentFailEpoch = ref(0);

/** @param {Record<string, unknown>} att @param {number} i @param {Record<string, unknown>} msg */
function attachmentImgDead(att, i, msg) {
  void attachmentFailEpoch.value;
  return isAttachmentImgDead(stableAttachmentImgKey(att, i, msg));
}

/** @param {Record<string, unknown>} m */
function messageDomId(m) {
  return String(m.messageId ?? m.message_id ?? "");
}

/** @param {Record<string, unknown>} m */
function isHighlightedMessage(m) {
  const mid = messageDomId(m);
  return mid && props.highlightMessageId === mid;
}

/** @param {string} id */
function onAvatarError(id) {
  if (id) avatarFailed[id] = true;
}

/** @param {Record<string, unknown>} m */
function avatarErrorKey(m) {
  return String(m.authorId ?? m.author_id ?? m.messageId ?? m.message_id ?? "");
}

/** @param {Record<string, unknown>} att @param {number} i @param {Record<string, unknown>} msg @param {Event} e */
function onAttachmentImgError(att, i, msg, e) {
  const key = stableAttachmentImgKey(att, i, msg);
  if (isAttachmentImgDead(key)) return;

  const img = /** @type {HTMLImageElement | null} */ (e.target);
  if (!img) {
    markAttachmentImgDead(key);
    attachmentFailEpoch.value += 1;
    return;
  }

  const direct = String(att.url ?? "").trim();
  const proxy = String(att.proxyUrl ?? att.proxy_url ?? "").trim();
  const primary = attachmentDisplayUrl(att);
  const alt =
    primary && direct && primary !== direct
      ? direct
      : primary && proxy && primary !== proxy
        ? proxy
        : "";

  if (alt && img.dataset.dcAltTried !== "1") {
    img.dataset.dcAltTried = "1";
    img.src = alt;
    return;
  }

  markAttachmentImgDead(key);
  attachmentFailEpoch.value += 1;
}
</script>

<template>
  <div class="msg-scroll-inner">
    <p v-if="loadingOlder" class="msg-older-hint">正在加载更早消息（同步 CDP 网页上滚）…</p>
    <PageLoadingBlock
      v-if="loading && !messages.length"
      message="加载频道消息…"
      hint="优先读本地库近 7 天消息；若无则展示该频道最近入库记录"
    />
    <article
      v-for="g in groupedMessages"
      :key="String(g.head.messageId ?? g.head.message_id)"
      v-memo="[
        g.head.messageId ?? g.head.message_id,
        messageAttachmentsMemoKey(g.head),
        g.tail.length,
        g.tail.map((m) => messageAttachmentsMemoKey(m)).join(';'),
        g.tail[g.tail.length - 1]?.messageId ?? g.tail[g.tail.length - 1]?.message_id,
        highlightMessageId,
        attachmentFailEpoch,
      ]"
      class="msg-group"
      :class="{ 'msg-highlight': isHighlightedMessage(g.head) }"
      :data-message-id="messageDomId(g.head)"
    >
      <div class="msg-row msg-row-head">
        <img
          v-if="msgAvatarUrl(g.head) && !avatarFailed[avatarErrorKey(g.head)]"
          :src="msgAvatarUrl(g.head)"
          class="msg-av"
          width="40"
          height="40"
          alt=""
          referrerpolicy="no-referrer"
          loading="lazy"
          @error="onAvatarError(avatarErrorKey(g.head))"
        />
        <div v-else class="msg-av ph" aria-hidden="true" />
        <div class="msg-body">
          <div class="msg-meta">
            <span class="msg-name">{{ msgDisplayName(g.head) }}</span>
            <span
              v-if="(g.head.authorUsername ?? g.head.author_username) && (g.head.authorUsername ?? g.head.author_username) !== msgDisplayName(g.head)"
              class="msg-user"
            >@{{ g.head.authorUsername ?? g.head.author_username }}</span>
            <span class="msg-time">{{ fmtMsgTime(g.head.createdAtMs ?? g.head.created_at_ms) }}</span>
          </div>
          <div v-if="messageTextContent(g.head)" class="msg-content">{{ messageTextContent(g.head) }}</div>
          <div v-if="msgAttachments(g.head).length" class="msg-attachments">
            <template v-for="(att, i) in msgAttachments(g.head)" :key="`${g.head.messageId ?? g.head.message_id}-${i}`">
              <a
                    v-if="isImageAttachment(att) && !attachmentImgDead(att, i, g.head)"
                :href="attachmentDisplayUrl(att)"
                target="_blank"
                rel="noopener noreferrer"
                class="msg-image-link"
              >
                <img
                  :src="attachmentDisplayUrl(att)"
                  :alt="att.filename || '图片'"
                  class="msg-image"
                  loading="eager"
                  decoding="async"
                  referrerpolicy="no-referrer"
                        @error="onAttachmentImgError(att, i, g.head, $event)"
                />
              </a>
              <span v-else-if="isImageAttachment(att)" class="msg-image-placeholder">图片加载失败</span>
              <a
                v-else
                :href="attachmentDisplayUrl(att)"
                target="_blank"
                rel="noopener noreferrer"
                class="msg-file-link"
              >{{ att.filename || "下载附件" }}</a>
            </template>
          </div>
          <div
            v-if="!messageTextContent(g.head) && !msgAttachments(g.head).length"
            class="msg-content muted"
          >（无文本）</div>
        </div>
      </div>
      <div
        v-for="m in g.tail"
        :key="String(m.messageId ?? m.message_id)"
        class="msg-row msg-row-continued"
        :class="{ 'msg-highlight-row': isHighlightedMessage(m) }"
        :data-message-id="messageDomId(m)"
      >
        <div class="msg-av-gap" aria-hidden="true" />
        <div class="msg-body">
          <div v-if="messageTextContent(m)" class="msg-content">{{ messageTextContent(m) }}</div>
          <div v-if="msgAttachments(m).length" class="msg-attachments">
            <template v-for="(att, i) in msgAttachments(m)" :key="`${m.messageId ?? m.message_id}-${i}`">
              <a
                      v-if="isImageAttachment(att) && !attachmentImgDead(att, i, m)"
                :href="attachmentDisplayUrl(att)"
                target="_blank"
                rel="noopener noreferrer"
                class="msg-image-link"
              >
                <img
                  :src="attachmentDisplayUrl(att)"
                  :alt="att.filename || '图片'"
                  class="msg-image"
                  loading="eager"
                  decoding="async"
                  referrerpolicy="no-referrer"
                        @error="onAttachmentImgError(att, i, m, $event)"
                />
              </a>
              <span v-else-if="isImageAttachment(att)" class="msg-image-placeholder">图片加载失败</span>
              <a
                v-else
                :href="attachmentDisplayUrl(att)"
                target="_blank"
                rel="noopener noreferrer"
                class="msg-file-link"
              >{{ att.filename || "下载附件" }}</a>
            </template>
          </div>
          <div
            v-if="!messageTextContent(m) && !msgAttachments(m).length"
            class="msg-content muted"
          >（无文本）</div>
        </div>
      </div>
    </article>
    <p v-if="!messages.length && !loading && !snapshotWarming && emptyHint" class="kook-wait">
      {{ emptyHint }}
    </p>
  </div>
</template>

<style scoped>
@import "../styles/show-theme.css";
</style>
