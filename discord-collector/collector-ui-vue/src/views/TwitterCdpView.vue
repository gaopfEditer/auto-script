<script setup>
import { computed, onMounted, onUnmounted, ref } from "vue";
import {
  fetchTwitterCdpStatus,
  probeTwitterCdp,
  resetTwitterCdpSeen,
  runTwitterCdpFetch,
  saveTwitterCdpConfig,
} from "../lib/twitterCdpApi.js";

const PORT_PRESETS = [9222, 9223];

const loading = ref(false);
const fetching = ref(false);
const probing = ref(false);
const saving = ref(false);
const error = ref("");
const notice = ref("");

const enabled = ref(true);
const telegram = ref(true);
const host = ref("127.0.0.1");
const port = ref(9222);
const intervalSec = ref(120);
const listText = ref("");
const telegramReady = ref(false);
const running = ref(false);
const lastRun = ref(/** @type {Record<string, unknown> | null} */ (null));
const logs = ref(/** @type {string[]} */ ([]));
const tweets = ref(/** @type {Array<Record<string, unknown>>} */ ([]));
const cdp = ref(/** @type {Record<string, unknown> | null} */ (null));

let pollTimer = /** @type {ReturnType<typeof setInterval> | null} */ (null);

const cdpOk = computed(() => Boolean(cdp.value?.ok));
const xTabs = computed(() => {
  const tabs = Array.isArray(cdp.value?.tabs) ? cdp.value.tabs : [];
  return tabs.filter((t) => /x\.com|twitter\.com/i.test(String(t.url ?? "")));
});

let hydrated = false;
function applyStatus(j, { form = true } = {}) {
  const cfg = j.config ?? {};
  if (form) {
    enabled.value = cfg.enabled !== false;
    telegram.value = cfg.telegram !== false;
    host.value = String(cfg.host || "127.0.0.1");
    port.value = Number(cfg.port) || 9222;
    intervalSec.value = Math.max(30, Math.round((Number(cfg.intervalMs) || 120000) / 1000));
    const lists = Array.isArray(cfg.lists) ? cfg.lists : [];
    listText.value = lists.map((l) => l.url || l.id).join("\n");
  }
  telegramReady.value = Boolean(cfg.telegramReady);
  running.value = Boolean(j.running);
  lastRun.value = j.lastRun ?? null;
  logs.value = Array.isArray(j.logs) ? j.logs : [];
  tweets.value = Array.isArray(j.tweets) ? j.tweets : [];
  cdp.value = j.cdp ?? cdp.value;
}

async function loadStatus(silent = false) {
  if (!silent) {
    loading.value = true;
    error.value = "";
  }
  try {
    applyStatus(await fetchTwitterCdpStatus(), { form: !hydrated });
    hydrated = true;
  } catch (e) {
    if (!silent) error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    if (!silent) loading.value = false;
  }
}

async function save() {
  saving.value = true;
  error.value = "";
  notice.value = "";
  try {
    const j = await saveTwitterCdpConfig({
      enabled: enabled.value,
      telegram: telegram.value,
      host: host.value,
      port: Number(port.value),
      intervalMs: Number(intervalSec.value) * 1000,
      listText: listText.value,
    });
    if (j.config) {
      applyStatus({
        ...j,
        running: running.value,
        lastRun: lastRun.value,
        logs: logs.value,
        tweets: tweets.value,
        cdp: cdp.value,
      });
    }
    notice.value = "配置已保存";
    return true;
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
    return false;
  } finally {
    saving.value = false;
  }
}

async function probe() {
  probing.value = true;
  error.value = "";
  try {
    cdp.value = await probeTwitterCdp({ host: host.value, port: Number(port.value) });
    if (!cdp.value?.ok) error.value = String(cdp.value?.error || "CDP 探测失败");
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    probing.value = false;
  }
}

async function fetchNow() {
  fetching.value = true;
  error.value = "";
  notice.value = "";
  try {
    const saved = await save();
    if (!saved) return;
    const j = await runTwitterCdpFetch();
    if (j.ok === false && j.skipped === "busy") {
      notice.value = "正在抓取中，请稍候";
    } else if (j.ok === false) {
      error.value = String(j.error || "抓取失败");
    } else {
      const n = Number(j.pushed) || 0;
      notice.value = n ? `抓取完成，新帖推送 ${n} 条` : "抓取完成（无新帖或首次记档）";
    }
    await loadStatus();
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    fetching.value = false;
  }
}

async function resetSeen() {
  if (!confirm("清空已见帖记录后，下次会重新记档（仍不推旧帖）。确定？")) return;
  error.value = "";
  try {
    await resetTwitterCdpSeen("");
    notice.value = "已清空 seen";
    await loadStatus();
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  }
}

function fmtTime(v) {
  if (!v) return "—";
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString();
}

onMounted(() => {
  void loadStatus();
  pollTimer = setInterval(() => void loadStatus(true), 15_000);
});
onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div class="tw-page">
    <header class="tw-head">
      <div>
        <h1>推特 CDP</h1>
        <p class="tw-sub">
          附加本机已登录 X 的 Chrome，只拉指定列表的最新帖并推到 Telegram。首次记档不推旧帖。
        </p>
      </div>
      <div class="tw-head-actions">
        <span class="tw-pill" :class="cdpOk ? 'on' : 'off'">CDP {{ cdpOk ? "已连通" : "未连通" }}</span>
        <span class="tw-pill" :class="running ? 'on' : 'off'">{{ running ? "抓取中" : "空闲" }}</span>
        <button type="button" class="tw-btn ghost" :disabled="loading" @click="loadStatus">刷新</button>
      </div>
    </header>

    <p v-if="error" class="tw-err">{{ error }}</p>
    <p v-else-if="notice" class="tw-ok">{{ notice }}</p>

    <section class="tw-grid">
      <div class="tw-card">
        <h2>CDP 端口</h2>
        <p class="tw-hint">
          Chrome 需加 <code>--remote-debugging-port=端口</code> 并已登录 x.com。Discord 占用 9222 时改用 9223。
        </p>
        <div class="tw-row">
          <input v-model="host" class="tw-input" placeholder="127.0.0.1" />
          <div class="tw-ports">
            <button
              v-for="p in PORT_PRESETS"
              :key="p"
              type="button"
              class="tw-chip"
              :class="{ on: Number(port) === p }"
              @click="port = p"
            >
              {{ p }}
            </button>
            <input v-model.number="port" type="number" min="1" class="tw-input sm" />
          </div>
          <button type="button" class="tw-btn" :disabled="probing" @click="probe">
            {{ probing ? "探测…" : "探测" }}
          </button>
        </div>
        <p v-if="cdp?.browser" class="tw-muted">{{ cdp.browser }}</p>
        <ul v-if="xTabs.length" class="tw-tabs">
          <li v-for="t in xTabs" :key="t.id">
            <span class="tw-muted">X</span> {{ t.title || t.url }}
          </li>
        </ul>
        <p v-else-if="cdpOk" class="tw-muted">已连上浏览器，但还没有 x.com 标签页（抓取时会自动打开）。</p>
      </div>

      <div class="tw-card">
        <h2>列表</h2>
        <p class="tw-hint">每行一个：列表 ID、<code>https://x.com/i/lists/…</code>，或 @用户（仅最新时间线）。</p>
        <textarea v-model="listText" class="tw-area" rows="6" placeholder="https://x.com/i/lists/1234567890" />
        <div class="tw-row wrap">
          <label class="tw-check">
            <input v-model="enabled" type="checkbox" />
            定时拉取
          </label>
          <label class="tw-check">
            间隔
            <input v-model.number="intervalSec" type="number" min="30" class="tw-input sm" />
            秒
          </label>
          <label class="tw-check">
            <input v-model="telegram" type="checkbox" />
            推送 Telegram
            <span class="tw-muted">{{ telegramReady ? "" : "（未配置 TELEGRAM_PUSH_CHAT_ID）" }}</span>
          </label>
        </div>
        <div class="tw-row">
          <button type="button" class="tw-btn ghost" :disabled="saving" @click="save">保存</button>
          <button type="button" class="tw-btn" :disabled="fetching || running" @click="fetchNow">
            {{ fetching || running ? "抓取中…" : "立即获取最新" }}
          </button>
          <button type="button" class="tw-btn ghost" @click="resetSeen">清空已见</button>
        </div>
      </div>
    </section>

    <section class="tw-card">
      <h2>最近一次</h2>
      <p v-if="!lastRun" class="tw-muted">尚未跑过。保存列表后点「立即获取最新」。</p>
      <template v-else>
        <p class="tw-muted">{{ lastRun.at }} · {{ lastRun.ok ? `成功 ${lastRun.ms ?? ""}ms` : lastRun.error }}</p>
        <div v-if="Array.isArray(lastRun.lists)" class="tw-table-wrap">
          <table class="tw-table">
            <thead>
              <tr>
                <th>列表</th>
                <th>抓到</th>
                <th>新帖</th>
                <th>TG</th>
                <th></th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in lastRun.lists" :key="String(row.listId)">
                <td>{{ row.label }}</td>
                <td>{{ row.fetched }}</td>
                <td>{{ row.seeded ? "首次记档" : row.newCount }}</td>
                <td>{{ row.telegramSent ?? 0 }}</td>
                <td class="tw-err sm">{{ row.error || "" }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </template>
    </section>

    <section class="tw-card">
      <h2>已入库帖子</h2>
      <p v-if="!tweets.length" class="tw-muted">暂无</p>
      <div v-else class="tw-table-wrap">
        <table class="tw-table">
          <thead>
            <tr>
              <th>时间</th>
              <th>作者</th>
              <th>内容</th>
              <th>TG</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="t in tweets" :key="String(t.tweet_id || t.tweetId)">
              <td class="tw-time">{{ fmtTime(t.tweet_at || t.fetched_at) }}</td>
              <td>@{{ t.author_handle }}</td>
              <td class="tw-text">
                <a :href="String(t.tweet_url || '#')" target="_blank" rel="noreferrer">{{ t.text || t.tweet_url }}</a>
              </td>
              <td>{{ t.telegram_sent_at ? "已推" : "—" }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <section v-if="logs.length" class="tw-card">
      <h2>日志</h2>
      <pre class="tw-log">{{ logs.join("\n") }}</pre>
    </section>
  </div>
</template>

<style scoped>
.tw-page {
  height: 100%;
  min-height: 0;
  overflow-y: auto;
  padding: 1.25rem 1.5rem 2rem;
  color: #e8eaed;
}
.tw-head {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  justify-content: space-between;
  align-items: flex-start;
  margin-bottom: 1rem;
}
.tw-head h1 {
  margin: 0;
  font-size: 1.35rem;
  font-weight: 650;
}
.tw-sub {
  margin: 0.35rem 0 0;
  font-size: 0.85rem;
  color: #9aa0a6;
  max-width: 40rem;
}
.tw-head-actions,
.tw-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.5rem;
  align-items: center;
}
.tw-row.wrap {
  margin: 0.65rem 0;
}
.tw-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(20rem, 1fr));
  gap: 0.85rem;
  margin-bottom: 0.85rem;
}
.tw-card {
  background: #1a1c20;
  border: 1px solid #2d3136;
  border-radius: 8px;
  padding: 0.9rem 1rem 1.1rem;
  margin-bottom: 0.85rem;
}
.tw-card h2 {
  margin: 0 0 0.45rem;
  font-size: 0.95rem;
  font-weight: 600;
}
.tw-hint,
.tw-muted {
  color: #9aa0a6;
  font-size: 0.8rem;
  margin: 0 0 0.6rem;
}
.tw-hint code {
  font-size: 0.75rem;
  background: #111317;
  padding: 0.05rem 0.3rem;
  border-radius: 4px;
}
.tw-input,
.tw-area {
  background: #1e2024;
  border: 1px solid #3c4043;
  color: #e8eaed;
  border-radius: 6px;
  padding: 0.35rem 0.55rem;
  font-size: 0.85rem;
}
.tw-input.sm {
  width: 5.5rem;
}
.tw-area {
  width: 100%;
  min-height: 7rem;
  font-family: ui-monospace, Consolas, monospace;
  resize: vertical;
}
.tw-btn {
  background: #3b82f6;
  border: none;
  color: #fff;
  border-radius: 6px;
  padding: 0.35rem 0.75rem;
  font-size: 0.85rem;
  cursor: pointer;
}
.tw-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.tw-btn.ghost {
  background: transparent;
  border: 1px solid #3c4043;
  color: #e8eaed;
}
.tw-chip,
.tw-pill {
  border: 1px solid #3c4043;
  background: transparent;
  color: #e8eaed;
  border-radius: 999px;
  padding: 0.2rem 0.65rem;
  font-size: 0.8rem;
}
.tw-chip {
  cursor: pointer;
}
.tw-chip.on,
.tw-pill.on {
  border-color: #81c995;
  color: #81c995;
}
.tw-pill.off {
  color: #9aa0a6;
}
.tw-ports {
  display: flex;
  gap: 0.35rem;
  align-items: center;
}
.tw-check {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.85rem;
}
.tw-err {
  color: #f28b82;
}
.tw-err.sm {
  font-size: 0.8rem;
}
.tw-ok {
  color: #81c995;
}
.tw-tabs {
  margin: 0;
  padding-left: 1.1rem;
  font-size: 0.8rem;
  color: #c4c7c5;
}
.tw-table-wrap {
  overflow-x: auto;
}
.tw-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
.tw-table th,
.tw-table td {
  padding: 0.45rem 0.55rem;
  text-align: left;
  border-bottom: 1px solid #2d3136;
  vertical-align: top;
}
.tw-table th {
  color: #9aa0a6;
  font-weight: 500;
}
.tw-time {
  white-space: nowrap;
  font-variant-numeric: tabular-nums;
}
.tw-text {
  max-width: 36rem;
  white-space: pre-wrap;
  word-break: break-word;
}
.tw-text a {
  color: #8ab4f8;
  text-decoration: none;
}
.tw-log {
  margin: 0;
  font-size: 0.75rem;
  color: #9aa0a6;
  white-space: pre-wrap;
  max-height: 14rem;
  overflow: auto;
}
</style>
