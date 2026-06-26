<script setup>
import { ref, computed, onMounted, onUnmounted } from "vue";
import { RouterLink } from "vue-router";
import {
  enqueueYoutubeUrls,
  fetchYoutubeFetchHealth,
  fetchYoutubeQueue,
} from "../lib/youtubeFetchApi.js";

const STORAGE_KEY = "yt-fetch-submitted-urls";

const urlText = ref("");
const lang = ref("");
const analyzeOnFetch = ref(false);
const submitting = ref(false);
const error = ref("");
const health = ref(/** @type {Record<string, unknown> | null} */ (null));
const queueSnap = ref(/** @type {Record<string, unknown>} */ ({}));
const jobs = ref(/** @type {Array<Record<string, unknown>>} */ ([]));
const lastSubmit = ref(/** @type {Array<Record<string, unknown>>} */ ([]));

/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null;

const hasActiveJobs = computed(() => {
  const pending = Number(queueSnap.value.pending) || 0;
  const running = Number(queueSnap.value.running) || 0;
  return pending + running > 0;
});

/** @param {unknown} status */
function statusLabel(status) {
  switch (String(status)) {
    case "skipped":
      return "已存在，跳过";
    case "pending":
      return "等待中";
    case "running":
      return "处理中";
    case "done":
      return "完成";
    case "failed":
      return "失败";
    default:
      return String(status ?? "—");
  }
}

/** @param {unknown} status */
function statusClass(status) {
  const s = String(status);
  if (s === "skipped") return "skipped";
  if (s === "done") return "done";
  if (s === "failed") return "failed";
  if (s === "running") return "running";
  if (s === "pending") return "pending";
  return "";
}

/** @param {string} text */
function parseUrls(text) {
  const lines = String(text)
    .split(/\r?\n/)
    .map((s) => s.trim())
    .filter(Boolean);
  return [...new Set(lines)];
}

function loadSubmittedHistory() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return;
    const arr = JSON.parse(raw);
    if (Array.isArray(arr) && arr.length) {
      urlText.value = arr.filter((x) => typeof x === "string").join("\n");
    }
  } catch {
    /* ignore */
  }
}

/** @param {string[]} urls */
function saveSubmittedHistory(urls) {
  try {
    let prev = [];
    const raw = localStorage.getItem(STORAGE_KEY);
    if (raw) {
      const arr = JSON.parse(raw);
      if (Array.isArray(arr)) prev = arr.filter((x) => typeof x === "string");
    }
    const merged = [...new Set([...urls, ...prev])].slice(0, 200);
    localStorage.setItem(STORAGE_KEY, JSON.stringify(merged));
  } catch {
    /* ignore */
  }
}

async function refreshQueue() {
  try {
    const data = await fetchYoutubeQueue(100);
    queueSnap.value = {
      pending: data.pending,
      running: data.running,
      runningJobId: data.runningJobId,
      total: data.total,
    };
    jobs.value = data.jobs ?? [];
    error.value = "";
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  }
}

async function refreshHealth() {
  try {
    health.value = await fetchYoutubeFetchHealth();
  } catch (e) {
    health.value = { ok: false, error: String(/** @type {Error} */ (e).message ?? e) };
  }
}

async function submit() {
  const urls = parseUrls(urlText.value);
  if (!urls.length) {
    error.value = "请粘贴至少一个 YouTube URL";
    return;
  }
  submitting.value = true;
  error.value = "";
  try {
    const data = await enqueueYoutubeUrls({
      urls,
      lang: lang.value.trim() || undefined,
      analyze: analyzeOnFetch.value,
    });
    lastSubmit.value = data.results ?? [];
    saveSubmittedHistory(urls);
    await refreshQueue();
    await refreshHealth();
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    submitting.value = false;
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    void refreshQueue();
    if (!hasActiveJobs.value) void refreshHealth();
  }, 2000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

onMounted(async () => {
  loadSubmittedHistory();
  await Promise.all([refreshHealth(), refreshQueue()]);
  startPolling();
});

onUnmounted(stopPolling);
</script>

<template>
  <div class="fetch-page">
    <section class="panel submit-panel">
      <div class="panel-head">
        <h2>提交 YouTube URL</h2>
        <RouterLink class="link-archives" to="/archives">查看已归档文稿 →</RouterLink>
      </div>
      <p class="hint">
        每行一个 URL。已归档的视频不会重复拉取；新 URL 会进入
        <strong>youtube-fetch</strong> 串行队列逐个处理。
      </p>
      <p v-if="health" class="health" :class="{ bad: !health.ok && !health.cdpReady }">
        <template v-if="health.ok">
          youtube-fetch
          <span :class="health.cdpReady ? 'ok' : 'warn'">
            {{ health.cdpReady ? "CDP 就绪" : "CDP 未就绪" }}
          </span>
          · 队列等待 {{ queueSnap.pending ?? 0 }} · 处理中 {{ queueSnap.running ?? 0 }}
          <template v-if="health.analyze">
            · 分析模型 {{ health.analyze.model }}
          </template>
        </template>
        <template v-else>{{ health.error || "youtube-fetch 不可用" }}</template>
      </p>
      <label class="field">
        <span>URL（多行）</span>
        <textarea
          v-model="urlText"
          rows="8"
          placeholder="https://www.youtube.com/watch?v=...
https://youtu.be/..."
          spellcheck="false"
        />
      </label>
      <label class="field inline">
        <span>语言（可选）</span>
        <input v-model="lang" type="text" placeholder="en" />
      </label>
      <label class="field checkbox">
        <input v-model="analyzeOnFetch" type="checkbox" />
        <span>拉取完成后调用 Ollama 分析（需 8000 端口可用）</span>
      </label>
      <div class="actions">
        <button type="button" class="btn primary" :disabled="submitting" @click="submit">
          {{ submitting ? "提交中…" : "提交并拉取" }}
        </button>
        <button type="button" class="btn" :disabled="submitting" @click="refreshQueue">刷新队列</button>
      </div>
      <p v-if="error" class="err">{{ error }}</p>
      <ul v-if="lastSubmit.length" class="submit-results">
        <li v-for="(row, i) in lastSubmit" :key="i">
          <template v-if="row.ok && row.skipped">
            <span class="badge skipped">已存在，跳过</span>
            <span class="vid">{{ row.job?.videoId }}</span>
          </template>
          <template v-else-if="row.ok && row.duplicate">
            <span class="badge pending">已在队列</span>
            <span class="vid">{{ row.job?.videoId }}</span>
          </template>
          <template v-else-if="row.ok && row.queued">
            <span class="badge pending">已入队</span>
            <span class="vid">{{ row.job?.videoId }}</span>
          </template>
          <template v-else>
            <span class="badge failed">无效</span>
            <span class="vid">{{ row.url || "—" }}</span>
            <span class="msg">{{ row.error }}</span>
          </template>
        </li>
      </ul>
    </section>

    <section class="panel queue-panel">
      <div class="panel-head">
        <h2>处理队列</h2>
        <span class="queue-meta">共 {{ queueSnap.total ?? 0 }} 条记录</span>
      </div>
      <p v-if="jobs.length === 0" class="muted">暂无任务；提交 URL 后将显示在这里。</p>
      <ul v-else class="jobs">
        <li v-for="job in jobs" :key="String(job.id)" :class="statusClass(job.status)">
          <div class="job-top">
            <span class="badge" :class="statusClass(job.status)">{{ statusLabel(job.status) }}</span>
            <span class="job-id">#{{ job.id }}</span>
            <RouterLink
              v-if="job.status === 'done' || job.status === 'skipped'"
              class="job-link"
              :to="{ path: '/archives', query: { v: String(job.videoId) } }"
            >
              查看文稿
            </RouterLink>
          </div>
          <div class="job-title">{{ job.title || job.videoId }}</div>
          <div class="job-url" :title="String(job.url)">{{ job.url }}</div>
          <div v-if="job.error" class="job-err">{{ job.error }}</div>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
.fetch-page {
  display: grid;
  grid-template-columns: minmax(280px, 1fr) minmax(320px, 1.1fr);
  gap: 1rem;
  height: 100%;
  min-height: 0;
  padding: 1rem;
  overflow: auto;
  background: #1e1f22;
}
.panel {
  background: #2b2d31;
  border: 1px solid #3f4147;
  border-radius: 10px;
  padding: 1rem 1.1rem;
  min-height: 0;
  overflow: auto;
}
.panel-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 0.75rem;
  margin-bottom: 0.5rem;
}
h2 {
  margin: 0;
  font-size: 1.05rem;
  color: #f2f3f5;
}
.link-archives,
.job-link {
  color: #5865f2;
  text-decoration: none;
  font-size: 0.82rem;
  font-weight: 600;
}
.hint,
.muted {
  color: #949ba4;
  font-size: 0.85rem;
  line-height: 1.5;
  margin: 0 0 0.75rem;
}
.health {
  font-size: 0.8rem;
  color: #b5bac1;
  margin: 0 0 0.75rem;
}
.health .ok {
  color: #57f287;
}
.health .warn {
  color: #fee75c;
}
.health.bad {
  color: #f38688;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-bottom: 0.75rem;
}
.field span {
  font-size: 0.78rem;
  color: #b5bac1;
  font-weight: 600;
}
.field textarea,
.field input {
  background: #1e1f22;
  border: 1px solid #3f4147;
  border-radius: 8px;
  color: #dbdee1;
  padding: 0.55rem 0.65rem;
  font-family: ui-monospace, Consolas, monospace;
  font-size: 0.82rem;
  resize: vertical;
}
.field.inline {
  max-width: 12rem;
}
.field.checkbox {
  flex-direction: row;
  align-items: center;
  gap: 0.5rem;
}
.field.checkbox input {
  width: auto;
  margin: 0;
}
.field.checkbox span {
  font-weight: 500;
}
.actions {
  display: flex;
  gap: 0.6rem;
  flex-wrap: wrap;
}
.btn {
  border: 1px solid #3f4147;
  background: #1e1f22;
  color: #dbdee1;
  padding: 0.5rem 0.85rem;
  border-radius: 8px;
  font-weight: 600;
  font-size: 0.85rem;
  cursor: pointer;
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.btn.primary {
  background: #5865f2;
  border-color: #5865f2;
  color: #fff;
}
.err {
  color: #f38688;
  font-size: 0.85rem;
  margin: 0.75rem 0 0;
}
.submit-results,
.jobs {
  list-style: none;
  margin: 0.85rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.submit-results li,
.jobs li {
  background: #1e1f22;
  border: 1px solid #3f4147;
  border-radius: 8px;
  padding: 0.55rem 0.65rem;
  font-size: 0.82rem;
}
.vid {
  font-family: ui-monospace, Consolas, monospace;
  color: #dbdee1;
  margin-left: 0.45rem;
}
.msg {
  display: block;
  color: #f38688;
  margin-top: 0.2rem;
}
.queue-meta {
  font-size: 0.78rem;
  color: #949ba4;
}
.job-top {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  flex-wrap: wrap;
}
.job-id {
  color: #949ba4;
  font-size: 0.75rem;
}
.job-title {
  color: #f2f3f5;
  font-weight: 600;
  margin-top: 0.25rem;
}
.job-url {
  color: #949ba4;
  font-size: 0.75rem;
  margin-top: 0.15rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.job-err {
  color: #f38688;
  font-size: 0.78rem;
  margin-top: 0.25rem;
}
.badge {
  display: inline-block;
  padding: 0.12rem 0.45rem;
  border-radius: 999px;
  font-size: 0.72rem;
  font-weight: 700;
  background: #3f4147;
  color: #dbdee1;
}
.badge.skipped {
  background: rgba(87, 242, 135, 0.15);
  color: #57f287;
}
.badge.done {
  background: rgba(87, 242, 135, 0.15);
  color: #57f287;
}
.badge.pending,
.badge.running {
  background: rgba(88, 101, 242, 0.2);
  color: #aeb4ff;
}
.badge.failed {
  background: rgba(237, 66, 69, 0.15);
  color: #f38688;
}
@media (max-width: 900px) {
  .fetch-page {
    grid-template-columns: 1fr;
  }
}
</style>
