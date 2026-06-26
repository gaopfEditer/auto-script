<script setup>
import { ref, computed, onMounted, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { analyzeYoutubeArchive } from "../lib/youtubeFetchApi.js";
import { fetchYoutubeArchive, fetchYoutubeArchiveList } from "../lib/youtubeArchivesApi.js";

const route = useRoute();
const router = useRouter();

const loading = ref(false);
const detailLoading = ref(false);
const analyzing = ref(false);
const error = ref("");
const analyzeMsg = ref("");
const archiveDir = ref("");
const items = ref(/** @type {Array<Record<string, unknown>>} */ ([]));
const selectedId = ref("");
const article = ref(/** @type {Record<string, unknown> | null} */ (null));

const analysis = computed(() => {
  const raw = article.value?.analysis;
  return raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : null;
});

const parsedAnalysis = computed(() => {
  const p = analysis.value?.parsed;
  return p && typeof p === "object" ? /** @type {Record<string, unknown>} */ (p) : null;
});

const hasAnalysis = computed(() => Boolean(analysis.value && !analysis.value.error && parsedAnalysis.value));

/** @param {string} text */
function transcriptBlocks(text) {
  const raw = String(text ?? "").trim();
  if (!raw) return [];
  const parts = raw.split(/\n(?=\[\d+:\d{2}\])/);
  return parts.map((p) => p.trim()).filter(Boolean);
}

/** @param {string} block */
function blockTime(block) {
  const m = block.match(/^\[(\d+:\d{2})\]/);
  return m?.[1] ?? "";
}

/** @param {string} block */
function blockBody(block) {
  return block.replace(/^\[\d+:\d{2}\]\s*/, "").trim();
}

/** @param {unknown} v */
function formatFetched(v) {
  if (!v) return "—";
  const d = new Date(String(v));
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString("zh-CN", { hour12: false });
}

async function loadList() {
  loading.value = true;
  error.value = "";
  try {
    const data = await fetchYoutubeArchiveList();
    archiveDir.value = data.dir;
    items.value = data.items;
    const q = String(route.query.v ?? "");
    if (q && items.value.some((x) => String(x.videoId) === q)) {
      selectedId.value = q;
    } else if (!selectedId.value && items.value.length) {
      selectedId.value = String(items.value[0].videoId);
    }
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    loading.value = false;
  }
}

async function loadDetail(videoId) {
  if (!videoId) {
    article.value = null;
    return;
  }
  detailLoading.value = true;
  error.value = "";
  try {
    article.value = await fetchYoutubeArchive(videoId);
  } catch (e) {
    article.value = null;
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    detailLoading.value = false;
  }
}

function selectItem(videoId) {
  selectedId.value = videoId;
  analyzeMsg.value = "";
  router.replace({ query: { ...route.query, v: videoId } });
}

async function runAnalyze() {
  const videoId = selectedId.value;
  if (!videoId || analyzing.value) return;
  analyzing.value = true;
  error.value = "";
  analyzeMsg.value = "正在调用 Ollama 分析，可能需要 1–2 分钟…";
  try {
    await analyzeYoutubeArchive(videoId);
    analyzeMsg.value = "分析完成，已写入归档";
    await Promise.all([loadList(), loadDetail(videoId)]);
  } catch (e) {
    analyzeMsg.value = "";
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    analyzing.value = false;
  }
}

/** @param {unknown} v */
function asStringList(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter(Boolean);
}

watch(selectedId, (id) => {
  void loadDetail(id);
});

onMounted(async () => {
  await loadList();
  if (selectedId.value) await loadDetail(selectedId.value);
});
</script>

<template>
  <div class="archives-page">
    <aside class="archives-list">
      <div class="list-head">
        <h2>YouTube 文稿归档</h2>
        <button type="button" class="btn-sm" :disabled="loading" @click="loadList">刷新</button>
      </div>
      <p class="list-hint">读取 <code>youtube-fetch/archives</code> 本地 JSON</p>
      <p v-if="archiveDir" class="list-dir" :title="archiveDir">{{ archiveDir }}</p>
      <p v-if="error && !article" class="err">{{ error }}</p>
      <p v-if="loading" class="muted">加载列表…</p>
      <p v-else-if="items.length === 0" class="muted">暂无归档；请先用 youtube-fetch 拉取并写入 archives。</p>
      <ul v-else class="items">
        <li
          v-for="row in items"
          :key="String(row.videoId)"
          :class="{ on: selectedId === String(row.videoId) }"
          @click="selectItem(String(row.videoId))"
        >
          <div class="item-title">{{ String(row.title ?? row.videoId) }}</div>
          <div class="item-meta">
            <span class="mono">{{ row.videoId }}</span>
            <span v-if="row.languageLine">{{ String(row.languageLine) }}</span>
          </div>
          <div class="item-meta dim">
            {{ formatFetched(row.fetchedAt) }}
            <span v-if="row.charCount"> · {{ Number(row.charCount).toLocaleString() }} 字</span>
            <span v-if="row.hasAnalysis" class="tag-analyzed">已分析</span>
          </div>
        </li>
      </ul>
    </aside>

    <section class="archives-preview">
      <div v-if="detailLoading" class="preview-empty muted">加载文稿…</div>
      <div v-else-if="!article" class="preview-empty muted">左侧选择一篇归档预览</div>
      <template v-else>
        <header class="preview-head">
          <div class="preview-head-row">
            <h1>{{ String(article.title ?? article.videoId ?? "") }}</h1>
            <button
              type="button"
              class="btn-analyze"
              :disabled="analyzing || detailLoading"
              @click="runAnalyze"
            >
              {{ analyzing ? "分析中…" : hasAnalysis ? "重新分析" : "AI 分析" }}
            </button>
          </div>
          <div class="preview-meta">
            <a
              v-if="article.sourceUrl"
              class="link"
              :href="String(article.sourceUrl)"
              target="_blank"
              rel="noopener noreferrer"
            >
              打开 YouTube
            </a>
            <span v-if="article.languageLine">{{ String(article.languageLine) }}</span>
            <span>归档 {{ formatFetched(article.fetchedAt) }}</span>
            <span v-if="analysis?.analyzedAt">分析 {{ formatFetched(analysis.analyzedAt) }}</span>
            <span class="mono">{{ String(article.videoId) }}</span>
          </div>
          <p v-if="analyzeMsg" class="analyze-msg">{{ analyzeMsg }}</p>
          <p v-if="analysis?.error" class="err analyze-err">上次分析失败：{{ String(analysis.error) }}</p>
        </header>

        <section v-if="parsedAnalysis" class="analysis-panel">
          <h2>AI 分析</h2>
          <ul v-if="asStringList(parsedAnalysis.summary).length" class="analysis-summary">
            <li v-for="(line, i) in asStringList(parsedAnalysis.summary)" :key="i">{{ line }}</li>
          </ul>
          <dl class="analysis-fields">
            <template v-if="parsedAnalysis.symbol">
              <dt>币种</dt><dd>{{ String(parsedAnalysis.symbol) }}</dd>
            </template>
            <template v-if="parsedAnalysis.direction">
              <dt>方向</dt><dd>{{ String(parsedAnalysis.direction) }}</dd>
            </template>
            <template v-if="parsedAnalysis.entry">
              <dt>入场</dt><dd>{{ String(parsedAnalysis.entry) }}</dd>
            </template>
            <template v-if="parsedAnalysis.stopLoss">
              <dt>止损</dt><dd>{{ String(parsedAnalysis.stopLoss) }}</dd>
            </template>
            <template v-if="asStringList(parsedAnalysis.targets).length">
              <dt>止盈</dt>
              <dd>{{ asStringList(parsedAnalysis.targets).join(" · ") }}</dd>
            </template>
            <template v-if="asStringList(parsedAnalysis.keyLevels).length">
              <dt>关键价位</dt>
              <dd>{{ asStringList(parsedAnalysis.keyLevels).join(" · ") }}</dd>
            </template>
            <template v-if="parsedAnalysis.titleHint">
              <dt>摘要标题</dt><dd>{{ String(parsedAnalysis.titleHint) }}</dd>
            </template>
          </dl>
        </section>

        <div class="preview-body">
          <article
            v-for="(block, i) in transcriptBlocks(String(article.transcript ?? ''))"
            :key="i"
            class="para"
          >
            <time v-if="blockTime(block)" class="para-time">{{ blockTime(block) }}</time>
            <p class="para-text">{{ blockBody(block) }}</p>
          </article>
        </div>
      </template>
    </section>
  </div>
</template>

<style scoped>
.archives-page {
  display: grid;
  grid-template-columns: minmax(280px, 34%) 1fr;
  height: 100%;
  min-height: 0;
  background: #1e1f22;
}
.archives-list {
  border-right: 1px solid #3f4147;
  min-height: 0;
  overflow: auto;
  padding: 0.75rem 0.85rem 1rem;
  background: #252526;
}
.list-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.list-head h2 {
  margin: 0;
  font-size: 0.95rem;
  color: #f2f3f5;
}
.list-hint,
.list-dir {
  margin: 0.35rem 0 0;
  font-size: 0.72rem;
  color: #949ba4;
}
.list-dir {
  word-break: break-all;
  opacity: 0.85;
}
code {
  font-size: 0.85em;
  background: #1e1f22;
  padding: 0.05em 0.3em;
  border-radius: 4px;
}
.btn-sm {
  border: 1px solid #3f4147;
  background: #2b2d31;
  color: #dbdee1;
  padding: 0.25rem 0.55rem;
  border-radius: 6px;
  font-size: 0.72rem;
  cursor: pointer;
}
.btn-sm:disabled {
  opacity: 0.5;
}
.items {
  list-style: none;
  margin: 0.75rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.items li {
  padding: 0.55rem 0.6rem;
  border-radius: 8px;
  border: 1px solid transparent;
  cursor: pointer;
  background: #2b2d31;
}
.items li:hover {
  border-color: #3f4147;
}
.items li.on {
  border-color: #5865f2;
  background: rgba(88, 101, 242, 0.12);
}
.item-title {
  font-size: 0.82rem;
  color: #f2f3f5;
  line-height: 1.35;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.item-meta {
  margin-top: 0.25rem;
  font-size: 0.7rem;
  color: #b5bac1;
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem 0.5rem;
}
.item-meta.dim {
  color: #949ba4;
}
.tag-analyzed {
  color: #57f287;
  font-weight: 600;
}
.mono {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
}
.muted {
  color: #949ba4;
  font-size: 0.8rem;
  margin-top: 0.75rem;
}
.err {
  color: #f38688;
  font-size: 0.78rem;
  margin-top: 0.5rem;
}
.archives-preview {
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
}
.preview-empty {
  padding: 2rem 1.25rem;
}
.preview-head {
  flex-shrink: 0;
  padding: 1rem 1.25rem 0.65rem;
  border-bottom: 1px solid #2d2d30;
  background: #252526;
}
.preview-head-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
}
.preview-head h1 {
  margin: 0;
  flex: 1;
  font-size: 1rem;
  line-height: 1.45;
  color: #f2f3f5;
}
.btn-analyze {
  flex-shrink: 0;
  border: 1px solid #5865f2;
  background: rgba(88, 101, 242, 0.15);
  color: #aeb4ff;
  padding: 0.35rem 0.7rem;
  border-radius: 8px;
  font-size: 0.78rem;
  font-weight: 700;
  cursor: pointer;
}
.btn-analyze:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.analyze-msg {
  margin: 0.45rem 0 0;
  font-size: 0.75rem;
  color: #aeb4ff;
}
.analyze-err {
  margin: 0.35rem 0 0;
}
.analysis-panel {
  flex-shrink: 0;
  padding: 0.75rem 1.25rem 0.85rem;
  border-bottom: 1px solid #2d2d30;
  background: #2a2b2f;
}
.analysis-panel h2 {
  margin: 0 0 0.5rem;
  font-size: 0.85rem;
  color: #f2f3f5;
}
.analysis-summary {
  margin: 0 0 0.65rem;
  padding-left: 1.1rem;
  color: #dbdee1;
  font-size: 0.82rem;
  line-height: 1.55;
}
.analysis-fields {
  display: grid;
  grid-template-columns: auto 1fr;
  gap: 0.25rem 0.75rem;
  margin: 0;
  font-size: 0.78rem;
}
.analysis-fields dt {
  color: #949ba4;
  font-weight: 600;
}
.analysis-fields dd {
  margin: 0;
  color: #dbdee1;
}
.preview-meta {
  margin-top: 0.45rem;
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem 0.75rem;
  font-size: 0.72rem;
  color: #949ba4;
}
.link {
  color: #949cfa;
  text-decoration: none;
}
.link:hover {
  text-decoration: underline;
}
.preview-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0.85rem 1.25rem 1.25rem;
}
.para {
  display: grid;
  grid-template-columns: 52px 1fr;
  gap: 0.5rem 0.75rem;
  margin-bottom: 0.65rem;
  align-items: start;
}
.para-time {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 0.72rem;
  color: #5865f2;
  padding-top: 0.15rem;
}
.para-text {
  margin: 0;
  font-size: 0.88rem;
  line-height: 1.65;
  color: #dbdee1;
  word-break: break-word;
}
@media (max-width: 900px) {
  .archives-page {
    grid-template-columns: 1fr;
    grid-template-rows: 38vh 1fr;
  }
  .archives-list {
    border-right: none;
    border-bottom: 1px solid #3f4147;
  }
}
</style>
