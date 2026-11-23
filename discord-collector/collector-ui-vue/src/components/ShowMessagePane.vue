<script setup>
import { computed, onMounted, onUnmounted, reactive, ref } from "vue";
import PageLoadingBlock from "./PageLoadingBlock.vue";
import {
  attachmentDisplayUrl,
  attachmentImgSrcCandidates,
  attachmentLinksExpired,
  fmtMsgTime,
  groupChannelMessages,
  isImageAttachment,
  messageTextContent,
  messageDisplayText,
  messageHasBilingualTranslation,
  messageAttachmentsMemoKey,
  msgAttachments,
  msgAvatarUrl,
  msgDisplayName,
} from "../lib/discordShow.js";
import {
  clearAttachmentImgDead,
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
  channelIconUrl: { type: String, default: "" },
});

defineExpose({ scrollRoot: null });

const groupedMessages = computed(() => groupChannelMessages(props.messages));

const avatarFailed = reactive(/** @type {Record<string, true>} */ ({}));
/** @type {Record<string, "en" | "zh">} */
const msgLangById = reactive({});

/** @param {Record<string, unknown>} m */
function hasBilingual(m) {
  return messageHasBilingualTranslation(m);
}

/** @param {string} id */
function msgLangToggleLabel(id) {
  const lang = msgLangById[id] ?? "zh";
  return lang === "zh" ? "EN" : "中文";
}

/** @param {string} id */
function toggleMsgLang(id) {
  if (!id) return;
  const cur = msgLangById[id] ?? "zh";
  msgLangById[id] = cur === "zh" ? "en" : "zh";
}

/** @param {Record<string, unknown>} m */
function displayText(m) {
  return messageDisplayText(m, msgLangById);
}
/** 触发模板在 markAttachmentImgDead 后更新 */
const attachmentFailEpoch = ref(0);

/** @type {import('vue').Ref<{ url: string, alt: string } | null>} */
const imageLightbox = ref(null);

/** @param {string} url @param {string} [alt] */
function openImageLightbox(url, alt = "") {
  const u = String(url ?? "").trim();
  if (!u) return;
  imageLightbox.value = { url: u, alt: String(alt ?? "") };
}

function closeImageLightbox() {
  imageLightbox.value = null;
}

/** @param {KeyboardEvent} e */
function onLightboxKeydown(e) {
  if (e.key === "Escape" && imageLightbox.value) closeImageLightbox();
}

onMounted(() => {
  window.addEventListener("keydown", onLightboxKeydown);
});
onUnmounted(() => {
  window.removeEventListener("keydown", onLightboxKeydown);
});

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

/**
 * @param {HTMLImageElement} img
 * @param {string[]} candidates
 */
function tryNextAttachmentSrc(img, candidates) {
  const tried = Number(img.dataset.dcTryIdx ?? "0");
  for (let j = tried; j < candidates.length; j += 1) {
    const next = candidates[j];
    if (!next || next === img.src) continue;
    img.dataset.dcTryIdx = String(j + 1);
    img.src = next;
    return true;
  }
  return false;
}

/** @param {Record<string, unknown>} att @param {number} i @param {Record<string, unknown>} msg */
function attachmentImgSkipped(att, i, msg) {
  if (attachmentLinksExpired(att)) return true;
  return attachmentImgDead(att, i, msg);
}

/** @param {Record<string, unknown>} att @param {number} i @param {Record<string, unknown>} msg @param {Event} e */
async function onAttachmentImgError(att, i, msg, e) {
  const key = stableAttachmentImgKey(att, i, msg);
  if (isAttachmentImgDead(key)) return;
  if (attachmentLinksExpired(att)) {
    markAttachmentImgDead(key);
    attachmentFailEpoch.value += 1;
    return;
  }

  const img = /** @type {HTMLImageElement | null} */ (e.target);
  if (!img) {
    markAttachmentImgDead(key);
    attachmentFailEpoch.value += 1;
    return;
  }

  const chain = attachmentImgSrcCandidates(att);
  if (tryNextAttachmentSrc(img, chain)) return;

  const mid = messageDomId(msg);
  if (mid && img.dataset.dcRefreshTried !== "1") {
    img.dataset.dcRefreshTried = "1";
    void (async () => {
      try {
        const ctrl = new AbortController();
        const timer = setTimeout(() => ctrl.abort(), 2500);
        const res = await fetch(`/api/discord/messages/${encodeURIComponent(mid)}/attachments`, {
          signal: ctrl.signal,
        });
        clearTimeout(timer);
        const data = await res.json();
        const fresh = Array.isArray(data.attachments) ? data.attachments[i] : null;
        if (fresh && typeof fresh === "object" && !attachmentLinksExpired(fresh)) {
          const freshKey = stableAttachmentImgKey(fresh, i, msg);
          clearAttachmentImgDead(key);
          clearAttachmentImgDead(freshKey);
          img.dataset.dcTryIdx = "0";
          const freshChain = attachmentImgSrcCandidates(fresh);
          if (tryNextAttachmentSrc(img, freshChain)) return;
        }
      } catch {
        /* ignore */
      }
      markAttachmentImgDead(key);
      attachmentFailEpoch.value += 1;
    })();
    return;
  }

  markAttachmentImgDead(key);
  attachmentFailEpoch.value += 1;
}
</script>

<template>
  <div class="msg-scroll-inner">
    <p v-if="loadingOlder" class="msg-older-hint">正在加载更早消息…</p>
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
          v-if="msgAvatarUrl(g.head, channelIconUrl) && !avatarFailed[avatarErrorKey(g.head)]"
          :src="msgAvatarUrl(g.head, channelIconUrl)"
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
            <button
              v-if="hasBilingual(g.head)"
              type="button"
              class="msg-lang-toggle"
              :title="msgLangById[messageDomId(g.head)] === 'en' ? '显示中文' : 'Show English'"
              @click.stop="toggleMsgLang(messageDomId(g.head))"
            >
              {{ msgLangToggleLabel(messageDomId(g.head)) }}
            </button>
          </div>
          <div v-if="messageTextContent(g.head)" class="msg-content">{{ displayText(g.head) }}</div>
          <div v-if="msgAttachments(g.head).length" class="msg-attachments">
            <template v-for="(att, i) in msgAttachments(g.head)" :key="`${g.head.messageId ?? g.head.message_id}-${i}`">
              <button
                v-if="isImageAttachment(att) && !attachmentImgSkipped(att, i, g.head)"
                type="button"
                class="msg-image-link"
                :aria-label="att.filename || '查看大图'"
                @click="openImageLightbox(attachmentDisplayUrl(att), att.filename || '图片')"
              >
                <img
                  :src="attachmentDisplayUrl(att)"
                  :alt="att.filename || '图片'"
                  class="msg-image"
                  loading="lazy"
                  decoding="async"
                  referrerpolicy="no-referrer"
                  @error="onAttachmentImgError(att, i, g.head, $event)"
                />
              </button>
              <span v-else-if="isImageAttachment(att)" class="msg-image-placeholder">{{
                attachmentLinksExpired(att) ? "图片链接已过期" : "图片加载失败"
              }}</span>
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
          <div v-if="hasBilingual(m)" class="msg-lang-row">
            <button
              type="button"
              class="msg-lang-toggle"
              :title="msgLangById[messageDomId(m)] === 'en' ? '显示中文' : 'Show English'"
              @click.stop="toggleMsgLang(messageDomId(m))"
            >
              {{ msgLangToggleLabel(messageDomId(m)) }}
            </button>
          </div>
          <div v-if="messageTextContent(m)" class="msg-content">{{ displayText(m) }}</div>
          <div v-if="msgAttachments(m).length" class="msg-attachments">
            <template v-for="(att, i) in msgAttachments(m)" :key="`${m.messageId ?? m.message_id}-${i}`">
              <button
                v-if="isImageAttachment(att) && !attachmentImgSkipped(att, i, m)"
                type="button"
                class="msg-image-link"
                :aria-label="att.filename || '查看大图'"
                @click="openImageLightbox(attachmentDisplayUrl(att), att.filename || '图片')"
              >
                <img
                  :src="attachmentDisplayUrl(att)"
                  :alt="att.filename || '图片'"
                  class="msg-image"
                  loading="lazy"
                  decoding="async"
                  referrerpolicy="no-referrer"
                  @error="onAttachmentImgError(att, i, m, $event)"
                />
              </button>
              <span v-else-if="isImageAttachment(att)" class="msg-image-placeholder">{{
                attachmentLinksExpired(att) ? "图片链接已过期" : "图片加载失败"
              }}</span>
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

    <Teleport to="body">
      <div
        v-if="imageLightbox"
        class="show-image-lightbox"
        role="dialog"
        aria-modal="true"
        :aria-label="imageLightbox.alt || '图片预览'"
        @click.self="closeImageLightbox"
      >
        <button type="button" class="show-image-lightbox-close" aria-label="关闭" @click="closeImageLightbox">
          ×
        </button>
        <img :src="imageLightbox.url" :alt="imageLightbox.alt" class="show-image-lightbox-img" referrerpolicy="no-referrer" />
      </div>
    </Teleport>
  </div>
</template>

<style scoped>
@import "../styles/show-theme.css";
</style>
