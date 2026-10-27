<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  copyImageAsBlob,
  copyPostToClipboard,
  createContentPost,
  deleteContentImage,
  deleteContentPost,
  listContentPosts,
  sharePostNative,
  updateContentPost,
  uploadContentImage,
} from "../lib/contentApi.js";

const posts = ref(/** @type {import('../lib/contentApi.js').ContentPost[]} */ ([]));
const loading = ref(false);
const error = ref("");
const toast = ref("");
const selectedId = ref(/** @type {number | null} */ (null));
const isDesktop = ref(false);

const editId = ref(/** @type {number | null} */ (null));
const formTitle = ref("");
const formBody = ref("");
const formFiles = ref(/** @type {File[]} */ ([]));
/** @type {import('vue').Ref<string[]>} */
const formPreviewUrls = ref([]);
const saving = ref(false);
const dropActive = ref(false);

const mq = typeof window !== "undefined" ? window.matchMedia("(min-width: 900px)") : null;

function syncDesktop() {
  isDesktop.value = Boolean(mq?.matches);
}

const selected = computed(() => posts.value.find((p) => p.id === selectedId.value) || null);

function revokePreviews() {
  for (const u of formPreviewUrls.value) {
    try {
      URL.revokeObjectURL(u);
    } catch {
      /* ignore */
    }
  }
  formPreviewUrls.value = [];
}

function rebuildPreviews() {
  revokePreviews();
  formPreviewUrls.value = formFiles.value.map((f) => URL.createObjectURL(f));
}

/**
 * @param {FileList | File[] | null | undefined} list
 */
function appendImageFiles(list) {
  if (!list) return 0;
  const incoming = [...list].filter((f) => f && f.type.startsWith("image/"));
  if (!incoming.length) return 0;
  formFiles.value = [...formFiles.value, ...incoming];
  rebuildPreviews();
  return incoming.length;
}

function removePendingFile(index) {
  if (index < 0 || index >= formFiles.value.length) return;
  formFiles.value = formFiles.value.filter((_, i) => i !== index);
  rebuildPreviews();
}

/**
 * @param {DragEvent} ev
 */
function onBodyDragOver(ev) {
  ev.preventDefault();
  if (ev.dataTransfer) ev.dataTransfer.dropEffect = "copy";
  dropActive.value = true;
}

function onBodyDragLeave(ev) {
  const t = /** @type {HTMLElement} */ (ev.currentTarget);
  const rel = /** @type {Node | null} */ (ev.relatedTarget);
  if (rel && t.contains(rel)) return;
  dropActive.value = false;
}

/**
 * @param {DragEvent} ev
 */
function onBodyDrop(ev) {
  ev.preventDefault();
  dropActive.value = false;
  const n = appendImageFiles(ev.dataTransfer?.files);
  if (n) showToast(`已添加 ${n} 张图`);
}

/**
 * @param {ClipboardEvent} ev
 */
function onBodyPaste(ev) {
  const items = ev.clipboardData?.items;
  if (!items?.length) return;
  /** @type {File[]} */
  const files = [];
  for (const item of items) {
    if (item.kind === "file" && item.type.startsWith("image/")) {
      const f = item.getAsFile();
      if (f) files.push(f);
    }
  }
  if (!files.length) return;
  ev.preventDefault();
  const n = appendImageFiles(files);
  if (n) showToast(`已粘贴 ${n} 张图`);
}

async function refresh() {
  loading.value = true;
  error.value = "";
  try {
    const { items } = await listContentPosts(100, 0);
    posts.value = items;
    if (selectedId.value != null && !items.some((p) => p.id === selectedId.value)) {
      selectedId.value = items[0]?.id ?? null;
    } else if (selectedId.value == null && items[0]) {
      selectedId.value = items[0].id;
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    loading.value = false;
  }
}

function showToast(msg) {
  toast.value = msg;
  window.setTimeout(() => {
    if (toast.value === msg) toast.value = "";
  }, 2200);
}

async function copyPost(post) {
  try {
    const mode = await copyPostToClipboard(post);
    showToast(
      mode === "rich"
        ? "已复制（富文本+链接；备忘录等可出图）"
        : "已复制纯文本链接（多数聊天粘贴仅显示网址）",
    );
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function sharePost(post) {
  try {
    const r = await sharePostNative(post);
    if (r === "unsupported") {
      showToast("当前浏览器不支持系统分享，请用「复制全文」");
      return;
    }
    if (r === "cancelled") return;
    showToast("已打开系统分享");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function copyImageUrl(url) {
  try {
    const mode = await copyImageAsBlob(url);
    showToast(mode === "image" ? "已复制图片（可直接粘贴出图）" : "已复制图片链接");
  } catch {
    showToast("复制失败");
  }
}

function startCreate() {
  editId.value = 0;
  formTitle.value = "";
  formBody.value = "";
  formFiles.value = [];
  revokePreviews();
}

function startEdit(post) {
  editId.value = post.id;
  formTitle.value = post.title || "";
  formBody.value = post.body || "";
  formFiles.value = [];
  revokePreviews();
}

function cancelEdit() {
  editId.value = null;
  formFiles.value = [];
  revokePreviews();
  dropActive.value = false;
}

/** @param {Event} ev */
function onPickFiles(ev) {
  const input = /** @type {HTMLInputElement} */ (ev.target);
  const n = appendImageFiles(input.files);
  input.value = "";
  if (n) showToast(`已添加 ${n} 张图`);
}

async function saveForm() {
  if (editId.value == null) return;
  saving.value = true;
  error.value = "";
  try {
    if (editId.value === 0) {
      const post = await createContentPost({
        title: formTitle.value,
        body: formBody.value,
        files: formFiles.value,
      });
      await refresh();
      selectedId.value = post.id;
      cancelEdit();
      showToast("已创建");
    } else {
      const id = editId.value;
      await updateContentPost(id, { title: formTitle.value, body: formBody.value });
      for (const f of formFiles.value) {
        await uploadContentImage(id, f);
      }
      await refresh();
      selectedId.value = id;
      cancelEdit();
      showToast("已保存");
    }
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  } finally {
    saving.value = false;
  }
}

async function removePost(post) {
  if (!confirm(`删除「${post.title || "无标题"}」？`)) return;
  try {
    await deleteContentPost(post.id);
    if (selectedId.value === post.id) selectedId.value = null;
    await refresh();
    showToast("已删除");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

async function removeImage(imageId) {
  if (!confirm("删除这张图？")) return;
  try {
    await deleteContentImage(imageId);
    await refresh();
    showToast("图片已删");
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
  }
}

function fmtTime(ts) {
  if (!ts) return "";
  const d = new Date(ts * 1000);
  return d.toLocaleString("zh-CN", { hour12: false });
}

watch(selectedId, () => {
  if (editId.value && editId.value !== 0 && editId.value !== selectedId.value) {
    cancelEdit();
  }
});

onMounted(() => {
  syncDesktop();
  mq?.addEventListener("change", syncDesktop);
  void refresh();
});
onUnmounted(() => {
  mq?.removeEventListener("change", syncDesktop);
  revokePreviews();
});
</script>

<template>
  <div class="content-page" :data-desktop="isDesktop ? '1' : '0'">
    <header class="content-head">
      <div>
        <h1>内容板</h1>
        <p class="sub">手机用部署域名打开 · 复制/分享图文</p>
      </div>
      <div class="head-actions">
        <button type="button" class="btn ghost" :disabled="loading" @click="refresh">刷新</button>
        <button v-if="isDesktop" type="button" class="btn primary" @click="startCreate">新建</button>
      </div>
    </header>

    <p v-if="error" class="banner err">{{ error }}</p>
    <p v-if="toast" class="banner ok">{{ toast }}</p>

    <div class="content-layout">
      <aside class="post-list">
        <div v-if="loading && !posts.length" class="empty">加载中…</div>
        <div v-else-if="!posts.length" class="empty">暂无帖子{{ isDesktop ? "，点「新建」开始" : "" }}</div>
        <button
          v-for="p in posts"
          :key="p.id"
          type="button"
          class="post-card"
          :class="{ on: p.id === selectedId }"
          @click="selectedId = p.id"
        >
          <div class="card-title">{{ p.title || "（无标题）" }}</div>
          <div class="card-preview">{{ (p.body || "").slice(0, 80) }}</div>
          <div class="card-meta">
            <span>{{ p.images?.length || 0 }} 图</span>
            <span>{{ fmtTime(p.updated_at) }}</span>
          </div>
        </button>
      </aside>

      <main v-if="selected" class="post-detail">
        <div class="detail-toolbar">
          <button type="button" class="btn primary copy-btn" @click="copyPost(selected)">
            复制全文
          </button>
          <button type="button" class="btn ghost copy-btn" @click="sharePost(selected)">
            分享图文
          </button>
          <template v-if="isDesktop">
            <button type="button" class="btn ghost" @click="startEdit(selected)">编辑</button>
            <button type="button" class="btn danger" @click="removePost(selected)">删除</button>
          </template>
        </div>

        <article class="article">
          <h2>{{ selected.title || "（无标题）" }}</h2>
          <pre class="body">{{ selected.body || "" }}</pre>
          <div v-if="selected.images?.length" class="gallery">
            <figure v-for="img in selected.images" :key="img.id" class="shot">
              <a class="shot-thumb" :href="img.url" target="_blank" rel="noopener" :title="img.original_name || '查看原图'">
                <img :src="img.url" :alt="img.original_name || 'image'" loading="lazy" />
              </a>
              <div class="shot-actions">
                <button type="button" class="btn tiny" @click="copyImageUrl(img.url)">复制图</button>
                <button
                  v-if="isDesktop"
                  type="button"
                  class="btn tiny danger"
                  @click="removeImage(img.id)"
                >
                  删
                </button>
              </div>
            </figure>
          </div>
        </article>
      </main>
      <main v-else class="post-detail empty-detail">
        <p>选择左侧帖子查看；手机上点「复制全文」即可粘贴。</p>
      </main>
    </div>

    <div v-if="isDesktop && editId != null" class="editor-mask" @click.self="cancelEdit">
      <form class="editor" @submit.prevent="saveForm">
        <h3>{{ editId === 0 ? "新建帖子" : "编辑帖子" }}</h3>
        <label>
          标题
          <input v-model="formTitle" type="text" maxlength="200" placeholder="可选" />
        </label>
        <label>
          正文
          <span class="hint">可把图片拖进文本框，或 Ctrl+V 粘贴；预览出现在下方</span>
          <textarea
            v-model="formBody"
            class="body-input"
            :class="{ 'drop-on': dropActive }"
            rows="10"
            placeholder="可复制的文案内容；图片拖到这里"
            @dragenter="onBodyDragOver"
            @dragover="onBodyDragOver"
            @dragleave="onBodyDragLeave"
            @drop="onBodyDrop"
            @paste="onBodyPaste"
          />
        </label>
        <label class="file-label">
          或选择图片
          <input type="file" accept="image/*" multiple @change="onPickFiles" />
        </label>

        <div v-if="formFiles.length" class="pending-gallery">
          <div class="pending-head">{{ formFiles.length }} 张 · 保存后上传</div>
          <div class="pending-grid">
            <figure v-for="(f, i) in formFiles" :key="`${f.name}-${f.size}-${i}`" class="pending-shot">
              <img :src="formPreviewUrls[i]" :alt="f.name" :title="f.name" />
              <button type="button" class="btn tiny danger pending-rm" @click="removePendingFile(i)">×</button>
            </figure>
          </div>
        </div>

        <div class="editor-actions">
          <button type="button" class="btn ghost" @click="cancelEdit">取消</button>
          <button type="submit" class="btn primary" :disabled="saving">
            {{ saving ? "保存中…" : "保存" }}
          </button>
        </div>
      </form>
    </div>
  </div>
</template>

<style scoped>
.content-page {
  --bg: #0e0f12;
  --panel: #16181d;
  --border: #2a2e36;
  --text: #e8eaed;
  --muted: #9aa0a6;
  --accent: #5b9dff;
  --danger: #ff6b6b;
  --ok: #3dd68c;
  height: 100%;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: var(--bg);
  color: var(--text);
  overflow: hidden;
}
.content-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}
.content-head h1 {
  margin: 0;
  font-size: 1.15rem;
  font-weight: 700;
}
.sub {
  margin: 0.2rem 0 0;
  color: var(--muted);
  font-size: 0.8rem;
}
.head-actions {
  display: flex;
  gap: 0.4rem;
  flex-shrink: 0;
}
.banner {
  margin: 0;
  padding: 0.45rem 1rem;
  font-size: 0.85rem;
}
.banner.err {
  background: rgba(255, 107, 107, 0.12);
  color: #ffb4b4;
}
.banner.ok {
  background: rgba(61, 214, 140, 0.12);
  color: #9ef0c4;
}
.content-layout {
  flex: 1;
  min-height: 0;
  display: grid;
  grid-template-columns: 1fr;
  grid-template-rows: minmax(0, 38%) minmax(0, 62%);
}
.content-page[data-desktop="1"] .content-layout {
  grid-template-columns: minmax(240px, 340px) 1fr;
  grid-template-rows: 1fr;
}
.post-list {
  overflow: auto;
  border-bottom: 1px solid var(--border);
  padding: 0.5rem;
  -webkit-overflow-scrolling: touch;
}
.content-page[data-desktop="1"] .post-list {
  border-bottom: none;
  border-right: 1px solid var(--border);
}
.post-card {
  display: block;
  width: 100%;
  text-align: left;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 10px;
  padding: 0.7rem 0.75rem;
  margin-bottom: 0.45rem;
  color: inherit;
  cursor: pointer;
}
.post-card.on {
  border-color: var(--accent);
  box-shadow: inset 0 0 0 1px rgba(91, 157, 255, 0.35);
}
.card-title {
  font-weight: 650;
  font-size: 0.95rem;
}
.card-preview {
  margin-top: 0.25rem;
  color: var(--muted);
  font-size: 0.8rem;
  line-height: 1.35;
  white-space: pre-wrap;
  word-break: break-word;
}
.card-meta {
  margin-top: 0.4rem;
  display: flex;
  justify-content: space-between;
  color: var(--muted);
  font-size: 0.72rem;
}
.post-detail {
  overflow: auto;
  padding: 0.75rem 1rem 1.5rem;
  -webkit-overflow-scrolling: touch;
}
.empty,
.empty-detail {
  color: var(--muted);
  padding: 1rem;
  font-size: 0.9rem;
}
.detail-toolbar {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
  margin-bottom: 0.85rem;
  position: sticky;
  top: 0;
  z-index: 2;
  background: linear-gradient(var(--bg) 70%, transparent);
  padding-bottom: 0.5rem;
}
.copy-btn {
  flex: 1;
  min-width: 8rem;
  min-height: 2.6rem;
  font-size: 1rem;
}
.article h2 {
  margin: 0 0 0.6rem;
  font-size: 1.2rem;
  line-height: 1.35;
}
.body {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-sans-serif, system-ui, -apple-system, "PingFang SC", "Segoe UI", sans-serif;
  font-size: 0.95rem;
  line-height: 1.55;
  color: #dce0e6;
}
.gallery {
  margin-top: 0.75rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.4rem;
}
.shot {
  margin: 0;
  width: 72px;
  background: var(--panel);
  border: 1px solid var(--border);
  border-radius: 8px;
  overflow: hidden;
  flex-shrink: 0;
}
.shot-thumb {
  display: block;
  width: 72px;
  height: 72px;
}
.shot img {
  display: block;
  width: 100%;
  height: 100%;
  object-fit: cover;
  background: #000;
}
.shot-actions {
  display: flex;
  gap: 0.15rem;
  padding: 0.2rem;
  justify-content: center;
}
.shot-actions .btn.tiny {
  padding: 0.12rem 0.28rem;
  font-size: 0.65rem;
  line-height: 1.2;
}
.btn {
  border: 1px solid var(--border);
  background: #1c1f26;
  color: var(--text);
  border-radius: 8px;
  padding: 0.4rem 0.75rem;
  font: inherit;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.btn.primary {
  background: #2a4d8f;
  border-color: #3d6ec4;
}
.btn.danger {
  background: rgba(255, 107, 107, 0.12);
  border-color: rgba(255, 107, 107, 0.45);
  color: #ffb4b4;
}
.btn.ghost {
  background: transparent;
}
.btn.tiny {
  padding: 0.25rem 0.5rem;
  font-size: 0.75rem;
}
.editor-mask {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.55);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 40;
  padding: 1rem;
}
.editor {
  width: min(560px, 100%);
  background: #14171c;
  border: 1px solid var(--border);
  border-radius: 12px;
  padding: 1rem 1.1rem 1.1rem;
  display: flex;
  flex-direction: column;
  gap: 0.7rem;
}
.editor h3 {
  margin: 0;
}
.editor label {
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
  font-size: 0.85rem;
  color: var(--muted);
}
.hint {
  font-size: 0.75rem;
  color: #7a8088;
}
.body-input.drop-on {
  border-color: var(--accent) !important;
  box-shadow: 0 0 0 2px rgba(91, 157, 255, 0.25);
  background: #121820 !important;
}
.file-label {
  font-size: 0.8rem;
}
.pending-gallery {
  border: 1px solid var(--border);
  border-radius: 8px;
  background: #0e1014;
  padding: 0.4rem 0.45rem 0.5rem;
}
.pending-head {
  font-size: 0.72rem;
  color: var(--muted);
  margin-bottom: 0.35rem;
}
.pending-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.pending-shot {
  margin: 0;
  position: relative;
  width: 56px;
  height: 56px;
  flex-shrink: 0;
}
.pending-shot img {
  width: 56px;
  height: 56px;
  object-fit: cover;
  border-radius: 6px;
  border: 1px solid var(--border);
  background: #000;
  display: block;
}
.pending-rm {
  position: absolute;
  top: -4px;
  right: -4px;
  min-width: 1.1rem;
  padding: 0 0.2rem !important;
  font-size: 0.7rem !important;
  line-height: 1.15;
  border-radius: 999px;
}
.editor input[type="text"],
.editor textarea {
  border: 1px solid var(--border);
  background: #0e1014;
  color: var(--text);
  border-radius: 8px;
  padding: 0.5rem 0.6rem;
  font: inherit;
}
.editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 0.45rem;
  margin-top: 0.25rem;
}

@media (max-width: 899px) {
  .content-head {
    padding: 0.7rem 0.75rem;
  }
  .post-detail {
    padding: 0.65rem 0.75rem 1.25rem;
  }
}
</style>
