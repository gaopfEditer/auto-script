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

const simContent = ref("");
const simLoading = ref(false);
const simResult = ref("");
const simResultOk = ref(/** @type {boolean | null} */ (null));
const simBitget = ref(/** @type {Record<string, unknown> | null} */ (null));
const simWeex = ref(/** @type {Record<string, unknown> | null} */ (null));
const simHints = ref(/** @type {string[]} */ ([]));
const simHistory = ref(
  /** @type {Array<{ ts: number; content: string; skipped?: string; cardId?: number; ok: boolean }>} */ ([])
);
const telegramSendChannels = ref(/** @type {Array<{ id: string; name: string }>} */ ([]));
const simSendLoadError = ref("");
const exampleSignal = ref("");

const TRADE_PLATFORMS_STORAGE_KEY = "discord-collector-trade-platforms";
const tradePlatforms = ref({ bitget: true, weex: true });
const tradeOrderSizeUsdt = ref(1);

const oiTgOnline = ref(false);
const oiTgLoading = ref(false);
const oiTgSaving = ref(false);
const oiTgTesting = ref(false);
const oiTgToggles = ref({ candle: true, structure: true, main: true });
const oiTgChatIds = ref({ candle: "", main: "" });
const oiTgTransport = ref({ gateway: false, botToken: false, ready: false });
const oiTgHint = ref("");
const oiTgResult = ref("");
const oiTgResultOk = ref(/** @type {boolean | null} */ (null));
const oiTgBase = ref("");

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
      const sz = Number(o.orderSizeUsdt);
      if (Number.isFinite(sz) && sz > 0) tradeOrderSizeUsdt.value = sz;
    }
  } catch {
    /* ignore */
  }
}

function saveTradePlatformsToStorage() {
  try {
    localStorage.setItem(
      TRADE_PLATFORMS_STORAGE_KEY,
      JSON.stringify({ ...tradePlatforms.value, orderSizeUsdt: tradeOrderSizeUsdt.value })
    );
  } catch {
    /* ignore */
  }
}

async function syncTradePlatformsToServer() {
  try {
    await fetch("/api/debug/trade-platforms", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ ...tradePlatforms.value, orderSizeUsdt: tradeOrderSizeUsdt.value }),
    });
  } catch {
    /* ignore */
  }
}

async function onTradePlatformChange() {
  saveTradePlatformsToStorage();
  await syncTradePlatformsToServer();
}

async function loadOiTelegramPush() {
  oiTgLoading.value = true;
  try {
    const res = await fetch("/api/debug/oi-telegram-push");
    const data = await res.json();
    oiTgOnline.value = Boolean(data.oiOnline ?? data.ok);
    oiTgBase.value = String(data.oiBase ?? "");
    if (data.toggles && typeof data.toggles === "object") {
      oiTgToggles.value = {
        candle: data.toggles.candle !== false,
        structure: data.toggles.structure !== false,
        main: data.toggles.main !== false,
      };
    }
    if (data.chatIds && typeof data.chatIds === "object") {
      oiTgChatIds.value = {
        candle: String(data.chatIds.candle ?? ""),
        main: String(data.chatIds.main ?? ""),
      };
    }
    if (data.transport && typeof data.transport === "object") {
      oiTgTransport.value = {
        gateway: Boolean(data.transport.gateway),
        botToken: Boolean(data.transport.botToken),
        ready: Boolean(data.transport.ready),
      };
    }
    oiTgHint.value = String(data.hint || data.error || "");
  } catch (e) {
    oiTgOnline.value = false;
    oiTgHint.value = e instanceof Error ? e.message : String(e);
  } finally {
    oiTgLoading.value = false;
  }
}

async function onOiTgToggleChange() {
  oiTgSaving.value = true;
  oiTgResult.value = "";
  oiTgResultOk.value = null;
  try {
    const res = await fetch("/api/debug/oi-telegram-push", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ toggles: oiTgToggles.value }),
    });
    const data = await res.json();
    oiTgOnline.value = Boolean(data.oiOnline ?? data.ok);
    if (data.toggles && typeof data.toggles === "object") {
      oiTgToggles.value = {
        candle: data.toggles.candle !== false,
        structure: data.toggles.structure !== false,
        main: data.toggles.main !== false,
      };
    }
    oiTgResultOk.value = Boolean(data.ok) && oiTgOnline.value;
    oiTgResult.value = oiTgOnline.value
      ? `已保存 · candle=${oiTgToggles.value.candle} structure=${oiTgToggles.value.structure} main=${oiTgToggles.value.main}`
      : data.error || data.hint || "OI 未在线，开关未生效";
  } catch (e) {
    oiTgResultOk.value = false;
    oiTgResult.value = e instanceof Error ? e.message : String(e);
  } finally {
    oiTgSaving.value = false;
  }
}

/** @param {"candle"|"main"} target */
async function sendOiTgTest(target) {
  oiTgTesting.value = true;
  oiTgResult.value = "";
  oiTgResultOk.value = null;
  try {
    const res = await fetch("/api/debug/oi-telegram-push-test", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ target }),
    });
    const data = await res.json();
    oiTgOnline.value = Boolean(data.oiOnline ?? true);
    if (data.ok) {
      oiTgResultOk.value = true;
      oiTgResult.value = `测试已发送 → ${target} chat=${data.chatId}`;
    } else {
      oiTgResultOk.value = false;
      oiTgResult.value = data.error || data.hint || `失败 HTTP ${res.status}`;
    }
  } catch (e) {
    oiTgResultOk.value = false;
    oiTgResult.value = e instanceof Error ? e.message : String(e);
  } finally {
    oiTgTesting.value = false;
  }
}

/** @param {unknown} raw */
function normalizeSendChannelList(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (!item || typeof item !== "object") return null;
      const o = /** @type {Record<string, unknown>} */ (item);
      const id = String(o.id ?? o.chatId ?? "").trim();
      if (!id) return null;
      const name = String(o.name ?? o.channelName ?? id).trim() || id;
      return { id, name };
    })
    .filter(Boolean);
}

/** 从 live/channels 的 sendChatIds + channels 组装白名单展示 */
/** @param {Record<string, unknown>} data */
function sendChannelsFromLiveApi(data) {
  const sendIds = Array.isArray(data.sendChatIds) ? data.sendChatIds.map((x) => String(x).trim()).filter(Boolean) : [];
  if (!sendIds.length) return [];
  /** @type {Map<string, string>} */
  const nameById = new Map();
  for (const item of Array.isArray(data.channels) ? data.channels : []) {
    if (!item || typeof item !== "object") continue;
    const o = /** @type {Record<string, unknown>} */ (item);
    const id = String(o.chatId ?? o.id ?? "").trim();
    if (id) nameById.set(id, String(o.name ?? o.channelName ?? id).trim() || id);
  }
  return sendIds.map((id) => ({ id, name: nameById.get(id) ?? id }));
}

async function loadTelegramSendChannels() {
  simSendLoadError.value = "";
  /** @type {Array<{ id: string; name: string }>} */
  let list = [];

  for (const url of ["/api/debug/trade-platforms", "/api/debug/simulate-signal"]) {
    try {
      const res = await fetch(url);
      const data = await res.json();
      list = normalizeSendChannelList(data.telegramSendChannels);
      if (list.length) {
        telegramSendChannels.value = list;
        return;
      }
      if (data.channelProfilesError) {
        simSendLoadError.value = String(data.channelProfilesError);
      }
    } catch (e) {
      simSendLoadError.value = e instanceof Error ? e.message : String(e);
    }
  }

  try {
    const res = await fetch("/api/telegram/live/channels");
    const data = await res.json();
    list = sendChannelsFromLiveApi(data);
    if (list.length) {
      telegramSendChannels.value = list;
      simSendLoadError.value = "";
      return;
    }
    if (data.error) simSendLoadError.value = String(data.error);
    else if (!data.profilesOk) simSendLoadError.value = "channel_profiles.json 读取失败";
  } catch (e) {
    if (!simSendLoadError.value) {
      simSendLoadError.value = e instanceof Error ? e.message : String(e);
    }
  }

  if (!list.length && !simSendLoadError.value) {
    simSendLoadError.value = "send 数组为空，请检查 telegram/channel_profiles.json";
  }
}

async function loadSimulateConfig() {
  await loadTelegramSendChannels();
  try {
    const res = await fetch("/api/debug/simulate-signal");
    const data = await res.json();
    if (data.ok) {
      const fromApi = normalizeSendChannelList(data.telegramSendChannels);
      if (fromApi.length) telegramSendChannels.value = fromApi;
      simBitget.value = data.bitget ?? null;
      simWeex.value = data.weex ?? null;
      simHints.value = Array.isArray(data.hints) ? data.hints : [];
      exampleSignal.value = String(data.exampleSignal ?? "");
      if (data.tradePlatforms && typeof data.tradePlatforms === "object") {
        tradePlatforms.value = {
          bitget: data.tradePlatforms.bitget !== false,
          weex: data.tradePlatforms.weex !== false,
        };
      }
      const sz = Number(data.orderSizeUsdt);
      if (Number.isFinite(sz) && sz > 0) tradeOrderSizeUsdt.value = sz;
    }
  } catch {
    /* loadTelegramSendChannels 已处理 send 列表 */
  }
}

function fillSimExample() {
  simContent.value = exampleSignal.value || "";
}

const SKIP_HINTS = {
  parse_failed: "无法解析 Telegram 结构化信号（需币种、方向、进场/止盈/止损）",
  send_list_empty: "channel_profiles.json send 白名单为空",
  major_symbol_excluded: "主流币 BTC/ETH 不自动交易",
  missing_tpsl: "缺止盈止损或无法补默认 TP/SL",
  platform_toggle_off: "平台未勾选",
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
        content,
        tradePlatforms: tradePlatforms.value,
        orderSizeUsdt: tradeOrderSizeUsdt.value,
      }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await res.json();
    simBitget.value = data.bitget ?? simBitget.value;
    simWeex.value = data.weex ?? simWeex.value;
    const cardId = Number(data.card?.id);
    const errKey = data.error ? String(data.error) : "";
    let detail = "";
    if (!data.ok) {
      detail = SKIP_HINTS[errKey] ?? data.hint ?? errKey ?? `HTTP ${res.status}`;
    } else {
      detail = `卡片 #${cardId || "?"} · ${data.channelName ?? "TG"} (${String(data.channelId ?? "").slice(-6)})`;
      detail += ` · ${data.parsed?.symbol ?? ""} ${data.parsed?.direction ?? ""}`;
    }
    simResultOk.value = Boolean(data.ok);
    simResult.value = detail || (res.ok ? "已处理" : `HTTP ${res.status}`);
    simHistory.value.unshift({
      ts: Date.now(),
      content: content.slice(0, 120),
      skipped: !data.ok ? errKey || "error" : undefined,
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
  void loadOiTelegramPush();
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
      <div class="tg-panel oi-tg-panel">
        <div class="tg-head">
          <span class="tg-label">OI 形态卡片推送</span>
          <span class="tg-badge" :class="{ on: oiTgOnline }">
            {{ oiTgLoading ? "检测中…" : oiTgOnline ? "OI 在线" : "OI 离线" }}
          </span>
        </div>
        <p class="tg-meta">
          candle={{ oiTgChatIds.candle || "—" }} · main={{ oiTgChatIds.main || "—" }}
        </p>
        <p class="tg-meta" :class="{ warn: !oiTgTransport.ready }">
          通道：
          {{
            oiTgTransport.ready
              ? `${oiTgTransport.gateway ? "gateway" : ""}${oiTgTransport.gateway && oiTgTransport.botToken ? "+" : ""}${oiTgTransport.botToken ? "bot" : ""}`
              : "未配置 TELEGRAM_SEND_URL / BOT_TOKEN"
          }}
        </p>
        <div class="sim-platforms">
          <span class="sim-lbl">推送开关</span>
          <label class="sim-check">
            <input
              v-model="oiTgToggles.candle"
              type="checkbox"
              :disabled="!oiTgOnline || oiTgSaving"
              @change="onOiTgToggleChange"
            />
            形态卡片群
          </label>
          <label class="sim-check">
            <input
              v-model="oiTgToggles.structure"
              type="checkbox"
              :disabled="!oiTgOnline || oiTgSaving"
              @change="onOiTgToggleChange"
            />
            结构信号
          </label>
          <label class="sim-check">
            <input
              v-model="oiTgToggles.main"
              type="checkbox"
              :disabled="!oiTgOnline || oiTgSaving"
              @change="onOiTgToggleChange"
            />
            特别关注→MAIN
          </label>
        </div>
        <div class="sim-actions">
          <button type="button" class="sim-link" :disabled="oiTgLoading" @click="loadOiTelegramPush">
            刷新状态
          </button>
          <button
            type="button"
            class="tg-btn"
            :disabled="!oiTgOnline || oiTgTesting || !oiTgChatIds.candle"
            @click="sendOiTgTest('candle')"
          >
            测形态群
          </button>
          <button
            type="button"
            class="tg-btn"
            :disabled="!oiTgOnline || oiTgTesting || !oiTgChatIds.main"
            @click="sendOiTgTest('main')"
          >
            测 MAIN 群
          </button>
        </div>
        <p v-if="oiTgHint" class="tg-meta">{{ oiTgHint }}</p>
        <p v-if="oiTgResult" class="tg-result" :class="{ err: oiTgResultOk === false }">{{ oiTgResult }}</p>
      </div>
      <div class="tg-panel sim-panel">
        <div class="tg-head">
          <span class="tg-label">Telegram 自动开单</span>
          <span class="tg-badge" :class="{ on: simBitget && !simBitget.dryRun }">
            Bitget {{ simBitget?.dryRun ? "Dry-run" : simBitget?.enabled ? "实盘" : "关" }}
          </span>
          <span class="tg-badge" :class="{ on: simWeex && !simWeex.dryRun }">
            WEEX {{ simWeex?.dryRun ? "Dry-run" : simWeex?.enabled ? "实盘" : "关" }}
          </span>
        </div>
        <div v-if="telegramSendChannels.length" class="sim-send-groups">
          <span class="sim-send-title">send 白名单</span>
          <div class="sim-send-chips">
            <span v-for="ch in telegramSendChannels" :key="ch.id" class="sim-send-chip" :title="ch.id">
              {{ ch.name }}
              <em>{{ ch.id.slice(-6) }}</em>
            </span>
          </div>
        </div>
        <p v-else class="sim-send-empty">
          {{
            simSendLoadError ||
              "未读到 send 白名单（请确认 telegram/channel_profiles.json 含 send 数组，并重启 collect:ui）"
          }}
        </p>
        <div class="sim-trade-grid">
          <div class="sim-trade-block">
            <span class="sim-block-title">推送平台</span>
            <div class="sim-platform-toggles">
              <label class="sim-platform-card" :class="{ active: tradePlatforms.bitget }">
                <input v-model="tradePlatforms.bitget" type="checkbox" @change="onTradePlatformChange" />
                <span class="sim-platform-name">Bitget</span>
              </label>
              <label class="sim-platform-card" :class="{ active: tradePlatforms.weex }">
                <input v-model="tradePlatforms.weex" type="checkbox" @change="onTradePlatformChange" />
                <span class="sim-platform-name">WEEX</span>
              </label>
            </div>
          </div>
          <div class="sim-trade-block sim-amount-block">
            <span class="sim-block-title">单笔保证金</span>
            <div class="sim-amount-wrap">
              <input
                v-model.number="tradeOrderSizeUsdt"
                class="sim-amount-input"
                type="number"
                min="0.1"
                step="0.1"
                @change="onTradePlatformChange"
              />
              <span class="sim-amount-unit">USDT</span>
            </div>
          </div>
        </div>
        <textarea
          v-model="simContent"
          class="sim-textarea"
          rows="4"
          placeholder="可选：粘贴 Telegram 信号正文做本地模拟…"
          @keydown="onSimKeydown"
        />
        <div class="sim-actions">
          <button type="button" class="sim-link" @click="fillSimExample">填入示例信号</button>
          <button
            type="button"
            class="tg-btn sim-submit"
            :disabled="simLoading || !simContent.trim()"
            @click="submitSimulateSignal"
          >
            {{ simLoading ? "处理中…" : "模拟提交（Enter）" }}
          </button>
        </div>
        <ul v-if="simHints.length" class="sim-hints">
          <li v-for="(h, i) in simHints" :key="i">{{ h }}</li>
        </ul>
        <p v-if="simResult" class="tg-result" :class="{ err: simResultOk === false }">{{ simResult }}</p>
        <div v-if="simHistory.length" class="sim-history">
          <div v-for="(h, i) in simHistory" :key="i" class="sim-hist-row" :class="{ bad: !h.ok }">
            <span class="sim-hist-ts">{{ new Date(h.ts).toLocaleTimeString() }}</span>
            <span>{{ h.skipped || "ok" }}</span>
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
.sim-send-groups {
  margin-bottom: 0.55rem;
}
.sim-send-title {
  display: block;
  font-size: 0.65rem;
  font-weight: 600;
  letter-spacing: 0.04em;
  text-transform: uppercase;
  color: #949ba4;
  margin-bottom: 0.35rem;
}
.sim-send-chips {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.sim-send-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  padding: 0.22rem 0.5rem;
  border-radius: 999px;
  background: linear-gradient(135deg, #2b2d31 0%, #1e1f22 100%);
  border: 1px solid #3f4147;
  font-size: 0.68rem;
  color: #dbdee1;
  line-height: 1.3;
}
.sim-send-chip em {
  font-style: normal;
  font-size: 0.62rem;
  color: #72767d;
}
.sim-send-empty {
  margin: 0 0 0.5rem;
  font-size: 0.68rem;
  color: #faa61a;
}
.sim-trade-grid {
  display: grid;
  grid-template-columns: 1fr minmax(88px, 0.55fr);
  gap: 0.45rem;
  margin-bottom: 0.55rem;
}
@media (max-width: 420px) {
  .sim-trade-grid {
    grid-template-columns: 1fr;
  }
}
.sim-trade-block {
  padding: 0.45rem 0.55rem;
  border-radius: 8px;
  background: #111214;
  border: 1px solid #3f4147;
}
.sim-block-title {
  display: block;
  font-size: 0.62rem;
  font-weight: 600;
  letter-spacing: 0.03em;
  color: #949ba4;
  margin-bottom: 0.35rem;
}
.sim-platform-toggles {
  display: flex;
  gap: 0.35rem;
}
.sim-platform-card {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  gap: 0.3rem;
  padding: 0.35rem 0.4rem;
  border-radius: 6px;
  border: 1px solid #3f4147;
  background: #1a1b1e;
  cursor: pointer;
  transition: border-color 0.15s, background 0.15s, box-shadow 0.15s;
}
.sim-platform-card input {
  position: absolute;
  opacity: 0;
  pointer-events: none;
}
.sim-platform-card.active {
  border-color: #5865f2;
  background: #5865f218;
  box-shadow: inset 0 0 0 1px #5865f244;
}
.sim-platform-name {
  font-size: 0.72rem;
  font-weight: 600;
  color: #b5bac1;
}
.sim-platform-card.active .sim-platform-name {
  color: #eef0ff;
}
.sim-amount-block {
  display: flex;
  flex-direction: column;
  justify-content: flex-start;
}
.sim-amount-wrap {
  display: flex;
  align-items: center;
  gap: 0.35rem;
  margin-top: 0.05rem;
}
.sim-amount-input {
  flex: 1;
  min-width: 0;
  box-sizing: border-box;
  padding: 0.38rem 0.45rem;
  border-radius: 6px;
  border: 1px solid #3f4147;
  background: #1a1b1e;
  color: #fff;
  font-size: 0.82rem;
  font-weight: 600;
  font-variant-numeric: tabular-nums;
}
.sim-amount-input:focus {
  outline: none;
  border-color: #5865f2;
}
.sim-amount-unit {
  font-size: 0.65rem;
  font-weight: 600;
  color: #72767d;
  white-space: nowrap;
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
  margin: 0.45rem 0 0;
  padding: 0.45rem 0.55rem 0.45rem 1.15rem;
  border-radius: 6px;
  background: #111214;
  border: 1px solid #2e3035;
  font-size: 0.65rem;
  color: #949ba4;
  line-height: 1.45;
}
.sim-hints li + li {
  margin-top: 0.2rem;
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
