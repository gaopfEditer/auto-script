<script setup>
import { ref, computed, onMounted } from "vue";
import { useCollectorSocket } from "../composables/useCollectorSocket.js";
import { useDebugMode } from "../composables/useDebugMode.js";
import { extractDiscordDisplay } from "../lib/discordExtract.js";
import { isBlockedWsFrame, isForwardableWsFrameMessage } from "../lib/wsNoiseFilter.js";
import {
  useDebugNetwork,
  nameFromUrl,
  displayStatus,
  statusPillClass,
} from "../lib/useDebugNetwork.js";

defineOptions({ name: "DebugView" });

const tab = ref(/** @type {"network" | "frames"} */ ("network"));
const { netRows, miscEvents, ingest } = useDebugNetwork();
const selected = ref(/** @type {Record<string, unknown> | null} */ (null));
const frameLines = ref(
  /** @type {Array<{ id: string, ts: number, author: string, typeLabel: string, text: string, guildLabel: string, channelLabel: string }>} */ ([])
);
const filterText = ref("");
const { debugMode, applyConfigFromSocket } = useDebugMode();

const tgEnabled = ref(false);
const tgChatId = ref("");
const tgSendUrl = ref("");
const tgTesting = ref(false);
const tgResult = ref("");
const tgResultOk = ref(/** @type {boolean | null} */ (null));
const tgTestText = ref("");

const simChannels = ref(/** @type {Array<{ id: string; name: string; parser: string }>} */ ([]));
const simChannelId = ref("1444963506431463474");
const simContent = ref("");
const simLoading = ref(false);
const simResult = ref("");
const simResultOk = ref(/** @type {boolean | null} */ (null));
const simBitget = ref(/** @type {Record<string, unknown> | null} */ (null));
const simWeex = ref(/** @type {Record<string, unknown> | null} */ (null));
const simHints = ref(/** @type {string[]} */ ([]));
const simExamples = ref(/** @type {Record<string, { open?: string; tpsl?: string }>} */ ({}));
const simHistory = ref(
  /** @type {Array<{ ts: number; content: string; phase?: string; skipped?: string; cardId?: number; ok: boolean }>} */ ([])
);

const TRADE_PLATFORMS_STORAGE_KEY = "discord-collector-trade-platforms";
const tradePlatforms = ref({ bitget: true, weex: true });
const requiredChannelIds = ref(/** @type {string[]} */ ([]));

function loadTradePlatformsFromStorage() {
  try {
    const raw = localStorage.getItem(TRADE_PLATFORMS_STORAGE_KEY);
    if (!raw) return;
    const o = JSON.parse(raw);
    if (o && typeof o === "object") {
      tradePlatforms.value = {
        bitget: o.bitget !== false,
        weex: o.weex !== false,
      };
    }
  } catch {
    /* ignore */
  }
}

function saveTradePlatformsToStorage() {
  try {
    localStorage.setItem(TRADE_PLATFORMS_STORAGE_KEY, JSON.stringify(tradePlatforms.value));
  } catch {
    /* ignore */
  }
}

async function syncTradePlatformsToServer() {
  try {
    await fetch("/api/debug/trade-platforms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(tradePlatforms.value),
    });
  } catch {
    /* ignore */
  }
}

async function onTradePlatformChange() {
  saveTradePlatformsToStorage();
  await syncTradePlatformsToServer();
}

async function loadSimulateConfig() {
  try {
    const res = await fetch("/api/debug/simulate-signal");
    const data = await res.json();
    if (data.ok) {
      simChannels.value = Array.isArray(data.channels) ? data.channels : [];
      simChannelId.value = String(data.defaultChannelId ?? "1444963506431463474");
      simBitget.value = data.bitget ?? null;
      simWeex.value = data.weex ?? null;
      simHints.value = Array.isArray(data.hints) ? data.hints : [];
      simExamples.value = data.examples && typeof data.examples === "object" ? data.examples : {};
      requiredChannelIds.value = Array.isArray(data.requiredChannelIds) ? data.requiredChannelIds : [];
      if (data.tradePlatforms && typeof data.tradePlatforms === "object") {
        tradePlatforms.value = {
          bitget: data.tradePlatforms.bitget !== false,
          weex: data.tradePlatforms.weex !== false,
        };
      }
    }
  } catch {
    simChannels.value = [
      { id: "1444963506431463474", name: "山寨之王", parser: "altcoin_king" },
      { id: "1444963372134301827", name: "seven", parser: "tw_opg" },
    ];
  }
}

const simParserKey = computed(() => {
  const ch = simChannels.value.find((c) => c.id === simChannelId.value);
  return ch?.parser ?? "altcoin_king";
});

const simExampleOpen = computed(() => simExamples.value[simParserKey.value]?.open ?? "#SOL 市价多");
const simExampleTpsl = computed(
  () => simExamples.value[simParserKey.value]?.tpsl ?? "止盈：4.71\n止損：4.9"
);

function fillSimExample(kind) {
  simContent.value = kind === "tpsl" ? simExampleTpsl.value : simExampleOpen.value;
}

const SKIP_HINTS = {
  duplicate_content_4h: "4h 内相同正文（Debug 已应跳过，请重启 collect:ui）",
  duplicate_symbol_4h: "4h 内同币种已开仓（Debug 已应跳过，请重启 collect:ui）",
  duplicate_text: "正文完全相同",
  parse_failed: "无法解析信号，检查格式",
  not_signal_channel: "非信号频道",
};

async function submitSimulateSignal() {
  const content = simContent.value.trim();
  if (!content || simLoading.value) return;
  simLoading.value = true;
  simResult.value = "处理中（Bitget 下单可能需数秒）…";
  simResultOk.value = null;
  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 120_000);
    const res = await fetch("/api/debug/simulate-signal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        channelId: simChannelId.value,
        content,
        tradePlatforms: tradePlatforms.value,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await res.json();
    simBitget.value = data.bitget ?? simBitget.value;
    const phase = String(data.parsed?.signalPhase ?? "");
    const skipped = data.skipped ? String(data.skipped) : "";
    const cardId = Number(data.card?.id);
    const bg = data.bitgetResult;
    let detail = "";
    if (skipped) detail = SKIP_HINTS[skipped] ?? `跳过: ${skipped}`;
    else if (data.merged) detail = `TP/SL 已合并 → 卡片 #${cardId || "?"}`;
    else if (cardId) detail = `卡片 #${cardId} · phase=${phase || "?"}`;
    if (bg && typeof bg === "object") {
      const b = /** @type {Record<string, unknown>} */ (bg);
      if (b.staged && b.record) {
        const rec = /** @type {Record<string, unknown>} */ (b.record);
        detail += ` · Bitget ${rec.status ?? "ok"} ${rec.symbol ?? ""} ${rec.leverage ?? "?"}x size=${rec.size ?? ""}`;
        const sl = rec.presetStopLossPrice ?? rec.initialSlPrice;
        if (sl) detail += ` SL=${sl}`;
      } else if (b.failed) detail += ` · Bitget 失败: ${b.reason ?? "?"}`;
      else if (b.skipped === "platform_toggle_off") detail += " · Bitget 未推送（Debug 勾选关闭）";
      else if (b.skipped) detail += ` · Bitget 跳过: ${b.skipped}`;
      else if (b.dryRun) detail += " · Bitget dry-run";
    }
    const wx = data.weexResult;
    if (wx && typeof wx === "object") {
      const w = /** @type {Record<string, unknown>} */ (wx);
      if (w.staged && w.record) {
        const rec = /** @type {Record<string, unknown>} */ (w.record);
        detail += ` · WEEX ${rec.status ?? "ok"} ${rec.symbol ?? ""} ${rec.leverage ?? "?"}x`;
      } else if (w.failed) detail += ` · WEEX 失败: ${w.reason ?? "?"}${w.error ? ` (${w.error})` : ""}`;
      else if (w.skipped === "platform_toggle_off") detail += " · WEEX 未推送（Debug 勾选关闭）";
      else if (w.skipped) detail += ` · WEEX 跳过: ${w.skipped}`;
    }
    simResultOk.value = Boolean(data.ok);
    simResult.value = detail || (data.error ? String(data.error) : res.ok ? "已处理" : `HTTP ${res.status}`);
    simHistory.value.unshift({
      ts: Date.now(),
      content: content.slice(0, 120),
      phase,
      skipped: skipped || undefined,
      cardId: cardId || undefined,
      ok: Boolean(data.ok),
    });
    if (simHistory.value.length > 20) simHistory.value.length = 20;
    if (data.ok && !skipped) simContent.value = "";
  } catch (e) {
    simResultOk.value = false;
    simResult.value =
      e instanceof Error && e.name === "AbortError"
        ? "请求超时（>120s），可能 Bitget 或 Ollama 卡住"
        : e instanceof Error
          ? e.message
          : String(e);
  } finally {
    simLoading.value = false;
  }
}

/** @param {KeyboardEvent} e */
function onSimKeydown(e) {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    void submitSimulateSignal();
  }
}

async function loadTelegramStatus() {
  try {
    const res = await fetch("/api/debug/telegram");
    const data = await res.json();
    if (data.ok) {
      tgEnabled.value = Boolean(data.enabled);
      tgChatId.value = data.chatId ? String(data.chatId) : "";
      tgSendUrl.value = data.sendUrl ? String(data.sendUrl) : "";
    }
  } catch {
    tgEnabled.value = false;
  }
}

async function sendTelegramTest() {
  tgTesting.value = true;
  tgResult.value = "";
  tgResultOk.value = null;
  try {
    const body = tgTestText.value.trim() ? { text: tgTestText.value.trim() } : {};
    const res = await fetch("/api/debug/telegram-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const data = await res.json();
    if (data.ok) {
      tgResultOk.value = true;
      tgResult.value = `已发送 → chat=${data.chatId}`;
    } else {
      tgResultOk.value = false;
      tgResult.value = data.error || data.skipped || `失败 HTTP ${res.status}`;
      if (data.hint) tgResult.value += `（${data.hint}）`;
    }
  } catch (e) {
    tgResultOk.value = false;
    tgResult.value = e instanceof Error ? e.message : String(e);
  } finally {
    tgTesting.value = false;
  }
}

/** @param {Record<string, unknown>} msg */
function onSocketMsg(msg) {
  applyConfigFromSocket(msg);
  ingest(msg);
  if (msg.channel === "frame" && msg.kind === "ws_frame") {
    if (!isForwardableWsFrameMessage(msg)) return;
    const body = msg.body;
    const j = body && typeof body === "object" && "json" in body ? body.json : null;
    const display = extractDiscordDisplay(j, debugMode.value);
    frameLines.value.unshift({
      id: `f-${msg.seq}-${msg.ts}`,
      ts: Number(msg.ts),
      author: display.author,
      typeLabel: display.typeLabel,
      text: display.text,
      guildLabel: display.guildLabel,
      channelLabel: display.channelLabel,
    });
    if (frameLines.value.length > 300) frameLines.value.length = 300;
  }
}

useCollectorSocket(onSocketMsg);

const filteredNet = computed(() => {
  const q = filterText.value.trim().toLowerCase();
  if (!q) return netRows.value;
  return netRows.value.filter((r) => {
    const hay = `${r.name ?? ""} ${r.url ?? ""} ${r.method ?? ""}`.toLowerCase();
    return hay.includes(q) || (q.includes("discord") && String(r.url ?? "").includes("discord"));
  });
});

onMounted(async () => {
  loadTradePlatformsFromStorage();
  await syncTradePlatformsToServer();
  void loadTelegramStatus();
  void loadSimulateConfig();
  try {
    const res = await fetch("/api/frames?limit=80");
    const data = await res.json();
    if (data.ok && Array.isArray(data.rows)) {
      for (const row of data.rows.slice().reverse()) {
        let j = row.parsed_json;
        if (typeof j === "string") {
          try {
            j = JSON.parse(j);
          } catch {
            j = null;
          }
        }
        if (!j) continue;
        if (isBlockedWsFrame(j)) continue;
        const display = extractDiscordDisplay(j, debugMode.value);
        frameLines.value.push({
          id: `h-${row.id}`,
          ts: new Date(row.received_at).getTime(),
          author: display.author,
          typeLabel: display.typeLabel,
          text: display.text,
          guildLabel: display.guildLabel,
          channelLabel: display.channelLabel,
        });
      }
    }
  } catch {
    /* ignore */
  }
});

function isDiscordRow(row) {
  const u = String(row.url ?? "").toLowerCase();
  return u.includes("discord.com") || u.includes("gateway.discord");
}
</script>

<template>
  <div class="debug-root">
    <aside class="sidebar">
      <div class="tg-panel">
        <div class="tg-head">
          <span class="tg-label">Telegram 链路</span>
          <span class="tg-badge" :class="{ on: tgEnabled }">{{ tgEnabled ? "已配置" : "未配置" }}</span>
        </div>
        <p v-if="tgEnabled" class="tg-meta">chat={{ tgChatId }} · {{ tgSendUrl }}</p>
        <p v-else class="tg-meta warn">需 TELEGRAM_PUSH_CHAT_ID + TELEGRAM_SEND_URL</p>
        <input
          v-model="tgTestText"
          class="tg-input"
          placeholder="可选自定义测试文案（留空用默认）"
        />
        <button type="button" class="tg-btn" :disabled="!tgEnabled || tgTesting" @click="sendTelegramTest">
          {{ tgTesting ? "发送中…" : "发送 Telegram 测试" }}
        </button>
        <p v-if="tgResult" class="tg-result" :class="{ err: tgResultOk === false }">
          {{ tgResult }}
        </p>
      </div>
      <div class="tg-panel sim-panel">
        <div class="tg-head">
          <span class="tg-label">信号模拟 · Bitget + WEEX</span>
          <span class="tg-badge" :class="{ on: simBitget && !simBitget.dryRun }">
            Bitget {{ simBitget?.dryRun ? "Dry-run" : simBitget?.enabled ? "实盘" : "关" }}
          </span>
          <span class="tg-badge" :class="{ on: simWeex && !simWeex.dryRun }">
            WEEX {{ simWeex?.dryRun ? "Dry-run" : simWeex?.enabled ? "实盘" : "关" }}
          </span>
        </div>
        <label class="sim-field">
          <span class="sim-lbl">频道</span>
          <select v-model="simChannelId" class="sim-select">
            <option v-for="ch in simChannels" :key="ch.id" :value="ch.id">
              {{ ch.name }} ({{ ch.id.slice(-6) }})
            </option>
          </select>
        </label>
        <div class="sim-platforms">
          <span class="sim-lbl">推送平台</span>
          <label class="sim-check">
            <input v-model="tradePlatforms.bitget" type="checkbox" @change="onTradePlatformChange" />
            Bitget
          </label>
          <label class="sim-check">
            <input v-model="tradePlatforms.weex" type="checkbox" @change="onTradePlatformChange" />
            WEEX
          </label>
        </div>
        <p v-if="requiredChannelIds.length" class="sim-channel-hint">
          自动交易频道白名单（.env 必填）：{{ requiredChannelIds.map((id) => id.slice(-6)).join(", ") }}
        </p>
        <textarea
          v-model="simContent"
          class="sim-textarea"
          rows="4"
          placeholder="粘贴信号正文，回车提交…"
          @keydown="onSimKeydown"
        />
        <div class="sim-actions">
          <button type="button" class="sim-link" @click="fillSimExample('open')">示例·开仓</button>
          <button type="button" class="sim-link" @click="fillSimExample('tpsl')">示例·TP/SL</button>
          <button
            type="button"
            class="tg-btn sim-submit"
            :disabled="simLoading || !simContent.trim()"
            @click="submitSimulateSignal"
          >
            {{ simLoading ? "处理中…" : "提交（Enter）" }}
          </button>
        </div>
        <ul v-if="simHints.length" class="sim-hints">
          <li v-for="(h, i) in simHints" :key="i">{{ h }}</li>
        </ul>
        <p v-if="simResult" class="tg-result" :class="{ err: simResultOk === false }">{{ simResult }}</p>
        <div v-if="simHistory.length" class="sim-history">
          <div v-for="(h, i) in simHistory" :key="i" class="sim-hist-row" :class="{ bad: !h.ok }">
            <span class="sim-hist-ts">{{ new Date(h.ts).toLocaleTimeString() }}</span>
            <span>{{ h.skipped || h.phase || "—" }}</span>
            <span v-if="h.cardId">#{{ h.cardId }}</span>
            <span class="sim-hist-text">{{ h.content }}</span>
          </div>
        </div>
      </div>
      <div class="tabs">
        <button :class="{ active: tab === 'network' }" @click="tab = 'network'">Network</button>
        <button :class="{ active: tab === 'frames' }" @click="tab = 'frames'">WS 帧</button>
      </div>
      <input v-model="filterText" class="filter" placeholder="过滤 URL…" />
      <p class="mode-line">{{ debugMode ? "Debug：WS/API 全量 JSON" : "精简：仅摘要" }}</p>

      <div v-show="tab === 'network'" class="list">
        <div
          v-for="row in filteredNet"
          :key="String(row.requestId)"
          class="row"
          :class="{ discord: isDiscordRow(row), selected: selected === row }"
          @click="selected = row"
        >
          <span class="pill" :class="statusPillClass(displayStatus(row))">{{ displayStatus(row) }}</span>
          <span class="name">{{ row.name || nameFromUrl(String(row.url ?? '')) }}</span>
        </div>
      </div>

      <div v-show="tab === 'frames'" class="list frames">
        <div v-for="line in frameLines" :key="line.id" class="frame-line">
          <span class="tag">{{ line.typeLabel }}</span>
          <span v-if="line.guildLabel" class="loc">{{ line.guildLabel }}</span>
          <span v-if="line.channelLabel" class="loc">{{ line.channelLabel }}</span>
          <strong>{{ line.author }}</strong>
          <pre v-if="debugMode" class="text full">{{ line.text || "—" }}</pre>
          <span v-else class="text">{{ line.text || "—" }}</span>
        </div>
      </div>
    </aside>

    <section class="detail">
      <template v-if="selected">
        <h3>{{ selected.method }} {{ selected.name }}</h3>
        <pre>{{ JSON.stringify(selected, null, debugMode ? 2 : 0) }}</pre>
      </template>
      <template v-else>
        <p class="hint">左侧选择网络请求；Discord 行高亮。Debug 模式下右侧/WS 帧显示完整 JSON。</p>
        <p class="hint">杂项事件：{{ miscEvents.length }} 条</p>
      </template>
    </section>
  </div>
</template>

<style scoped>
.debug-root {
  display: flex;
  height: 100%;
  min-height: 0;
}
.sidebar {
  width: 42%;
  min-width: 280px;
  border-right: 1px solid #1e1f22;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.tg-panel {
  margin: 0.5rem;
  padding: 0.55rem 0.65rem;
  border-radius: 8px;
  background: #1e1f22;
  border: 1px solid #3f4147;
  flex-shrink: 0;
}
.tg-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}
.tg-label {
  font-size: 0.78rem;
  font-weight: 700;
  color: #dbdee1;
}
.tg-badge {
  font-size: 0.68rem;
  padding: 0.1rem 0.4rem;
  border-radius: 4px;
  background: #3f4147;
  color: #949ba4;
}
.tg-badge.on {
  background: #248046;
  color: #fff;
}
.tg-meta {
  margin: 0.35rem 0 0.45rem;
  font-size: 0.68rem;
  color: #949ba4;
  word-break: break-all;
  line-height: 1.35;
}
.tg-meta.warn {
  color: #faa61a;
}
.tg-input {
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 0.4rem;
  padding: 0.35rem 0.5rem;
  border-radius: 6px;
  border: 1px solid #3f4147;
  background: #111214;
  color: #dbdee1;
  font-size: 0.72rem;
}
.tg-btn {
  width: 100%;
  padding: 0.4rem 0.5rem;
  border: none;
  border-radius: 6px;
  background: #5865f2;
  color: #fff;
  font-weight: 600;
  font-size: 0.78rem;
  cursor: pointer;
}
.tg-btn:disabled {
  opacity: 0.45;
  cursor: not-allowed;
}
.tg-result {
  margin: 0.4rem 0 0;
  font-size: 0.72rem;
  color: #57f287;
  word-break: break-word;
}
.tg-result.err {
  color: #ed4245;
}
.sim-panel {
  border-color: #faa61a55;
}
.sim-field {
  display: block;
  margin-bottom: 0.4rem;
}
.sim-platforms {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem 0.75rem;
  margin-bottom: 0.4rem;
}
.sim-check {
  display: inline-flex;
  align-items: center;
  gap: 0.25rem;
  font-size: 0.72rem;
  color: #dbdee1;
  cursor: pointer;
}
.sim-check input {
  accent-color: #5865f2;
}
.sim-channel-hint {
  margin: 0 0 0.4rem;
  font-size: 0.65rem;
  color: #72767d;
  line-height: 1.35;
}
.sim-lbl {
  display: block;
  font-size: 0.68rem;
  color: #949ba4;
  margin-bottom: 0.2rem;
}
.sim-select {
  width: 100%;
  box-sizing: border-box;
  padding: 0.35rem 0.5rem;
  border-radius: 6px;
  border: 1px solid #3f4147;
  background: #111214;
  color: #dbdee1;
  font-size: 0.72rem;
}
.sim-textarea {
  width: 100%;
  box-sizing: border-box;
  margin-bottom: 0.4rem;
  padding: 0.4rem 0.5rem;
  border-radius: 6px;
  border: 1px solid #3f4147;
  background: #111214;
  color: #dbdee1;
  font-size: 0.72rem;
  line-height: 1.4;
  resize: vertical;
  font-family: inherit;
}
.sim-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: center;
  margin-bottom: 0.35rem;
}
.sim-link {
  padding: 0.2rem 0.45rem;
  border: 1px solid #3f4147;
  border-radius: 4px;
  background: transparent;
  color: #949ba4;
  font-size: 0.68rem;
  cursor: pointer;
}
.sim-submit {
  margin-left: auto;
  width: auto;
  flex: 1;
  min-width: 120px;
}
.sim-hints {
  margin: 0.25rem 0 0;
  padding-left: 1rem;
  font-size: 0.65rem;
  color: #72767d;
  line-height: 1.35;
}
.sim-history {
  margin-top: 0.45rem;
  max-height: 120px;
  overflow: auto;
  font-size: 0.65rem;
  border-top: 1px solid #3f4147;
  padding-top: 0.35rem;
}
.sim-hist-row {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  padding: 0.15rem 0;
  color: #57f287;
}
.sim-hist-row.bad {
  color: #faa61a;
}
.sim-hist-ts {
  color: #72767d;
}
.sim-hist-text {
  flex: 1 1 100%;
  color: #949ba4;
  word-break: break-word;
}
.tabs {
  display: flex;
  gap: 0.5rem;
  padding: 0.5rem;
}
.tabs button {
  flex: 1;
  padding: 0.4rem;
  border: none;
  border-radius: 6px;
  background: #2b2d31;
  color: #b5bac1;
  cursor: pointer;
}
.tabs button.active {
  background: #5865f2;
  color: #fff;
}
.filter {
  margin: 0 0.5rem 0.5rem;
  padding: 0.4rem 0.6rem;
  border-radius: 6px;
  border: 1px solid #3f4147;
  background: #1e1f22;
  color: #dbdee1;
}
.mode-line {
  margin: 0 0.5rem 0.5rem;
  font-size: 0.72rem;
  color: #949ba4;
}
.list {
  flex: 1;
  overflow: auto;
  font-size: 0.82rem;
}
.row {
  padding: 0.35rem 0.6rem;
  cursor: pointer;
  border-bottom: 1px solid #2b2d31;
  display: flex;
  gap: 0.4rem;
  align-items: center;
}
.row.discord {
  background: rgba(88, 101, 242, 0.12);
}
.row.selected {
  background: #404249;
}
.pill {
  font-size: 0.7rem;
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
  background: #3f4147;
  flex-shrink: 0;
}
.st-2 {
  background: #248046;
}
.st-fail {
  background: #da373c;
}
.name {
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.frames .frame-line {
  padding: 0.4rem 0.6rem;
  border-bottom: 1px solid #2b2d31;
  line-height: 1.35;
}
.tag {
  font-size: 0.68rem;
  background: #5865f2;
  color: #fff;
  padding: 0.05rem 0.3rem;
  border-radius: 3px;
  margin-right: 0.35rem;
}
.loc {
  font-size: 0.68rem;
  color: #949ba4;
  margin-right: 0.35rem;
}
.text {
  color: #949ba4;
  display: block;
  margin-top: 0.15rem;
  word-break: break-word;
}
.text.full {
  font-size: 0.68rem;
  white-space: pre-wrap;
  max-height: 200px;
  overflow: auto;
  background: #1e1f22;
  padding: 0.35rem;
  border-radius: 4px;
}
.detail {
  flex: 1;
  overflow: auto;
  padding: 1rem;
}
.detail pre {
  font-size: 0.75rem;
  background: #1e1f22;
  padding: 0.75rem;
  border-radius: 8px;
  overflow: auto;
  max-height: calc(100vh - 120px);
}
.hint {
  color: #949ba4;
}
</style>
