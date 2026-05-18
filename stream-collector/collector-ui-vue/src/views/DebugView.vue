<script setup>
import { ref, computed, watch, onMounted, nextTick } from "vue";
import { useCollectorSocket } from "../composables/useCollectorSocket.js";
import { extractChatDisplay } from "../lib/chatExtract.js";
import {
  useDebugNetwork,
  nameFromUrl,
  formatBytes,
  displayStatus,
  statusPillClass,
} from "../lib/useDebugNetwork.js";
import { wireSummary } from "../lib/wireSummary.js";

defineOptions({ name: "DebugView" });

const SPLIT_KEY = "collector-ui-debug-split-fr";

/** @typedef {{ id: string, ts: number, author: string, typeLabel: string, text: string, badges: { db?: boolean, decode?: string }, raw?: unknown }} FeedLine */

const tab = ref(/** @type {"network" | "misc" | "frames"} */ ("network"));
const feedTab = ref(/** @type {"live" | "history" | "all"} */ ("live"));
const lines = ref(/** @type {FeedLine[]} */ ([]));
let feedSeq = 0;
const frameScrollEl = ref(/** @type {HTMLElement | null} */ (null));

const innerTab = ref("response");
const { netRows, miscEvents, ingest } = useDebugNetwork();
const selected = ref(/** @type {Record<string, unknown> | null} */ (null));

const filterText = ref("");
const filterType = ref("");

const FILTER_TYPES = [
  { value: "", label: "全部类型" },
  { value: "Document", label: "Document" },
  { value: "XHR", label: "XHR" },
  { value: "Fetch", label: "Fetch" },
  { value: "WebSocket", label: "WebSocket" },
  { value: "WS-Frame", label: "WS 帧" },
  { value: "EventSource", label: "EventSource" },
];

watch(selected, () => {
  innerTab.value = "response";
});

/** @param {Record<string, unknown>} msg */
function pushFrameFeedFromWire(msg) {
  if (msg.channel !== "frame" || msg.kind !== "ws_frame") return;
  const body = msg.body;
  const j = body && typeof body === "object" && "json" in body ? body.json : null;
  const display = j != null ? extractChatDisplay(j) : extractChatDisplay(null);
  feedSeq += 1;
  lines.value.push({
    id: `live-${msg.seq ?? feedSeq}-${msg.ts}`,
    ts: /** @type {number} */ (msg.ts),
    author: display.author,
    typeLabel: display.typeLabel,
    text: display.text,
    badges: {
      db: Boolean(msg.dbParseOk),
      decode: String(msg.decodeFormat ?? ""),
    },
    raw: j ?? body,
  });
  void nextTick(() => {
    const el = frameScrollEl.value;
    el?.scrollTo({ top: el.scrollHeight, behavior: "smooth" });
  });
}

/** @param {Record<string, unknown>} msg */
function onSocketMsg(msg) {
  ingest(msg);
  pushFrameFeedFromWire(msg);
}

useCollectorSocket(onSocketMsg);

const visibleFeedLines = computed(() => {
  if (feedTab.value === "history") {
    return lines.value.filter((l) => l.id.startsWith("db-"));
  }
  if (feedTab.value === "live") {
    return lines.value.filter((l) => l.id.startsWith("live-"));
  }
  return lines.value;
});

function fmtFeedTime(ts) {
  return new Date(ts).toLocaleTimeString("zh-CN", { hour12: false });
}

const filteredNetRows = computed(() => {
  const q = filterText.value.trim().toLowerCase();
  const t = filterType.value;
  return netRows.value.filter((row) => {
    if (t) {
      if (t === "WS-Frame") {
        if (!row.wsFrame) return false;
      } else if (String(row.resourceType ?? "") !== t) {
        return false;
      }
    }
    if (!q) return true;
    const bits = [
      row.name,
      row.url,
      row.method,
      row.initiator,
      displayStatus(row),
      row.resourceType,
      row.decodePath,
      row.connectionRequestId,
    ]
      .map((x) => String(x ?? "").toLowerCase())
      .join("\n");
    return bits.includes(q);
  });
});

const maxDurationMs = computed(() => {
  let m = 1;
  for (const r of filteredNetRows.value) {
    const d = Number(r.durationMs);
    if (!Number.isNaN(d) && d > m) m = d;
  }
  return m;
});

function wfPct(row) {
  const d = Number(row.durationMs);
  if (!d || maxDurationMs.value <= 0) return 0;
  return Math.min(100, (d / maxDurationMs.value) * 100);
}

function sizeForRow(row) {
  if (row.transferSize != null) return formatBytes(row.transferSize);
  if (row.headerEncodedLen != null) return formatBytes(row.headerEncodedLen);
  return "—";
}

function timeMs(row) {
  const d = row.durationMs;
  if (d == null || Number.isNaN(Number(d))) return "—";
  const n = Number(d);
  if (n < 1000) return `${Math.round(n)} ms`;
  return `${(n / 1000).toFixed(2)} s`;
}

function onPickNet(row) {
  selected.value = row;
}

function onPickMisc(msg) {
  selected.value = msg;
}

function headersJson(h) {
  if (h == null || typeof h !== "object") return "—";
  try {
    return JSON.stringify(h, null, 2);
  } catch {
    return String(h);
  }
}

/** @param {Record<string, unknown> | null} row */
function responseBodyBlock(row) {
  if (!row) return "";
  if (row.responseBodyPending) return "正在拉取响应体…";
  if (row.responseBodyError) return `无法读取响应体：${row.responseBodyError}`;
  if (row.responseBodyJson != null) {
    try {
      return JSON.stringify(row.responseBodyJson, null, 2);
    } catch {
      return String(row.responseBodyJson);
    }
  }
  if (row.responseBodyText != null) return String(row.responseBodyText);
  return "（尚无响应体：等待请求完成或该资源无正文）";
}

/** @param {Record<string, unknown> | null} row */
function wsFrameResponseBody(row) {
  if (!row) return "";
  if (row.parsedJson != null) {
    try {
      return JSON.stringify(row.parsedJson, null, 2);
    } catch {
      return String(row.parsedJson);
    }
  }
  return String(row.rawPreview || row.hexPreview || "—");
}

/** @param {Record<string, unknown> | null} row */
function isNetworkRow(row) {
  return row != null && typeof row.requestId === "string";
}

/** --- 上下分栏拖动（grid fr） --- */
const splitRoot = ref(/** @type {HTMLElement | null} */ (null));
const topFr = ref(1.25);
const botFr = ref(1);

onMounted(() => {
  try {
    const raw = sessionStorage.getItem(SPLIT_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (typeof o.top === "number" && typeof o.bot === "number" && o.top > 0.08 && o.bot > 0.08) {
      topFr.value = o.top;
      botFr.value = o.bot;
    }
  } catch {
    /* ignore */
  }

  void (async () => {
    try {
      const r = await fetch("/api/frames?limit=80");
      const data = await r.json();
      if (!data.ok || !Array.isArray(data.rows)) return;
      const historical = [];
      for (const row of [...data.rows].reverse()) {
        let parsed = null;
        if (row.parsed_json) {
          try {
            parsed = typeof row.parsed_json === "string" ? JSON.parse(row.parsed_json) : row.parsed_json;
          } catch {
            parsed = null;
          }
        }
        const display =
          parsed != null
            ? extractChatDisplay(parsed)
            : { author: "db", typeLabel: "row", text: row.parse_error || "(无 parsed_json)", extraJson: null };
        historical.push({
          id: `db-${row.id}`,
          ts: new Date(row.received_at).getTime() || Date.now(),
          author: display.author,
          typeLabel: display.typeLabel,
          text: display.text,
          badges: { db: !row.parse_error, decode: `op${row.opcode}` },
          raw: parsed,
        });
      }
      lines.value = [...historical, ...lines.value];
    } catch {
      /* ignore */
    }
  })();
});

watch([topFr, botFr], ([t, b]) => {
  try {
    sessionStorage.setItem(SPLIT_KEY, JSON.stringify({ top: t, bot: b }));
  } catch {
    /* ignore */
  }
});

/** @param {MouseEvent} e */
function onSplitMouseDown(e) {
  e.preventDefault();
  const root = splitRoot.value;
  if (!root) return;
  const startY = e.clientY;
  const startTop = topFr.value;
  const startBot = botFr.value;
  const sum0 = startTop + startBot;

  function onMove(ev) {
    const dy = ev.clientY - startY;
    const rect = root.getBoundingClientRect();
    const h = Math.max(1, rect.height - 6);
    /** 鼠标上移 (dy<0) → 上方网络区应变小、下方变大；与分割条随光标移动一致 */
    const deltaFr = (dy / h) * sum0 * 1.15;
    let t = startTop + deltaFr;
    let b = startBot - deltaFr;
    const minFr = 0.12;
    if (t < minFr) {
      b -= minFr - t;
      t = minFr;
    }
    if (b < minFr) {
      t -= minFr - b;
      b = minFr;
    }
    if (t < minFr) t = minFr;
    if (b < minFr) b = minFr;
    topFr.value = Math.round(t * 1000) / 1000;
    botFr.value = Math.round(b * 1000) / 1000;
  }
  function onUp() {
    window.removeEventListener("mousemove", onMove);
    window.removeEventListener("mouseup", onUp);
    document.body.style.cursor = "";
    document.body.style.userSelect = "";
  }
  document.body.style.cursor = "row-resize";
  document.body.style.userSelect = "none";
  window.addEventListener("mousemove", onMove);
  window.addEventListener("mouseup", onUp);
}
</script>

<template>
  <div class="debug-wrap">
    <header class="debug-top">
      <div class="debug-top-left">
        <strong>采集调试</strong>
        <nav class="debug-tabs">
          <button type="button" :class="{ on: tab === 'network' }" @click="tab = 'network'">
            网络
          </button>
          <button type="button" :class="{ on: tab === 'misc' }" @click="tab = 'misc'">
            其它事件
            <span class="pill">{{ miscEvents.length }}</span>
          </button>
          <button type="button" :class="{ on: tab === 'frames' }" @click="tab = 'frames'">
            CDP 消息流
          </button>
        </nav>
      </div>
      <span v-show="tab === 'network'" class="status">筛选后 {{ filteredNetRows.length }} / 共 {{ netRows.length }} 条</span>
    </header>

    <div v-show="tab === 'network'" ref="splitRoot" class="split-root" :style="{ gridTemplateRows: `${topFr}fr 6px ${botFr}fr` }">
      <div class="net-pane">
        <div class="net-filters">
          <input
            v-model="filterText"
            class="net-filter-input"
            type="search"
            placeholder="筛选：URL / 名称 / 方法 / 状态 / 发起程序…"
            spellcheck="false"
          />
          <select v-model="filterType" class="net-filter-select" aria-label="资源类型">
            <option v-for="opt in FILTER_TYPES" :key="opt.value || 'all'" :value="opt.value">
              {{ opt.label }}
            </option>
          </select>
        </div>
        <div class="net-scroll-inner">
          <table class="net-table">
            <thead>
              <tr>
                <th class="col-name">名称</th>
                <th class="col-sm">方法</th>
                <th class="col-st">状态</th>
                <th class="col-type">类型</th>
                <th class="col-init">发起程序</th>
                <th class="col-size">大小</th>
                <th class="col-time">时间</th>
                <th class="col-wf">瀑布</th>
              </tr>
            </thead>
            <tbody>
              <tr
                v-for="row in filteredNetRows"
                :key="String(row.requestId)"
                :class="{ sel: selected === row }"
                :title="String(row.url ?? '')"
                @click="onPickNet(row)"
              >
                <td class="col-name mono">{{ row.name || nameFromUrl(String(row.url ?? "")) }}</td>
                <td class="col-sm mono">{{ row.method ?? "—" }}</td>
                <td class="col-st">
                  <span :class="['st-pill', statusPillClass(displayStatus(row))]">{{ displayStatus(row) }}</span>
                </td>
                <td class="col-type">{{ row.resourceType ?? "—" }}</td>
                <td class="col-init dim">{{ String(row.initiator ?? "").slice(0, 120) || "—" }}</td>
                <td class="col-size mono">{{ sizeForRow(row) }}</td>
                <td class="col-time mono">{{ timeMs(row) }}</td>
                <td class="col-wf">
                  <div class="wf-track">
                    <div class="wf-bar" :style="{ width: wfPct(row) + '%' }" />
                  </div>
                </td>
              </tr>
            </tbody>
          </table>
          <p v-if="netRows.length === 0" class="net-empty">暂无 HTTP / WS 请求；请确认 collect:ui 已连上页面并有网络活动。</p>
          <p v-else-if="filteredNetRows.length === 0" class="net-empty">无匹配项，请调整筛选条件。</p>
        </div>
      </div>

      <div class="splitter" title="上下拖动调整网络表与下方详情区域高度" @mousedown="onSplitMouseDown" />

      <div class="bottom-pane">
        <div v-if="selected && isNetworkRow(selected)" class="detail-panel">
          <nav class="detail-inner-tabs">
            <button type="button" :class="{ on: innerTab === 'response' }" @click="innerTab = 'response'">
              响应
            </button>
            <button type="button" :class="{ on: innerTab === 'request' }" @click="innerTab = 'request'">
              请求头
            </button>
          </nav>
          <div v-show="innerTab === 'response'" class="detail-tab-body">
            <template v-if="selected.wsFrame">
              <p class="detail-meta">
                <span>opcode {{ selected.opcode }}</span>
                <span>{{ String(selected.decodePath ?? "") }}</span>
                <span v-if="selected.frameSeq">#{{ selected.frameSeq }}</span>
              </p>
              <pre v-if="selected.parseError" class="detail-box detail-body">{{
                String(selected.parseError) + "\n" + String(selected.rawPreview || selected.hexPreview || "")
              }}</pre>
              <pre v-else class="detail-box detail-body">{{ wsFrameResponseBody(selected) }}</pre>
            </template>
            <template v-else>
              <p class="detail-meta">
                <span>HTTP {{ displayStatus(selected) }}</span>
                <span v-if="selected.mimeType">{{ String(selected.mimeType) }}</span>
              </p>
              <h5 class="detail-sub">响应头</h5>
              <pre class="detail-box">{{ headersJson(selected.respHeaders) }}</pre>
              <h5 class="detail-sub">响应正文</h5>
              <pre class="detail-box detail-body">{{ responseBodyBlock(selected) }}</pre>
              <p v-if="selected.responseBodyTruncated" class="detail-trunc">正文已截断（最大约 512KB 文本）</p>
            </template>
          </div>
          <div v-show="innerTab === 'request'" class="detail-tab-body">
            <template v-if="selected.wsFrame">
              <h5 class="detail-sub">WebSocket 握手 · 请求头</h5>
              <pre class="detail-box">{{ headersJson(selected.wsLinkReqHeaders) }}</pre>
              <h5 class="detail-sub">握手 · 响应头</h5>
              <pre class="detail-box">{{ headersJson(selected.wsLinkRespHeaders) }}</pre>
            </template>
            <template v-else>
              <p class="detail-url mono">{{ String(selected.url ?? "—") }}</p>
              <p class="detail-meta">
                <span>{{ String(selected.method ?? "—") }}</span>
                <span v-if="selected.resourceType">{{ String(selected.resourceType) }}</span>
              </p>
              <pre class="detail-box">{{ headersJson(selected.reqHeaders) }}</pre>
              <template v-if="selected.postData">
                <h5 class="detail-sub">Body</h5>
                <pre class="detail-box">{{ String(selected.postData) }}</pre>
              </template>
            </template>
          </div>
        </div>
        <div v-else class="detail-placeholder">点击上方表格中的某一行，在此查看「响应 / 请求头」</div>

        <pre class="debug-detail">{{ selected ? JSON.stringify(selected, null, 2) : "完整合并 JSON（选中行后显示）" }}</pre>
      </div>
    </div>

    <div v-show="tab === 'misc'" class="debug-scroll misc-only">
      <table class="debug-table">
        <thead>
          <tr>
            <th class="t">时间</th>
            <th class="k">类型</th>
            <th class="s">摘要</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="(msg, i) in miscEvents" :key="i" @click="onPickMisc(msg)">
            <td class="t">{{ new Date(Number(msg.ts)).toLocaleTimeString("zh-CN", { hour12: false }) }}</td>
            <td class="k">{{ String(msg.kind ?? msg.channel ?? "?") }}</td>
            <td class="s">{{ wireSummary(msg) }}</td>
          </tr>
        </tbody>
      </table>
    </div>

    <div v-show="tab === 'frames'" class="debug-frames-pane">
      <div class="debug-frames-toolbar">
        <span class="debug-frames-toolbar-label">CDP WebSocket 帧</span>
        <div class="debug-frames-feed-tabs">
          <button type="button" :class="{ on: feedTab === 'live' }" @click="feedTab = 'live'"># live-feed</button>
          <button type="button" :class="{ on: feedTab === 'history' }" @click="feedTab = 'history'"># mysql 历史</button>
          <button type="button" :class="{ on: feedTab === 'all' }" @click="feedTab = 'all'"># 全部合并</button>
        </div>
      </div>
      <div ref="frameScrollEl" class="msg-scroll debug-frames-scroll">
        <div v-for="line in visibleFeedLines" :key="line.id" class="msg-row">
          <div class="msg-av" aria-hidden="true" />
          <div class="msg-body">
            <div class="msg-meta">
              <span class="msg-author">{{ line.author }}</span>
              <span class="msg-time">{{ fmtFeedTime(line.ts) }}</span>
              <span class="msg-type">{{ line.typeLabel }}</span>
              <span v-if="line.badges.db !== undefined" :class="['badge', line.badges.db ? 'ok' : 'err']">
                MySQL {{ line.badges.db ? "ok" : "fail" }}
              </span>
              <span v-if="line.badges.decode" class="badge muted">{{ line.badges.decode }}</span>
            </div>
            <div class="msg-text">{{ line.text }}</div>
            <pre v-if="line.raw != null" class="msg-json">{{ JSON.stringify(line.raw, null, 2) }}</pre>
          </div>
        </div>
        <p v-if="visibleFeedLines.length === 0" class="empty-msg">暂无 WS 帧；请确认 collect:ui 已连接并在页面产生 WebSocket 数据。</p>
      </div>
    </div>
  </div>
</template>

<style scoped>
.debug-wrap {
  display: flex;
  flex-direction: column;
  height: 100%;
  min-height: 0;
}

.split-root {
  display: grid;
  flex: 1;
  min-height: 0;
  width: 100%;
}

.net-pane {
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #1e1f22;
}

.net-filters {
  display: flex;
  gap: 0.5rem;
  padding: 0.45rem 0.6rem;
  border-bottom: 1px solid #2d2d30;
  flex-shrink: 0;
  align-items: center;
}

.net-filter-input {
  flex: 1;
  min-width: 0;
  padding: 0.35rem 0.5rem;
  border-radius: 6px;
  border: 1px solid #3f4147;
  background: #2b2d31;
  color: #dbdee1;
  font-size: 0.78rem;
}

.net-filter-select {
  flex: 0 0 auto;
  padding: 0.35rem 0.45rem;
  border-radius: 6px;
  border: 1px solid #3f4147;
  background: #2b2d31;
  color: #dbdee1;
  font-size: 0.78rem;
  max-width: 9.5rem;
}

.net-scroll-inner {
  flex: 1;
  min-height: 0;
  overflow: auto;
}

.splitter {
  background: #3f4147;
  cursor: row-resize;
  flex-shrink: 0;
  position: relative;
  z-index: 2;
}

.splitter:hover {
  background: #5865f2;
}

.bottom-pane {
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  background: #252526;
}

.detail-placeholder {
  flex-shrink: 0;
  padding: 0.5rem 0.75rem;
  font-size: 0.78rem;
  color: #949ba4;
  border-bottom: 1px solid #3c3c3c;
}

.debug-scroll {
  flex: 1;
  min-height: 0;
}

.misc-only {
  background: #1e1f22;
  overflow: auto;
}

.debug-frames-pane {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  background: #313338;
  overflow: hidden;
}

.debug-frames-toolbar {
  flex-shrink: 0;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.65rem 1rem;
  padding: 0.45rem 0.75rem;
  border-bottom: 1px solid #27282d;
  background: #2b2d31;
}

.debug-frames-toolbar-label {
  font-size: 0.72rem;
  font-weight: 700;
  text-transform: uppercase;
  letter-spacing: 0.06em;
  color: #949ba4;
}

.debug-frames-feed-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}

.debug-frames-feed-tabs button {
  padding: 0.35rem 0.55rem;
  border-radius: 4px;
  border: 1px solid transparent;
  background: transparent;
  color: #949ba4;
  font-size: 0.82rem;
  cursor: pointer;
}

.debug-frames-feed-tabs button.on {
  background: #3f4248;
  color: #f2f3f5;
  border-color: #1e1f22;
}

.debug-frames-scroll {
  flex: 1;
  min-height: 0;
}

.debug-detail {
  flex: 0 1 38%;
  min-height: 72px;
  max-height: 42%;
  margin: 0;
  overflow: auto;
  border-top: 1px solid #3f4147;
  background: #1e1f22;
  padding: 0.45rem 0.65rem;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 0.72rem;
  white-space: pre-wrap;
  word-break: break-all;
  color: #b5bac1;
}

.debug-top-left {
  display: flex;
  align-items: center;
  gap: 1rem;
}
.debug-tabs {
  display: flex;
  gap: 0.35rem;
}
.debug-tabs button {
  background: #2b2d31;
  border: 1px solid #3f4147;
  color: #b5bac1;
  padding: 0.35rem 0.65rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.8rem;
}
.debug-tabs button.on {
  background: #1e1f22;
  color: #fff;
  border-color: #5865f2;
}
.net-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.78rem;
}
.net-table th {
  position: sticky;
  top: 0;
  z-index: 1;
  text-align: left;
  padding: 0.4rem 0.45rem;
  background: #252526;
  color: #949ba4;
  font-weight: 600;
  border-bottom: 1px solid #3c3c3c;
  white-space: nowrap;
}
.net-table td {
  padding: 0.28rem 0.45rem;
  border-bottom: 1px solid #2d2d30;
  vertical-align: middle;
}
.net-table tr:hover td {
  background: rgba(255, 255, 255, 0.04);
}
.net-table tr.sel td {
  background: rgba(88, 101, 242, 0.12);
}
.mono {
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
}
.dim {
  color: #949ba4;
  word-break: break-all;
  line-height: 1.25;
}
.col-name {
  max-width: 38vw;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.col-sm {
  width: 52px;
}
.col-st {
  width: 64px;
}
.col-type {
  width: 88px;
}
.col-init {
  max-width: 22vw;
}
.col-size {
  width: 72px;
}
.col-time {
  width: 72px;
}
.col-wf {
  width: 100px;
  padding-right: 0.6rem;
}
.st-pill {
  display: inline-block;
  min-width: 2.2rem;
  text-align: center;
  padding: 0.12rem 0.35rem;
  border-radius: 4px;
  font-size: 0.72rem;
  font-weight: 600;
}
.st-pending {
  background: #3f4147;
  color: #b5bac1;
}
.st-2 {
  background: rgba(59, 165, 93, 0.25);
  color: #49e57a;
}
.st-3 {
  background: rgba(88, 101, 242, 0.25);
  color: #949cfa;
}
.st-4 {
  background: rgba(250, 168, 26, 0.2);
  color: #faa81a;
}
.st-5,
.st-fail {
  background: rgba(237, 66, 69, 0.22);
  color: #ff7a7c;
}
.st-other {
  background: #3f4147;
  color: #dbdee1;
}
.wf-track {
  height: 6px;
  background: #2b2d31;
  border-radius: 3px;
  overflow: hidden;
}
.wf-bar {
  height: 100%;
  background: linear-gradient(90deg, #5865f2, #7289da);
  border-radius: 3px;
  min-width: 2px;
}
.net-empty {
  color: #949ba4;
  padding: 1.5rem;
  text-align: center;
}

.detail-panel {
  display: flex;
  flex-direction: column;
  overflow: hidden;
  min-height: 0;
  flex: 1 1 0;
}
.detail-inner-tabs {
  display: flex;
  gap: 0.25rem;
  padding: 0.4rem 0.5rem 0;
  border-bottom: 1px solid #3c3c3c;
  flex-shrink: 0;
}
.detail-inner-tabs button {
  background: transparent;
  border: none;
  color: #949ba4;
  padding: 0.35rem 0.75rem;
  cursor: pointer;
  font-size: 0.78rem;
  font-weight: 600;
  border-radius: 6px 6px 0 0;
}
.detail-inner-tabs button.on {
  background: #1e1f22;
  color: #fff;
  border: 1px solid #3c3c3c;
  border-bottom-color: #1e1f22;
  margin-bottom: -1px;
}
.detail-tab-body {
  flex: 1;
  min-height: 0;
  overflow: auto;
  padding: 0.5rem 0.75rem 0.65rem;
  background: #1e1f22;
}
.detail-sub {
  margin: 0.25rem 0 0;
  font-size: 0.72rem;
  color: #949ba4;
}
.detail-url {
  margin: 0;
  font-size: 0.72rem;
  color: #dbdee1;
  word-break: break-all;
  line-height: 1.35;
}
.detail-meta {
  margin: 0;
  font-size: 0.72rem;
  color: #949ba4;
  display: flex;
  gap: 0.5rem;
  flex-wrap: wrap;
}
.detail-box {
  margin: 0;
  padding: 0.45rem 0.5rem;
  background: #111214;
  border: 1px solid #3c3c3c;
  border-radius: 6px;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 0.7rem;
  color: #c9ccd1;
  white-space: pre-wrap;
  word-break: break-word;
  overflow: auto;
  max-height: min(32vh, 280px);
}
.detail-body {
  max-height: min(28vh, 240px);
}
.detail-trunc {
  margin: 0;
  font-size: 0.68rem;
  color: #faa81a;
}

.debug-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}
.debug-table th {
  position: sticky;
  top: 0;
  background: #252526;
  text-align: left;
  padding: 0.45rem 0.5rem;
  border-bottom: 1px solid #3f4147;
  color: #949ba4;
  font-weight: 600;
}
.debug-table td {
  padding: 0.35rem 0.5rem;
  border-bottom: 1px solid #2f3136;
  vertical-align: top;
}
.debug-table tr:hover td {
  background: rgba(255, 255, 255, 0.03);
  cursor: pointer;
}
.debug-table .t {
  color: #949ba4;
  white-space: nowrap;
  width: 1%;
}
.debug-table .k {
  color: #59b0ff;
  width: 1%;
  white-space: nowrap;
}
.debug-table .s {
  word-break: break-all;
  font-family: ui-monospace, "Cascadia Code", Consolas, monospace;
  font-size: 0.78rem;
}
</style>
