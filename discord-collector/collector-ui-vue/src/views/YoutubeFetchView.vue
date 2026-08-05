<script setup>
import { ref, computed, watch, onMounted, onUnmounted, reactive } from "vue";
import { RouterLink, useRoute } from "vue-router";
import SignalEvaluationForm from "../components/SignalEvaluationForm.vue";
import { fetchSignalConfig } from "../lib/discordSignalApi.js";
import {
  emptyExecution,
  seedActualFromPlanned,
  takeProfitText,
} from "../lib/signalExecution.js";
import {
  enqueueYoutubeUrls,
  fetchYoutubeFetchHealth,
  fetchYoutubeQueue,
  parsePastedYoutubeText,
  fetchPasteFileList,
  fetchPasteFileResult,
  fetchPasteFileRaw,
  triggerPasteFileScan,
  parsePasteFileByName,
  registerCoinActionWatches,
} from "../lib/youtubeFetchApi.js";
import {
  calcProfitPercents,
  formatProfitPercent,
  directionLabel,
} from "../lib/signalExecution.js";

const STORAGE_KEY = "yt-fetch-submitted-urls";
const PASTE_STORAGE_KEY = "yt-fetch-paste-draft";
const MODE_STORAGE_KEY = "yt-fetch-mode";

/** @typedef {'youtube' | 'paste'} FetchMode */

const route = useRoute();

const mode = ref(/** @type {FetchMode} */ ("youtube"));
const urlText = ref("");
const pasteText = ref("");
const lang = ref("");
const analyzeOnFetch = ref(false);
const submitting = ref(false);
const parsing = ref(false);
const error = ref("");
const pasteError = ref("");
const parseMsg = ref("");
const health = ref(/** @type {Record<string, unknown> | null} */ (null));
const queueSnap = ref(/** @type {Record<string, unknown>} */ ({}));
const jobs = ref(/** @type {Array<Record<string, unknown>>} */ ([]));
const lastSubmit = ref(/** @type {Array<Record<string, unknown>>} */ ([]));
const pastePreview = ref(/** @type {Record<string, unknown> | null} */ (null));

const pasteInputDir = ref("");
const pasteOutputDir = ref("");
const pasteScan = ref(/** @type {Record<string, unknown>} */ ({}));
const pasteFiles = ref(/** @type {Array<Record<string, unknown>>} */ ([]));
const selectedPasteFile = ref("");
const pasteListError = ref("");
const scanningPaste = ref(false);
/** 前端兜底：发现 pending 且后台未在扫时自动触发一次 */
let autoScanCooldownUntil = 0;
const showManualPaste = ref(false);
/** 右侧详情：概要&卡片 | 全文 */
const pasteDetailTab = ref(/** @type {"cards" | "fulltext"} */ ("cards"));
const pasteFullText = ref("");

const previewJson = computed(() =>
  pastePreview.value ? JSON.stringify(pastePreview.value, null, 2) : ""
);

const pasteFullTextDisplay = computed(() => {
  const raw = String(pasteFullText.value ?? "").trim();
  if (raw) return raw;
  return String(
    pastePreview.value?.content ?? pastePreview.value?.rawContent ?? ""
  ).trim();
});

const previewCardFields = computed(() => {
  const cf = pastePreview.value?.cardFields;
  return cf && typeof cf === "object" ? /** @type {Record<string, unknown>} */ (cf) : null;
});

const coinActions = computed(() => {
  const list = pastePreview.value?.coinActions;
  return Array.isArray(list) ? list : [];
});

const coinEvalEditing = computed(() => {
  const key = coinEvalEditingKey.value;
  if (!key) return null;
  for (let i = 0; i < coinActions.value.length; i++) {
    const coin = /** @type {Record<string, unknown>} */ (coinActions.value[i]);
    if (coinEvalKey(coin, i) === key) return { coin, i, key };
  }
  return null;
});

/** @type {Record<string, import("../lib/signalExecution.js").SignalExecution>} */
const coinEvalByKey = reactive({});
/** @type {Record<string, string>} */
const coinEvalTpByKey = reactive({});
/** @type {Record<string, string>} */
const coinEvalNoteByKey = reactive({});
const coinEvalEditingKey = ref("");
const coinWatchMsg = ref("");

/** @param {Record<string, unknown>} coin @param {number} i */
function coinEvalKey(coin, i) {
  return `${String(coin.symbol)}-${String(coin.actionType)}-${i}`;
}

/** @param {Record<string, unknown>} coin */
function executionFromCoin(coin) {
  const targets = Array.isArray(coin.targets) ? coin.targets.map((t) => String(t)) : [];
  return {
    ...emptyExecution(),
    symbol: String(coin.symbol ?? ""),
    direction: String(coin.direction ?? "").trim(),
    planned: {
      entryPrice: String(coin.entry ?? ""),
      takeProfitPrices: targets,
      stopLossPrice: String(coin.stopLoss ?? ""),
    },
    actual: { ...emptyExecution().actual },
  };
}

/** @param {Record<string, unknown>} coin */
function initCoinEvalDraft(coin) {
  const ex = executionFromCoin(coin);
  seedActualFromPlanned(ex);
  return ex;
}

function resetCoinEvalDrafts() {
  for (const k of Object.keys(coinEvalByKey)) delete coinEvalByKey[k];
  for (const k of Object.keys(coinEvalTpByKey)) delete coinEvalTpByKey[k];
  for (const k of Object.keys(coinEvalNoteByKey)) delete coinEvalNoteByKey[k];
  coinEvalEditingKey.value = "";
}

/** @param {string} key */
function openCoinEdit(key) {
  if (!coinEvalByKey[key]) return;
  coinEvalEditingKey.value = key;
}

function closeCoinEdit() {
  coinEvalEditingKey.value = "";
}

/** @param {string} key */
function coinEvalSummaryLine(key) {
  const ex = coinEvalByKey[key];
  if (!ex) return "";
  const entry = String(ex.actual?.buyPrice ?? ex.planned?.entryPrice ?? "").trim();
  const note = String(coinEvalNoteByKey[key] ?? ex.outcomeNote ?? "").trim();
  const profit = calcProfitPercents(
    ex.actual?.buyPrice,
    ex.actual?.sellPrice,
    ex.direction,
    undefined,
    ex.symbol
  );
  const parts = [];
  if (entry) parts.push(`入场 ${entry}`);
  if (ex.direction) parts.push(String(ex.direction));
  if (profit) {
    parts.push(`${directionLabel(profit.side)} ${formatProfitPercent(profit.leveragePct)} (${profit.leverage}x)`);
  }
  if (note) parts.push(note.slice(0, 80));
  return parts.join(" · ") || "—";
}

/** @param {Record<string, unknown>} coin */
function coinBriefNote(coin, key) {
  const note = String(coinEvalNoteByKey[key] ?? coin.description ?? "").trim();
  return note || "—";
}

async function syncCoinActionWatchRegistration() {
  coinWatchMsg.value = "";
  const list = coinActions.value;
  if (!list.length || !pastePreview.value) return;
  const sourceRef =
    selectedPasteFile.value ||
    `manual-${String(pastePreview.value.title ?? "paste").slice(0, 60)}`;
  try {
    const data = await registerCoinActionWatches({
      sourceRef,
      title: String(pastePreview.value.title ?? ""),
      coinActions: list,
    });
    const n = Number(data.registered ?? 0);
    const s = Number(data.skipped ?? 0);
    coinWatchMsg.value =
      s > 0
        ? `已同步 ${n} 条（跳过近1小时重复 ${s} 条 · 颜驰 · ±5%）`
        : `已同步 ${n} 条入场监听（颜驰 · ±5% · 每 5min）`;
  } catch (e) {
    coinWatchMsg.value = String(/** @type {Error} */ (e).message ?? e);
  }
}

function syncCoinEvalDrafts() {
  const list = coinActions.value;
  for (let i = 0; i < list.length; i++) {
    const coin = /** @type {Record<string, unknown>} */ (list[i]);
    const key = coinEvalKey(coin, i);
    if (coinEvalByKey[key]) continue;
    coinEvalByKey[key] = initCoinEvalDraft(coin);
    coinEvalTpByKey[key] = takeProfitText(coinEvalByKey[key].actual);
    coinEvalNoteByKey[key] = "";
  }
}

watch(coinActions, () => syncCoinEvalDrafts(), { immediate: true });
watch(
  () =>
    `${selectedPasteFile.value}|${String(pastePreview.value?.generatedAt ?? "")}|${String(pastePreview.value?.title ?? "")}|${coinActions.value.length}`,
  () => {
    resetCoinEvalDrafts();
    syncCoinEvalDrafts();
    // 同步仅在「解析完成」后触发，选中已有文件不自动同步
  }
);

/** @param {string} type */
function actionTypeLabel(type) {
  switch (String(type)) {
    case "new":
      return "新开仓";
    case "continue":
      return "持仓更新";
    case "toend":
      return "临近目标";
    case "end":
      return "已结束";
    default:
      return String(type || "—");
  }
}

/** @param {string} type */
function actionTypeClass(type) {
  switch (String(type)) {
    case "new":
      return "act-new";
    case "continue":
      return "act-continue";
    case "toend":
      return "act-toend";
    case "end":
      return "act-end";
    default:
      return "";
  }
}

/** @param {Record<string, unknown>} coin */
function coinActionDetail(coin) {
  const parts = [];
  if (coin.direction) parts.push(String(coin.direction));
  if (coin.entry) parts.push(`入场 ${coin.entry}`);
  if (coin.stopLoss) parts.push(`止损 ${coin.stopLoss}`);
  if (Array.isArray(coin.targets) && coin.targets.length) parts.push(`目标 ${coin.targets.join(" / ")}`);
  if (coin.pnl) parts.push(String(coin.pnl));
  return parts.join(" · ") || "—";
}

/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null;

const hasActiveJobs = computed(() => {
  const pending = Number(queueSnap.value.pending) || 0;
  const running = Number(queueSnap.value.running) || 0;
  return pending + running > 0;
});

const pasteScanRunning = computed(() => Boolean(pasteScan.value?.running));

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
function pasteFileStatusLabel(status) {
  switch (String(status)) {
    case "done":
      return "已解析";
    case "parsing":
      return "解析中";
    case "pending":
      return "待解析";
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
  if (s === "running" || s === "parsing") return "running";
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
  try {
    const draft = localStorage.getItem(PASTE_STORAGE_KEY);
    if (draft) pasteText.value = draft;
  } catch {
    /* ignore */
  }
  try {
    const m = localStorage.getItem(MODE_STORAGE_KEY);
    if (m === "youtube" || m === "paste") mode.value = m;
  } catch {
    /* ignore */
  }
}

watch(mode, (m) => {
  try {
    localStorage.setItem(MODE_STORAGE_KEY, m);
  } catch {
    /* ignore */
  }
});

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

async function refreshPasteFiles() {
  try {
    const data = await fetchPasteFileList();
    pasteInputDir.value = String(data.inputDir ?? "");
    pasteOutputDir.value = String(data.outputDir ?? "");
    pasteScan.value = data.scan && typeof data.scan === "object" ? data.scan : {};
    pasteFiles.value = Array.isArray(data.items) ? data.items : [];
    pasteListError.value = "";

    // 有未解析文件且后台未在扫 → 最长每 10 分钟兜底触发一次（主扫描由后端负责）
    const pending = pasteFiles.value.filter((f) => f.status === "pending" || !f.hasOutput);
    const running = Boolean(pasteScan.value?.running);
    if (pending.length && !running && Date.now() >= autoScanCooldownUntil) {
      autoScanCooldownUntil = Date.now() + 600_000;
      void triggerPasteFileScan().catch(() => {});
    }
  } catch (e) {
    pasteListError.value = String(/** @type {Error} */ (e).message ?? e);
  }
}

/** @param {string} name */
async function selectPasteFile(name) {
  selectedPasteFile.value = name;
  pasteError.value = "";
  parseMsg.value = "";
  pasteFullText.value = "";
  pasteDetailTab.value = "cards";
  const row = pasteFiles.value.find((f) => f.name === name);
  try {
    const raw = await fetchPasteFileRaw(name);
    pasteFullText.value = String(raw.text ?? "");
  } catch {
    pasteFullText.value = "";
  }
  if (row?.status === "done" || row?.hasOutput) {
    try {
      const { data } = await fetchPasteFileResult(name);
      pastePreview.value =
        data.preview && typeof data.preview === "object"
          ? /** @type {Record<string, unknown>} */ (data.preview)
          : data && typeof data === "object"
            ? /** @type {Record<string, unknown>} */ (data)
            : null;
      // 无原文时才回退到解析结果里的正文
      if (!pasteFullText.value.trim()) {
        pasteFullText.value = String(
          pastePreview.value?.content ?? data.content ?? ""
        );
      }
    } catch (e) {
      pastePreview.value = null;
      pasteError.value = String(/** @type {Error} */ (e).message ?? e);
    }
  } else {
    pastePreview.value = null;
  }
}

async function runPasteScan() {
  scanningPaste.value = true;
  pasteListError.value = "";
  try {
    await triggerPasteFileScan();
    await refreshPasteFiles();
  } catch (e) {
    pasteListError.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    scanningPaste.value = false;
  }
}

/** @param {string} name */
async function forceParseFile(name) {
  parsing.value = true;
  pasteError.value = "";
  parseMsg.value = `正在解析 ${name}…`;
  try {
    const row = await parsePasteFileByName(name, { force: true });
    await refreshPasteFiles();
    await selectPasteFile(name);
    const sync = row.sync && typeof row.sync === "object" ? row.sync : null;
    const n = Number(sync?.registered ?? 0);
    const s = Number(sync?.skipped ?? 0);
    if (sync) {
      parseMsg.value =
        s > 0 ? `解析完成；同步 ${n} 条，跳过近1小时重复 ${s} 条` : `解析完成；同步 ${n} 条币种卡片`;
      coinWatchMsg.value = parseMsg.value;
    } else {
      parseMsg.value = "解析完成";
    }
  } catch (e) {
    pasteError.value = String(/** @type {Error} */ (e).message ?? e);
    parseMsg.value = "";
  } finally {
    parsing.value = false;
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

async function runPasteParse() {
  const text = pasteText.value.trim();
  if (!text) {
    pasteError.value = "请粘贴文稿：第一行标题，其余为正文";
    return;
  }
  parsing.value = true;
  pasteError.value = "";
  parseMsg.value = "正在解析概要与币种（Ollama）…";
  selectedPasteFile.value = "";
  pastePreview.value = null;
  pasteFullText.value = text;
  pasteDetailTab.value = "cards";
  try {
    localStorage.setItem(PASTE_STORAGE_KEY, pasteText.value);
    const data = await parsePastedYoutubeText({ text });
    pastePreview.value = data.preview ?? null;
    await syncCoinActionWatchRegistration();
    parseMsg.value = coinWatchMsg.value || "解析完成";
  } catch (e) {
    parseMsg.value = "";
    pasteError.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    parsing.value = false;
  }
}

/** @param {unknown} v */
function asStringList(v) {
  if (!Array.isArray(v)) return [];
  return v.map((x) => String(x)).filter(Boolean);
}

async function copyPreviewJson() {
  if (!previewJson.value) return;
  try {
    await navigator.clipboard.writeText(previewJson.value);
    parseMsg.value = "JSON 已复制到剪贴板";
  } catch {
    parseMsg.value = "复制失败，请手动选择 JSON 复制";
  }
}

function startPolling() {
  stopPolling();
  pollTimer = setInterval(() => {
    if (mode.value === "youtube") {
      void refreshQueue();
      if (!hasActiveJobs.value) void refreshHealth();
    } else {
      void refreshPasteFiles();
      if (selectedPasteFile.value) {
        const row = pasteFiles.value.find((f) => f.name === selectedPasteFile.value);
        if (row?.status === "done" && !pastePreview.value) {
          void selectPasteFile(selectedPasteFile.value);
        }
      }
    }
  }, mode.value === "youtube" ? 2000 : 3000);
}

function stopPolling() {
  if (pollTimer) {
    clearInterval(pollTimer);
    pollTimer = null;
  }
}

watch(mode, () => {
  startPolling();
  if (mode.value === "paste") void refreshPasteFiles();
});

/** 从卡片来源跳转：/fetch?mode=paste&file=xxx.txt&tab=fulltext */
async function applyRouteQuery() {
  const q = route.query;
  const modeQ = String(q.mode ?? "").trim();
  if (modeQ === "youtube" || modeQ === "paste") {
    mode.value = modeQ;
  }
  const tabQ = String(q.tab ?? "").trim();
  if (tabQ === "cards" || tabQ === "fulltext") {
    pasteDetailTab.value = tabQ;
  }
  const file = String(q.file ?? "").trim();
  if (!file || !file.toLowerCase().endsWith(".txt")) return;
  if (mode.value !== "paste") mode.value = "paste";
  await refreshPasteFiles();
  await selectPasteFile(file);
  if (tabQ === "fulltext") pasteDetailTab.value = "fulltext";
}

watch(
  () => `${route.query.mode ?? ""}|${route.query.file ?? ""}|${route.query.tab ?? ""}`,
  () => {
    void applyRouteQuery();
  }
);

onMounted(async () => {
  loadSubmittedHistory();
  await Promise.all([refreshHealth(), refreshQueue(), refreshPasteFiles(), fetchSignalConfig()]);
  await applyRouteQuery();
  startPolling();
  document.addEventListener("keydown", onCoinEditEscape);
});

onUnmounted(() => {
  stopPolling();
  document.removeEventListener("keydown", onCoinEditEscape);
});

/** @param {KeyboardEvent} e */
function onCoinEditEscape(e) {
  if (e.key === "Escape" && coinEvalEditingKey.value) closeCoinEdit();
}
</script>

<template>
  <div class="fetch-page">
    <header class="fetch-topbar">
      <nav class="mode-tabs">
        <button type="button" class="mode-tab" :class="{ on: mode === 'youtube' }" @click="mode = 'youtube'">
          YouTube 拉取
        </button>
        <button type="button" class="mode-tab" :class="{ on: mode === 'paste' }" @click="mode = 'paste'">
          文稿解析
        </button>
      </nav>
      <div class="topbar-actions">
        <RouterLink v-if="mode === 'youtube'" class="link-archives" to="/archives">查看已归档文稿 →</RouterLink>
      </div>
    </header>

    <!-- YouTube 全屏 -->
    <div v-if="mode === 'youtube'" class="mode-body mode-youtube">
      <section class="panel submit-panel">
        <div class="panel-head">
          <h2>提交 YouTube URL</h2>
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
            <template v-if="health.analyze"> · 分析模型 {{ health.analyze.model }} </template>
          </template>
          <template v-else>{{ health.error || "youtube-fetch 不可用" }}</template>
        </p>
        <label class="field">
          <span>URL（多行）</span>
          <textarea
            v-model="urlText"
            rows="10"
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

    <!-- 文稿解析全屏 -->
    <div v-else class="mode-body mode-paste">
      <aside class="panel paste-list-panel">
        <div class="panel-head">
          <h2>文稿文件</h2>
          <span class="paste-tag">自动扫描</span>
        </div>
        <p class="hint dir-hint" :title="pasteInputDir">
          输入目录：<code>{{ pasteInputDir || "—" }}</code>
          <span class="paste-auto-hint"> · 新文件自动解析</span>
        </p>
        <p v-if="pasteScanRunning" class="scan-hint">
          正在解析 <strong>{{ pasteScan.currentFile || "…" }}</strong>
        </p>
        <div class="actions">
          <button type="button" class="btn primary" :disabled="scanningPaste || pasteScanRunning" @click="runPasteScan">
            {{ scanningPaste || pasteScanRunning ? "扫描中…" : "扫描并解析" }}
          </button>
          <button type="button" class="btn" @click="refreshPasteFiles">刷新列表</button>
        </div>
        <p v-if="pasteListError" class="err">{{ pasteListError }}</p>
        <p v-if="!pasteFiles.length && !pasteListError" class="muted">目录下暂无 .txt 文件。</p>
        <ul v-else class="paste-files">
          <li
            v-for="file in pasteFiles"
            :key="String(file.name)"
            :class="[{ selected: selectedPasteFile === file.name }, statusClass(file.status)]"
            @click="selectPasteFile(String(file.name))"
          >
            <div class="pf-top">
              <span class="badge" :class="statusClass(file.status)">{{ pasteFileStatusLabel(file.status) }}</span>
              <span v-if="file.coinActionCount" class="pf-count">{{ file.coinActionCount }} 币种</span>
            </div>
            <div class="pf-name">{{ file.name }}</div>
            <div v-if="file.title" class="pf-title">{{ file.title }}</div>
          </li>
        </ul>
        <button type="button" class="btn linkish" @click="showManualPaste = !showManualPaste">
          {{ showManualPaste ? "收起手动粘贴" : "展开手动粘贴" }}
        </button>
        <div v-if="showManualPaste" class="manual-paste">
            <label class="field">
              <span>文稿（第一行 = 标题）</span>
              <textarea v-model="pasteText" rows="6" spellcheck="false" />
            </label>
            <button type="button" class="btn primary" :disabled="parsing" @click="runPasteParse">
              {{ parsing ? "解析中…" : "手动解析" }}
            </button>
          </div>
      </aside>

      <main class="panel paste-detail-panel">
        <div class="panel-head">
          <h2>{{ selectedPasteFile || "解析预览" }}</h2>
          <div v-if="selectedPasteFile" class="detail-actions">
            <button type="button" class="btn" :disabled="parsing" @click="forceParseFile(selectedPasteFile)">
              重新解析
            </button>
            <button v-if="pastePreview" type="button" class="btn" @click="copyPreviewJson">复制 JSON</button>
          </div>
        </div>
        <p v-if="!selectedPasteFile && !pastePreview" class="muted">从左侧选择文件，或使用手动粘贴解析。</p>
        <p v-if="parseMsg" class="parse-msg">{{ parseMsg }}</p>
        <p v-if="pasteError" class="err">{{ pasteError }}</p>

        <nav v-if="selectedPasteFile || pastePreview || pasteFullTextDisplay" class="detail-tabs">
          <button
            type="button"
            class="detail-tab"
            :class="{ on: pasteDetailTab === 'cards' }"
            @click="pasteDetailTab = 'cards'"
          >
            概要&卡片
          </button>
          <button
            type="button"
            class="detail-tab"
            :class="{ on: pasteDetailTab === 'fulltext' }"
            @click="pasteDetailTab = 'fulltext'"
          >
            全文
          </button>
        </nav>

        <div v-if="pasteDetailTab === 'cards'" class="detail-tab-body">
          <div v-if="pastePreview" class="preview-wrap">
            <div class="preview-upper">
              <div v-if="asStringList(pastePreview.summary).length" class="summary-block">
                <div class="fn">全文概要</div>
                <ul>
                  <li v-for="(line, i) in asStringList(pastePreview.summary)" :key="i">{{ line }}</li>
                </ul>
              </div>

              <div v-if="coinActions.length" class="coin-actions">
                <div class="coin-actions-head">
                  <span class="fn">币种操作</span>
                  <span class="coin-count">{{ coinActions.length }} 条</span>
                </div>
                <p v-if="coinWatchMsg" class="coin-watch-msg">{{ coinWatchMsg }}</p>
                <article
                  v-for="(coin, i) in coinActions"
                  :key="`${coin.symbol}-${coin.actionType}-${i}`"
                  class="coin-action-card"
                  role="button"
                  tabindex="0"
                  @click="openCoinEdit(coinEvalKey(coin, i))"
                  @keydown.enter="openCoinEdit(coinEvalKey(coin, i))"
                >
                  <header class="coin-action-top">
                    <strong class="coin-sym">{{ coin.symbol }}</strong>
                    <span class="action-badge" :class="actionTypeClass(String(coin.actionType))">
                      {{ actionTypeLabel(String(coin.actionType)) }}
                    </span>
                    <span v-if="coin.direction" class="coin-dir">{{ coin.direction }}</span>
                    <span v-if="coin.entry" class="coin-watch-badge">监听 ±5%</span>
                  </header>
                  <p class="coin-brief-line">
                    <span class="coin-brief-label">入场</span>
                    {{ coin.entry || "—" }}
                  </p>
                  <p class="coin-brief-line coin-brief-note">
                    <span class="coin-brief-label">备注</span>
                    {{ coinBriefNote(coin, coinEvalKey(coin, i)) }}
                  </p>
                  <p v-if="coinEvalByKey[coinEvalKey(coin, i)]" class="coin-brief-eval">
                    {{ coinEvalSummaryLine(coinEvalKey(coin, i)) }}
                  </p>
                  <button
                    type="button"
                    class="coin-edit-btn"
                    @click.stop="openCoinEdit(coinEvalKey(coin, i))"
                  >
                    编辑评价
                  </button>
                </article>
              </div>
              <p v-else class="muted">未识别到币种操作。</p>

              <div v-if="previewCardFields" class="embed-preview">
                <h3>{{ String(previewCardFields.title ?? pastePreview.title) }}</h3>
                <p v-if="previewCardFields.description" class="embed-desc">{{ previewCardFields.description }}</p>
                <div v-if="Array.isArray(previewCardFields.fields)" class="embed-fields">
                  <div
                    v-for="(f, i) in previewCardFields.fields"
                    :key="i"
                    class="embed-field"
                    :class="{ inline: f.inline }"
                  >
                    <div class="fn">{{ f.name }}</div>
                    <div class="fv">{{ f.value }}</div>
                  </div>
                </div>
              </div>
            </div>
            <details class="json-block" open>
              <summary>预览 JSON</summary>
              <div class="json-scroll">
                <pre>{{ previewJson }}</pre>
              </div>
            </details>
          </div>
          <p v-else-if="selectedPasteFile" class="muted">尚未解析；可点「重新解析」，或先切换到「全文」查看原文。</p>
        </div>

        <div v-else class="detail-tab-body fulltext-tab">
          <div v-if="pasteFullTextDisplay" class="fulltext-scroll">
            <pre class="fulltext-pre">{{ pasteFullTextDisplay }}</pre>
          </div>
          <p v-else class="muted">暂无全文内容。</p>
        </div>
      </main>
    </div>
  </div>

  <div
    v-if="coinEvalEditing && coinEvalByKey[coinEvalEditing.key]"
    class="modal-backdrop"
    @click.self="closeCoinEdit"
  >
    <div class="modal-panel" role="dialog" aria-modal="true">
      <header class="modal-head">
        <h3>
          {{ coinEvalEditing.coin.symbol }}
          <span class="modal-sub">{{ actionTypeLabel(String(coinEvalEditing.coin.actionType)) }}</span>
        </h3>
        <button type="button" class="modal-close" aria-label="关闭" @click="closeCoinEdit">×</button>
      </header>
      <div class="modal-body">
        <p class="coin-detail">{{ coinActionDetail(coinEvalEditing.coin) }}</p>
        <SignalEvaluationForm
          v-model="coinEvalByKey[coinEvalEditing.key]"
          v-model:note="coinEvalNoteByKey[coinEvalEditing.key]"
          v-model:actual-tp-text="coinEvalTpByKey[coinEvalEditing.key]"
          :symbol="String(coinEvalEditing.coin.symbol)"
          hide-save
        />
      </div>
    </div>
  </div>
</template>

<style scoped>
.fetch-page {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
  padding: 0.75rem 1rem 1rem;
  overflow: hidden;
  background: #1e1f22;
}
.fetch-topbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 1rem;
  flex-shrink: 0;
  margin-bottom: 0.75rem;
}
.mode-tabs {
  display: flex;
  gap: 0.35rem;
  background: #2b2d31;
  border: 1px solid #3f4147;
  border-radius: 10px;
  padding: 0.25rem;
}
.mode-tab {
  border: none;
  background: transparent;
  color: #949ba4;
  padding: 0.45rem 0.85rem;
  border-radius: 8px;
  font-weight: 600;
  font-size: 0.85rem;
  cursor: pointer;
}
.mode-tab.on {
  background: #5865f2;
  color: #fff;
}
.topbar-actions {
  display: flex;
  align-items: center;
  gap: 0.75rem;
}
.mode-body {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
.mode-youtube {
  display: grid;
  grid-template-columns: minmax(300px, 1fr) minmax(320px, 1.1fr);
  gap: 1rem;
  height: 100%;
  overflow: auto;
}
.mode-paste {
  display: grid;
  grid-template-columns: minmax(240px, 320px) minmax(0, 1fr);
  gap: 1rem;
  height: 100%;
  min-height: 0;
}
.paste-list-panel {
  min-height: 0;
  overflow: auto;
}
.paste-detail-panel {
  min-height: 0;
  overflow: auto;
  display: flex;
  flex-direction: column;
}
.paste-detail-panel > .panel-head,
.paste-detail-panel > .muted,
.paste-detail-panel > .parse-msg,
.paste-detail-panel > .err,
.paste-detail-panel > .detail-tabs {
  flex-shrink: 0;
}
.detail-tabs {
  display: flex;
  gap: 0.25rem;
  margin: 0.75rem 0 0;
  border-bottom: 1px solid #3f4147;
  padding-bottom: 0;
}
.detail-tab {
  appearance: none;
  background: transparent;
  border: none;
  border-bottom: 2px solid transparent;
  margin-bottom: -1px;
  padding: 0.45rem 0.85rem;
  color: #949ba4;
  font-size: 0.85rem;
  cursor: pointer;
}
.detail-tab:hover {
  color: #dbdee1;
}
.detail-tab.on {
  color: #fff;
  border-bottom-color: #5865f2;
}
.detail-tab-body {
  flex: 1 1 auto;
  min-height: 0;
  overflow: auto;
  margin-top: 0.75rem;
}
.fulltext-tab {
  display: flex;
  flex-direction: column;
}
.fulltext-scroll {
  flex: 1 1 auto;
  min-height: clamp(280px, 55vh, calc(100dvh - 240px));
  overflow: auto;
  background: #1e1f22;
  border: 1px solid #3f4147;
  border-radius: 8px;
  padding: 0.75rem 0.85rem;
  -webkit-overflow-scrolling: touch;
}
.fulltext-pre {
  margin: 0;
  font-size: 0.82rem;
  line-height: 1.55;
  color: #dbdee1;
  white-space: pre-wrap;
  word-break: break-word;
  font-family: ui-monospace, Consolas, monospace;
}
.paste-files {
  list-style: none;
  margin: 0.75rem 0 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.4rem;
}
.paste-files li {
  background: #1e1f22;
  border: 1px solid #3f4147;
  border-radius: 8px;
  padding: 0.5rem 0.6rem;
  cursor: pointer;
  transition: border-color 0.15s;
}
.paste-files li:hover {
  border-color: #5865f2;
}
.paste-files li.selected {
  border-color: #5865f2;
  box-shadow: 0 0 0 1px rgba(88, 101, 242, 0.35);
}
.pf-top {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  margin-bottom: 0.25rem;
}
.pf-count {
  font-size: 0.72rem;
  color: #949ba4;
}
.pf-name {
  font-family: ui-monospace, Consolas, monospace;
  font-size: 0.8rem;
  color: #dbdee1;
  word-break: break-all;
}
.pf-title {
  font-size: 0.78rem;
  color: #949ba4;
  margin-top: 0.2rem;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.dir-hint code {
  font-size: 0.72rem;
  color: #aeb4ff;
  word-break: break-all;
}
.scan-hint {
  margin: 0 0 0.5rem;
  font-size: 0.8rem;
  color: #aeb4ff;
}
.manual-paste {
  margin-top: 0.5rem;
}
.btn.linkish {
  margin-top: 1rem;
  background: transparent;
  border-color: transparent;
  color: #949ba4;
  font-size: 0.78rem;
  padding: 0.25rem 0;
}
.detail-actions {
  display: flex;
  gap: 0.5rem;
}
.paste-tag {
  font-size: 0.72rem;
  color: #aeb4ff;
  background: rgba(88, 101, 242, 0.15);
  padding: 0.15rem 0.45rem;
  border-radius: 999px;
  font-weight: 600;
}
.paste-auto-hint {
  color: #81c784;
  font-size: 0.72rem;
}
.parse-msg {
  margin: 0.65rem 0 0;
  font-size: 0.8rem;
  color: #aeb4ff;
}
.preview-wrap {
  margin-top: 0;
  flex: 1 1 auto;
  min-height: 0;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  overflow: auto;
}
.preview-upper {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
}
.summary-block ul {
  margin: 0.35rem 0 0;
  padding-left: 1.1rem;
  color: #dbdee1;
  font-size: 0.85rem;
  line-height: 1.55;
}
.coin-actions {
  display: flex;
  flex-wrap: wrap;
  align-items: flex-start;
  gap: 0.5rem;
}
.coin-actions-head {
  flex: 1 1 100%;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.coin-count {
  font-size: 0.72rem;
  color: #949ba4;
}
.coin-action-card {
  box-sizing: border-box;
  min-width: min(260px, 100%);
  width: fit-content;
  max-width: 100%;
  flex: 0 1 auto;
  background: #1e1f22;
  border: 1px solid #3f4147;
  border-radius: 8px;
  padding: 0.6rem 0.7rem;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s;
}
.coin-action-card:hover {
  border-color: #5865f2;
  background: #232428;
}
.coin-watch-msg {
  margin: 0 0 0.45rem;
  font-size: 0.72rem;
  color: #57f287;
}
.coin-watch-badge {
  margin-left: auto;
  font-size: 0.62rem;
  color: #949ba4;
  border: 1px solid #3f4147;
  border-radius: 999px;
  padding: 0.08rem 0.35rem;
}
.coin-brief-line {
  margin: 0.25rem 0 0;
  font-size: 0.78rem;
  color: #dbdee1;
  line-height: 1.4;
}
.coin-brief-label {
  color: #949ba4;
  margin-right: 0.35rem;
}
.coin-brief-note {
  color: #b5bac1;
  display: -webkit-box;
  -webkit-line-clamp: 2;
  -webkit-box-orient: vertical;
  overflow: hidden;
}
.coin-brief-eval {
  margin: 0.35rem 0 0;
  font-size: 0.72rem;
  color: #57f287;
}
.coin-edit-btn {
  margin-top: 0.45rem;
  border: 1px solid #3f4147;
  background: #2b2d31;
  color: #dbdee1;
  font-size: 0.72rem;
  padding: 0.2rem 0.55rem;
  border-radius: 6px;
  cursor: pointer;
}
.coin-edit-btn:hover {
  border-color: #5865f2;
  color: #fff;
}
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1.5rem;
}
.modal-panel {
  width: min(720px, 100%);
  max-height: min(85vh, 900px);
  background: #2b2d31;
  border: 1px solid #3f4147;
  border-radius: 10px;
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.modal-head {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 0.75rem;
  padding: 0.85rem 1rem;
  border-bottom: 1px solid #3f4147;
  flex-shrink: 0;
}
.modal-head h3 {
  margin: 0;
  font-size: 1rem;
  color: #f2f3f5;
}
.modal-sub {
  margin-left: 0.45rem;
  font-size: 0.75rem;
  font-weight: 400;
  color: #949ba4;
}
.modal-close {
  border: none;
  background: #35373c;
  color: #dbdee1;
  width: 1.75rem;
  height: 1.75rem;
  border-radius: 6px;
  font-size: 1.2rem;
  line-height: 1;
  cursor: pointer;
  flex-shrink: 0;
}
.modal-close:hover {
  background: #5865f2;
  color: #fff;
}
.modal-body {
  padding: 0.85rem 1rem 1rem;
  overflow: auto;
}
.coin-action-top {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  flex-wrap: wrap;
  margin-bottom: 0.3rem;
  width: 100%;
}
.coin-sym {
  font-size: 0.95rem;
  color: #f2f3f5;
}
.action-badge {
  font-size: 0.68rem;
  font-weight: 700;
  padding: 0.12rem 0.4rem;
  border-radius: 999px;
}
.action-badge.act-new {
  background: rgba(88, 101, 242, 0.2);
  color: #aeb4ff;
}
.action-badge.act-continue {
  background: rgba(254, 231, 92, 0.15);
  color: #fee75c;
}
.action-badge.act-toend {
  background: rgba(87, 242, 135, 0.15);
  color: #57f287;
}
.action-badge.act-end {
  background: rgba(148, 155, 164, 0.2);
  color: #949ba4;
}
.coin-dir {
  font-size: 0.78rem;
  color: #aeb4ff;
}
.coin-desc {
  margin: 0 0 0.25rem;
  font-size: 0.85rem;
  color: #dbdee1;
  line-height: 1.45;
}
.coin-detail {
  margin: 0 0 0.65rem;
  font-size: 0.78rem;
  color: #949ba4;
}
.embed-preview {
  background: #1e1f22;
  border-left: 4px solid #5865f2;
  border-radius: 6px;
  padding: 0.75rem 0.85rem;
}
.embed-preview h3 {
  margin: 0 0 0.45rem;
  font-size: 0.95rem;
  color: #f2f3f5;
}
.embed-desc {
  margin: 0 0 0.55rem;
  color: #dbdee1;
  font-size: 0.85rem;
  line-height: 1.55;
  white-space: pre-wrap;
}
.embed-fields {
  display: grid;
  grid-template-columns: repeat(3, 1fr);
  gap: 0.45rem;
}
.embed-field.inline {
  grid-column: span 1;
}
.embed-field:not(.inline) {
  grid-column: 1 / -1;
}
.fn {
  font-size: 0.72rem;
  font-weight: 700;
  color: #b5bac1;
}
.fv {
  font-size: 0.82rem;
  color: #f2f3f5;
}
.json-block {
  margin: 0;
  flex: 0 0 auto;
}
.json-block summary {
  cursor: pointer;
  color: #949ba4;
  font-size: 0.78rem;
  margin-bottom: 0.35rem;
}
.json-scroll {
  height: clamp(320px, 58vh, calc(100dvh - 220px));
  overflow: auto;
  background: #1e1f22;
  border: 1px solid #3f4147;
  border-radius: 8px;
  padding: 0.65rem 0.75rem;
  -webkit-overflow-scrolling: touch;
}
.json-scroll pre {
  margin: 0;
  max-height: none;
  overflow: visible;
  font-size: 0.75rem;
  line-height: 1.45;
  color: #b5bac1;
  white-space: pre-wrap;
  word-break: break-word;
}
.json-block:not([open]) .json-scroll {
  display: none;
}
.panel {
  background: #2b2d31;
  border: 1px solid #3f4147;
  border-radius: 10px;
  padding: 1rem 1.1rem;
  min-height: 0;
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
  .mode-youtube,
  .mode-paste {
    grid-template-columns: 1fr;
    overflow: auto;
  }
}
</style>
