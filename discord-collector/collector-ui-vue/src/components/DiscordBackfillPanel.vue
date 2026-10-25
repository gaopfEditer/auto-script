<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { dedupeBackfillCards } from "../lib/backfillCardDedup.js";
import { hydrateBackfillCardList } from "../lib/backfillCardTime.js";
import { backfillOutcomeShortLabel, isBackfillKlineMiss } from "../lib/backfillCardQuality.js";
import {
  BACKFILL_PERIOD_OPTIONS,
  backfillCardDigest,
  fetchDiscordBackfillConfig,
  fetchDiscordBackfillHistory,
  fetchDiscordBackfillResults,
  fetchDiscordBackfillStatus,
  loadBackfillCacheLocal,
  loadSelectedChannelIdsLocal,
  rebacktestDiscordBackfill,
  runDiscordBackfill,
  saveBackfillCacheLocal,
  saveSelectedChannelIdsLocal,
  stopDiscordBackfill,
} from "../lib/discordBackfillApi.js";

defineOptions({ name: "DiscordBackfillPanel" });

/** @type {import("vue").Ref<import("../lib/discordBackfillApi.js").BackfillPeriod>} */
const period = ref("week");
const configGroups = ref(
  /** @type {Array<{ channelId: string, name: string, enabled?: boolean, note?: string }>} */ ([]),
);
/** @type {import("vue").Ref<string[]>} */
const selectedChannelIds = ref([]);
const rows = ref(/** @type {Array<Record<string, unknown>>} */ ([]));
const historyRuns = ref(
  /** @type {Array<{ id: string, generatedAt: string, groupCount: number }>} */ ([]),
);
const selectedRunId = ref("");
const generatedAt = ref("");
const fromMs = ref(0);
const toMs = ref(0);
const loading = ref(false);
const running = ref(false);
const cdpReady = ref(true);
const runPeriod = ref("");
const error = ref("");
const note = ref("");
const rebacktestLoading = ref(false);
const rebacktestRunning = ref(false);
const lastRebacktestFinishedAt = ref("");
const pollForRebacktest = ref(false);
const skipBacktestCache = ref(false);
const detailOpen = ref(false);
/** @type {import("vue").Ref<Record<string, unknown> | null>} */
const detailGroup = ref(null);
const cardFilterFrom = ref("");
const cardFilterTo = ref("");

/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null;

const periodLabel = computed(
  () => BACKFILL_PERIOD_OPTIONS.find((o) => o.id === period.value)?.label ?? period.value,
);
const viewingHistory = computed(() => Boolean(selectedRunId.value));
const selectedCount = computed(() => selectedChannelIds.value.length);
const allGroupsSelected = computed(() => {
  const n = configGroups.value.length;
  return n > 0 && selectedChannelIds.value.length === n;
});

/** @param {string} channelId */
function isGroupSelected(channelId) {
  return selectedChannelIds.value.includes(channelId);
}

function syncSelectionFromConfig() {
  const ids = configGroups.value.map((g) => String(g.channelId));
  if (!ids.length) {
    selectedChannelIds.value = [];
    return;
  }
  const saved = loadSelectedChannelIdsLocal();
  if (saved.length) {
    const picked = ids.filter((id) => saved.includes(id));
    for (const id of ids) {
      if (!saved.includes(id)) picked.push(id);
    }
    selectedChannelIds.value = picked;
  } else {
    selectedChannelIds.value = [...ids];
  }
  saveSelectedChannelIdsLocal(selectedChannelIds.value);
}

function selectAllGroups() {
  selectedChannelIds.value = configGroups.value.map((g) => String(g.channelId));
  saveSelectedChannelIdsLocal(selectedChannelIds.value);
}

function selectNoGroups() {
  selectedChannelIds.value = [];
  saveSelectedChannelIdsLocal(selectedChannelIds.value);
}

/** @param {string} channelId @param {Event} e */
function onGroupCheck(channelId, e) {
  const checked = /** @type {HTMLInputElement} */ (e.target).checked;
  const set = new Set(selectedChannelIds.value);
  if (checked) set.add(channelId);
  else set.delete(channelId);
  selectedChannelIds.value = [...set];
  saveSelectedChannelIdsLocal(selectedChannelIds.value);
}

function formatRange() {
  if (!fromMs.value || !toMs.value) return "";
  const f = new Date(fromMs.value).toLocaleDateString("zh-CN");
  const t = new Date(toMs.value).toLocaleDateString("zh-CN");
  return `${f} — ${t}`;
}

function formatRangeFull() {
  if (!fromMs.value || !toMs.value) return "";
  const f = new Date(fromMs.value).toLocaleString("zh-CN", { hour12: false });
  const t = new Date(toMs.value).toLocaleString("zh-CN", { hour12: false });
  return `${f} — ${t}`;
}

function symbolSummary(symbols) {
  if (!symbols || typeof symbols !== "object") return "—";
  const entries = Object.entries(symbols);
  if (!entries.length) return "—";
  return entries
    .slice(0, 5)
    .map(([k, v]) => `${k}×${v}`)
    .join(" · ");
}

function formatHistoryLabel(run) {
  if (!run?.generatedAt) return run?.id || "—";
  const d = new Date(run.generatedAt);
  const t = Number.isNaN(d.getTime()) ? run.generatedAt : d.toLocaleString("zh-CN", { hour12: false });
  return `${t} · ${run.groupCount ?? "?"} 频道`;
}

function formatWinRate(r) {
  const agg = groupStatsFromDeduped(r);
  const w = agg.wins;
  const decided = agg.wins + agg.losses;
  if (!decided) {
    const w0 = r?.winRate;
    if (w0 == null || Number.isNaN(Number(w0))) return "—";
    return `${Math.round(Number(w0) * 100)}% (${r.wins ?? 0}/${decided || "?"})`;
  }
  return `${Math.round((agg.wins / decided) * 100)}% (${agg.wins}/${decided})`;
}

/** @param {Array<Record<string, unknown>>} items */
function sumPnlFromItems(items) {
  let sum = 0;
  let count = 0;
  for (const c of items) {
    const p = Number(c.pnlPct);
    if (Number.isFinite(p)) {
      sum += p;
      count += 1;
    }
  }
  return { sum, count };
}

/** @param {Record<string, unknown>} g */
function cardsForGroup(g) {
  /** 与 Telegram 一致：有 batch 结果时用 backtestItems（含 entered/盈亏）；cards 仅解析元数据 */
  let list;
  if (Array.isArray(g.backtestItems) && g.backtestItems.length) {
    list = g.backtestItems;
  } else if (Array.isArray(g.cards) && g.cards.length) {
    list = g.cards;
  } else {
    list = Array.isArray(g.samples) ? g.samples : [];
  }
  const hydrated = hydrateBackfillCardList(list);
  const cardMeta = Array.isArray(g.cards) ? hydrateBackfillCardList(g.cards) : [];
  if (cardMeta.length && list === g.backtestItems) {
    const metaByDigest = new Map(
      cardMeta.map((c) => [backfillCardDigest(c), c]),
    );
    for (let i = 0; i < hydrated.length; i += 1) {
      const key = backfillCardDigest(hydrated[i]);
      const meta = metaByDigest.get(key);
      if (!meta) continue;
      if (!hydrated[i].signalAt && meta.signalAt) {
        hydrated[i] = { ...hydrated[i], signalAt: meta.signalAt, messageId: meta.messageId ?? hydrated[i].messageId };
      }
    }
  }
  return dedupeBackfillCards(hydrated).filter((c) => !c.backtestInvalid);
}

/** @param {Record<string, unknown>} r */
function groupStatsFromDeduped(r) {
  const list = cardsForGroup(r);
  let wins = 0;
  let losses = 0;
  for (const c of list) {
    if (isBackfillKlineMiss(c) || c.backtestInvalid) continue;
    if (!c.entered || c.skipped) continue;
    const p = Number(c.pnlPct);
    if (Number.isFinite(p) && p > 0) wins += 1;
    else if (Number.isFinite(p) && p < 0) losses += 1;
    else if (c.outcome === "take_profit") wins += 1;
    else if (c.outcome === "stop_loss") losses += 1;
  }
  return { wins, losses, list };
}

/** @param {Record<string, unknown>} r */
function groupPnlAggregate(r) {
  const cached = Number(r.totalPnlPct);
  const cachedN = Number(r.pnlSummedCount);
  const deduped = cardsForGroup(r);
  const fromDedup = sumPnlFromItems(deduped.filter((c) => c.entered && !c.skipped));
  if (fromDedup.count > 0) return fromDedup;
  if (Number.isFinite(cached) && cachedN > 0) {
    return { sum: cached, count: cachedN };
  }
  return { sum: 0, count: 0 };
}

/** @param {Record<string, unknown>} r */
function formatTotalPnl(r) {
  const { sum, count } = groupPnlAggregate(r);
  if (!count) return "—";
  const sign = sum >= 0 ? "+" : "";
  return `${sign}${sum.toFixed(2)}%`;
}

/** @param {Record<string, unknown>} r */
function dedupedSignalCount(r) {
  return cardsForGroup(r).length;
}

const tableGrandTotal = computed(() => {
  let sum = 0;
  let count = 0;
  for (const r of rows.value) {
    const { sum: s, count: n } = groupPnlAggregate(r);
    sum += s;
    count += n;
  }
  return { sum, count };
});

function formatPnl(c) {
  if (c?.pnlLabel) return String(c.pnlLabel);
  const p = Number(c?.pnlPct);
  if (Number.isFinite(p)) return `${p >= 0 ? "+" : ""}${p.toFixed(2)}%`;
  return "—";
}

/** @param {number} ms */
function msToDatetimeLocal(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  d.setMinutes(d.getMinutes() - d.getTimezoneOffset());
  return d.toISOString().slice(0, 16);
}

/** @param {string} v */
function datetimeLocalToMs(v) {
  if (!v) return 0;
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : 0;
}

/** @param {Record<string, unknown>} g */
function openDetail(g) {
  detailGroup.value = g;
  cardFilterFrom.value = msToDatetimeLocal(fromMs.value);
  cardFilterTo.value = msToDatetimeLocal(toMs.value);
  detailOpen.value = true;
}

function closeDetail() {
  detailOpen.value = false;
  detailGroup.value = null;
}

const filteredDetailCards = computed(() => {
  const g = detailGroup.value;
  if (!g) return [];
  const from = datetimeLocalToMs(cardFilterFrom.value) || fromMs.value;
  const to = datetimeLocalToMs(cardFilterTo.value) || toMs.value;
  const filtered = cardsForGroup(g).filter((c) => {
    const t = Date.parse(String(c.signalAt ?? c.at ?? ""));
    if (!Number.isFinite(t)) return true;
    if (from && t < from) return false;
    if (to && t > to) return false;
    return true;
  });
  return filtered.sort((a, b) => {
    const ta = Date.parse(String(a.signalAt ?? a.at ?? ""));
    const tb = Date.parse(String(b.signalAt ?? b.at ?? ""));
    if (!Number.isFinite(ta) && !Number.isFinite(tb)) return 0;
    if (!Number.isFinite(ta)) return 1;
    if (!Number.isFinite(tb)) return -1;
    return tb - ta;
  });
});

const detailSummary = computed(() => {
  const list = filteredDetailCards.value;
  let wins = 0;
  let losses = 0;
  let errors = 0;
  let klineMiss = 0;
  for (const c of list) {
    const p = Number(c.pnlPct);
    if (isBackfillKlineMiss(c)) {
      klineMiss += 1;
      continue;
    }
    if (c.backtestInvalid || (c.error && !c.entered && !c.skipped)) errors += 1;
    else if (!c.entered || c.skipped) continue;
    else if (Number.isFinite(p) && p > 0) wins += 1;
    else if (Number.isFinite(p) && p < 0) losses += 1;
    else if (c.outcome === "take_profit") wins += 1;
    else if (c.outcome === "stop_loss") losses += 1;
  }
  const decided = wins + losses;
  const { sum: totalPnl, count: pnlN } = sumPnlFromItems(list);
  return {
    total: list.length,
    wins,
    losses,
    errors,
    klineMiss,
    winRate: decided ? wins / decided : null,
    totalPnl,
    pnlN,
  };
});

function formatSignalTime(c) {
  const raw = String(c.signalAt ?? c.at ?? "");
  if (!raw) return "—";
  const d = new Date(raw);
  return Number.isNaN(d.getTime()) ? raw : d.toLocaleString("zh-CN", { hour12: false });
}

function outcomeLabel(c) {
  return backfillOutcomeShortLabel(c);
}

/** @param {Record<string, unknown>} c */
function outcomeCellClass(c) {
  if (c.outcome === "take_profit") return "ok";
  if (c.outcome === "stop_loss") return "err";
  if (isBackfillKlineMiss(c)) return "muted";
  if (c.backtestInvalid || (c.error && !c.entered && !c.skipped)) return "warn";
  return "";
}

async function loadConfig() {
  try {
    const cfg = await fetchDiscordBackfillConfig();
    configGroups.value = (cfg.groups ?? []).filter((g) => g.enabled !== false);
    syncSelectionFromConfig();
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  }
}

async function loadHistoryList() {
  try {
    const data = await fetchDiscordBackfillHistory(period.value);
    historyRuns.value = Array.isArray(data.runs) ? data.runs : [];
  } catch {
    historyRuns.value = [];
  }
}

async function loadResults() {
  loading.value = true;
  if (!rebacktestRunning.value) error.value = "";
  const runId = selectedRunId.value || null;
  try {
    const data = await fetchDiscordBackfillResults(period.value, runId);
    if (data.cached && Array.isArray(data.groups)) {
      applyPayload(data);
      if (!runId) saveBackfillCacheLocal(period.value, data);
    } else if (!runId) {
      const local = loadBackfillCacheLocal(period.value);
      if (local && Array.isArray(local.groups)) {
        applyPayload(local);
        note.value = "暂无服务端缓存，已显示本机上次结果";
      } else {
        rows.value = [];
        generatedAt.value = "";
        note.value = "尚未拉取，选择周期后点「开始获取数据」，再点「批量回溯盈亏」";
      }
    } else {
      rows.value = [];
      note.value = "该历史记录不存在或已删除";
    }
  } catch (e) {
    if (!runId) {
      const local = loadBackfillCacheLocal(period.value);
      if (local?.groups) {
        applyPayload(local);
        note.value = "API 不可用，已读浏览器缓存";
      } else {
        error.value = String(/** @type {Error} */ (e).message ?? e);
      }
    } else {
      error.value = String(/** @type {Error} */ (e).message ?? e);
    }
  } finally {
    loading.value = false;
  }
}

/** @param {Record<string, unknown>} data */
function applyPayload(data) {
  const list = Array.isArray(data.groups) ? data.groups : [];
  rows.value = [...list].sort(
    (a, b) =>
      dedupedSignalCount(b) - dedupedSignalCount(a) ||
      Number(b.tradeLikeCount ?? 0) - Number(a.tradeLikeCount ?? 0),
  );
  generatedAt.value = String(data.generatedAt ?? "");
  fromMs.value = Number(data.fromMs) || 0;
  toMs.value = Number(data.toMs) || 0;
  if (!note.value) note.value = "";
}

/** @param {Record<string, unknown> | null | undefined} lastRun */
function applyLastRunFailure(lastRun) {
  if (!lastRun || lastRun.ok === true) return;
  if (String(lastRun.period ?? "") !== period.value) return;
  if (rows.value.length > 0) return;
  error.value = String(lastRun.failHint || `回溯失败（退出码 ${lastRun.exitCode ?? "?"}）`);
  const tail = String(lastRun.stderrTail ?? "").trim();
  if (tail) note.value = tail.split("\n").filter(Boolean).slice(-6).join("\n");
}

/** @param {Record<string, unknown> | null | undefined} rb */
function applyRebacktestStatus(rb) {
  if (!rb || typeof rb !== "object") return;
  const active = Boolean(rb.running);
  rebacktestRunning.value = active;
  if (active) {
    rebacktestLoading.value = true;
    const p = rb.progress && typeof rb.progress === "object" ? rb.progress : null;
    if (p) {
      note.value = `批量盈亏进行中：频道 ${p.groupIndex}/${p.groupTotal} ${String(p.groupName ?? "")}`;
    }
    return;
  }
  rebacktestLoading.value = false;
  pollForRebacktest.value = false;
  if (String(rb.period ?? "") !== period.value) return;
  if (rb.error && rb.finishedAt) {
    error.value = String(rb.error);
    return;
  }
  const doneAt = String(rb.finishedAt ?? "");
  if (doneAt && doneAt !== lastRebacktestFinishedAt.value) {
    lastRebacktestFinishedAt.value = doneAt;
    void loadResults().then(() => {
      note.value = skipBacktestCache.value
        ? "后台 batch 盈亏已完成（已忽略 digest 缓存）"
        : "后台 batch 盈亏已完成";
      if (detailGroup.value) {
        const id = String(detailGroup.value.channelId ?? "");
        const updated = rows.value.find((r) => String(r.channelId) === id);
        if (updated) detailGroup.value = updated;
      }
    });
  }
}

async function refreshStatus() {
  try {
    const st = await fetchDiscordBackfillStatus();
    running.value = Boolean(st.running);
    cdpReady.value = st.cdpScrollReady !== false;
    if (st.running && st.period) runPeriod.value = String(st.period);
    applyRebacktestStatus(
      st.rebacktest && typeof st.rebacktest === "object"
        ? /** @type {Record<string, unknown>} */ (st.rebacktest)
        : null,
    );
    if (rebacktestRunning.value) {
      await loadResults();
    }
    if (!st.running && !rebacktestRunning.value && pollTimer) {
      if (!pollForRebacktest.value) {
        runPeriod.value = "";
        clearInterval(pollTimer);
        pollTimer = null;
        await loadHistoryList();
        if (!selectedRunId.value) {
          await loadResults();
          if (!error.value && rows.value.length) {
            note.value = "拉取/解析完成；请点「批量回溯盈亏」计算胜率与合计盈亏";
          }
        }
        applyLastRunFailure(st.lastRun);
      } else {
        clearInterval(pollTimer);
        pollTimer = null;
        pollForRebacktest.value = false;
      }
    }
  } catch {
    /* ignore */
  }
}

async function onRebacktest() {
  rebacktestLoading.value = true;
  error.value = "";
  try {
    const data = await rebacktestDiscordBackfill(period.value, selectedRunId.value || null, {
      skipCache: skipBacktestCache.value,
    });
    if (data.async) {
      rebacktestRunning.value = true;
      rebacktestLoading.value = true;
      pollForRebacktest.value = true;
      note.value = "批量盈亏在后台运行；请勿重复点击";
      if (!pollTimer) {
        pollTimer = setInterval(() => void refreshStatus(), 2500);
      }
      return;
    }
    await loadResults();
    note.value = "已重新跑 batch 盈亏回溯";
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    rebacktestLoading.value = false;
  }
}

async function onRun() {
  error.value = "";
  note.value = "";
  selectedRunId.value = "";
  if (!selectedChannelIds.value.length) {
    error.value = "请至少勾选一个频道";
    return;
  }
  if (!cdpReady.value) {
    error.value = "CDP 未就绪：请配置 CDP_CONNECT_URL 并保持 Chrome 内 Discord 已登录";
    return;
  }
  try {
    await runDiscordBackfill(period.value, selectedChannelIds.value);
    running.value = true;
    runPeriod.value = period.value;
    if (!pollTimer) pollTimer = setInterval(() => void refreshStatus(), 2800);
    note.value = `CDP 拉取并解析 ${selectedChannelIds.value.length} 个频道 ·「${periodLabel.value}」；完成后请点「批量回溯盈亏」`;
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  }
}

async function onStop() {
  error.value = "";
  try {
    await stopDiscordBackfill();
    note.value = "已请求停止（当前频道处理完后结束）";
    await refreshStatus();
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  }
}

function selectLatest() {
  selectedRunId.value = "";
  void loadResults();
}

/** @param {string} id */
function selectHistoryRun(id) {
  selectedRunId.value = id;
  void loadResults();
}

watch(period, () => {
  selectedRunId.value = "";
  void loadHistoryList();
  void loadResults();
});

onMounted(() => {
  void loadConfig();
  void loadHistoryList();
  void loadResults();
  void refreshStatus().then(() => {
    if ((running.value || rebacktestRunning.value) && !pollTimer) {
      pollTimer = setInterval(() => void refreshStatus(), 2800);
    } else if (!running.value && !rebacktestRunning.value) {
      void fetchDiscordBackfillStatus()
        .then((s) => applyLastRunFailure(s.lastRun))
        .catch(() => {});
    }
  });
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div class="manual-stats dc-backfill-page">
    <header class="head">
      <div>
        <h1>Discord 回测</h1>
        <p>
          频道见 <code>data/discord_groups.json</code> 的 <code>backfillChannels</code>；CDP 上滚拉历史、
          <code>parseSignalText</code> 解析信号。「开始获取数据」只拉消息/解析；盈亏请点「批量回溯盈亏」（与 Telegram 回溯一致，展示会去重）。
        </p>
      </div>
    </header>

    <section class="panel">
      <div class="list-head">
        <h2>回溯控制</h2>
        <div class="filters control-row">
          <div class="period-tabs" role="tablist" aria-label="回溯周期">
            <button
              v-for="opt in BACKFILL_PERIOD_OPTIONS"
              :key="opt.id"
              type="button"
              class="btn tiny"
              :class="{ primary: period === opt.id }"
              :disabled="running"
              @click="period = opt.id"
            >
              {{ opt.label }}
            </button>
          </div>
          <button type="button" class="btn" :disabled="loading || running" @click="loadResults">
            {{ loading ? "加载…" : "刷新结果" }}
          </button>
          <button
            type="button"
            class="btn"
            :disabled="rebacktestLoading || rebacktestRunning || running || !rows.length"
            @click="onRebacktest"
          >
            {{ rebacktestLoading ? "回溯盈亏…" : "批量回溯盈亏" }}
          </button>
          <button
            type="button"
            class="btn primary"
            :disabled="running || rebacktestRunning || !selectedCount"
            @click="onRun"
          >
            开始获取数据（{{ selectedCount }}）
          </button>
          <button type="button" class="btn danger" :disabled="!running" @click="onStop">停止</button>
        </div>
        <div class="control-flags">
          <label class="flag-check" title="批量回溯盈亏时不用磁盘 digest 缓存">
            <input v-model="skipBacktestCache" type="checkbox" :disabled="rebacktestLoading" />
            盈亏重算忽略缓存
          </label>
        </div>
      </div>

      <p v-if="!cdpReady" class="warn tiny">CDP 未连接 — 需 <code>CDP_CONNECT_URL</code> 与 Discord 登录态</p>
      <p v-if="running" class="run-banner">
        正在 CDP 拉取并解析
        <template v-if="runPeriod">
          · {{ BACKFILL_PERIOD_OPTIONS.find((o) => o.id === runPeriod)?.label ?? runPeriod }}
        </template>
      </p>

      <div v-if="configGroups.length" class="group-pick">
        <div class="group-pick-head">
          <span class="group-pick-title">选择频道</span>
          <span class="muted tiny">{{ selectedCount }} / {{ configGroups.length }}</span>
          <button type="button" class="btn tiny" :disabled="running || allGroupsSelected" @click="selectAllGroups">
            全选
          </button>
          <button type="button" class="btn tiny" :disabled="running || !selectedCount" @click="selectNoGroups">
            清空
          </button>
        </div>
        <div class="group-grid" role="group" aria-label="Discord 频道多选">
          <label
            v-for="g in configGroups"
            :key="g.channelId"
            class="group-chip"
            :class="{ on: isGroupSelected(g.channelId), off: !isGroupSelected(g.channelId) }"
          >
            <input
              type="checkbox"
              class="group-chip-input"
              :checked="isGroupSelected(g.channelId)"
              :disabled="running"
              @change="onGroupCheck(g.channelId, $event)"
            />
            <span class="group-chip-name">{{ g.name || "频道" }}</span>
          </label>
        </div>
      </div>
      <p v-else class="summary muted">未配置频道：请编辑 data/discord_groups.json → backfillChannels</p>

      <p v-if="formatRangeFull()" class="range-banner">
        回溯时间窗口 · {{ periodLabel }} · {{ formatRangeFull() }}
      </p>

      <p class="summary muted">
        {{ periodLabel }}
        <template v-if="formatRange()"> · {{ formatRange() }}</template>
        · 配置频道 {{ configGroups.length }} 个
        <template v-if="viewingHistory"> · 查看历史快照</template>
        <template v-else-if="generatedAt">
          · 最新生成 {{ new Date(generatedAt).toLocaleString("zh-CN") }}
        </template>
      </p>
      <p v-if="note" class="tiny" :class="error ? 'run-fail-detail' : 'ok'">{{ note }}</p>
      <p v-if="error" class="err">{{ error }}</p>

      <div v-if="historyRuns.length" class="history-bar">
        <span class="history-label">历史记录</span>
        <button type="button" class="hist-chip" :class="{ on: !selectedRunId }" @click="selectLatest">
          最新缓存
        </button>
        <button
          v-for="h in historyRuns.slice(0, 10)"
          :key="h.id"
          type="button"
          class="hist-chip"
          :class="{ on: selectedRunId === h.id }"
          @click="selectHistoryRun(h.id)"
        >
          {{ formatHistoryLabel(h) }}
        </button>
      </div>

      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>频道</th>
              <th>上滚</th>
              <th>消息</th>
              <th>信号(去重)</th>
              <th>盈亏回溯</th>
              <th>胜率</th>
              <th>合计盈亏</th>
              <th>热门币</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="String(r.channelId)">
              <td>{{ r.name || "—" }}</td>
              <td>{{ r.scrollPages ?? "—" }}</td>
              <td>{{ r.messageCount ?? "—" }}</td>
              <td>{{ dedupedSignalCount(r) }}</td>
              <td>{{ r.backtestsRun ?? "—" }}</td>
              <td class="tiny">{{ formatWinRate(r) }}</td>
              <td
                class="tiny mono pnl-total"
                :class="{ ok: groupPnlAggregate(r).sum > 0, err: groupPnlAggregate(r).sum < 0 }"
              >
                {{ formatTotalPnl(r) }}
                <span v-if="groupPnlAggregate(r).count" class="muted">
                  · {{ groupPnlAggregate(r).count }}张
                </span>
              </td>
              <td class="tiny">{{ symbolSummary(r.symbols) }}</td>
              <td>
                <button type="button" class="btn tiny" @click="openDetail(r)">卡片</button>
              </td>
            </tr>
            <tr v-if="!loading && !rows.length">
              <td colspan="9" class="empty">暂无结果 — 选周期后点「开始获取数据」，再点「批量回溯盈亏」</td>
            </tr>
            <tr v-if="rows.length && tableGrandTotal.count" class="table-total-row">
              <td colspan="6">全表合计</td>
              <td class="tiny">—</td>
              <td
                class="tiny mono"
                :class="{ ok: tableGrandTotal.sum > 0, err: tableGrandTotal.sum < 0 }"
              >
                {{ tableGrandTotal.sum >= 0 ? "+" : "" }}{{ tableGrandTotal.sum.toFixed(2) }}%
                <span class="muted"> · {{ tableGrandTotal.count }}张</span>
              </td>
              <td colspan="2"></td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>

    <div v-if="detailOpen && detailGroup" class="modal-backdrop" @click.self="closeDetail">
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="dc-card-modal-title">
        <header class="modal-head">
          <div>
            <h3 id="dc-card-modal-title">{{ detailGroup.name }} · 回溯卡片</h3>
            <p class="modal-sub">
              周期 {{ periodLabel }}
              <template v-if="formatRangeFull()"> · {{ formatRangeFull() }}</template>
            </p>
          </div>
          <button type="button" class="btn tiny" @click="closeDetail">关闭</button>
        </header>

        <div class="modal-filters">
          <label class="filter-field">
            <span>信号自</span>
            <input v-model="cardFilterFrom" type="datetime-local" class="dt-input" />
          </label>
          <label class="filter-field">
            <span>信号至</span>
            <input v-model="cardFilterTo" type="datetime-local" class="dt-input" />
          </label>
          <button
            type="button"
            class="btn tiny"
            @click="
              cardFilterFrom = msToDatetimeLocal(fromMs);
              cardFilterTo = msToDatetimeLocal(toMs);
            "
          >
            重置为回溯窗口
          </button>
        </div>

        <p class="modal-summary">
          筛选后 {{ detailSummary.total }} 张（已去重）
          <template v-if="detailSummary.winRate != null">
            · 胜率 {{ Math.round(detailSummary.winRate * 100) }}%
            （{{ detailSummary.wins }}/{{ detailSummary.wins + detailSummary.losses }}）
          </template>
          <template v-if="detailSummary.klineMiss"> · K线暂缺 {{ detailSummary.klineMiss }}</template>
          <template v-if="detailSummary.pnlN">
            · 合计盈亏
            {{ detailSummary.totalPnl >= 0 ? "+" : "" }}{{ detailSummary.totalPnl.toFixed(2) }}%
          </template>
          <span v-if="!detailGroup.backtestsRun && cardsForGroup(detailGroup).length" class="muted">
            · 尚未 batch 盈亏，可点「批量回溯盈亏」
          </span>
          <span class="muted tiny"> · 同币/方向/阶段 20 分钟内仅保留最早一条</span>
        </p>

        <div class="modal-table-wrap">
          <table class="modal-table">
            <thead>
              <tr>
                <th>时间</th>
                <th>币</th>
                <th>方向</th>
                <th>阶段</th>
                <th>盈亏率</th>
                <th>结果</th>
                <th>摘要</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="(c, i) in filteredDetailCards" :key="backfillCardDigest(c) + i">
                <td class="tiny">{{ formatSignalTime(c) }}</td>
                <td>{{ c.symbol || "—" }}</td>
                <td>{{ c.direction ?? "—" }}</td>
                <td class="tiny">{{ c.phase ?? "—" }}</td>
                <td :class="{ ok: Number(c.pnlPct) > 0, err: Number(c.pnlPct) < 0 }">
                  {{ formatPnl(c) }}
                </td>
                <td :class="outcomeCellClass(c)">{{ outcomeLabel(c) }}</td>
                <td class="preview-cell tiny">{{ c.preview || "—" }}</td>
              </tr>
              <tr v-if="!filteredDetailCards.length">
                <td colspan="7" class="empty">该时间范围内无卡片</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.dc-backfill-page {
  max-width: 1100px;
  margin: 0 auto;
  padding: 0.5rem 1.5rem 3rem;
  color: #dbdee1;
}
.head {
  margin-bottom: 1rem;
}
h1 {
  margin: 0 0 0.35rem;
  font-size: 1.35rem;
  color: #f2f3f5;
}
h2 {
  margin: 0;
  font-size: 1.05rem;
  color: #f2f3f5;
}
p {
  margin: 0;
  color: #949ba4;
  line-height: 1.5;
  font-size: 0.9rem;
}
code {
  font-size: 0.82em;
  color: #dbdee1;
  background: #1e1f22;
  padding: 0.1rem 0.35rem;
  border-radius: 4px;
}
.panel {
  background: #2b2d31;
  border-radius: 12px;
  padding: 1.15rem 1.25rem;
}
.list-head {
  display: flex;
  flex-wrap: wrap;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
}
.filters {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.45rem;
}
.period-tabs {
  display: inline-flex;
  flex-wrap: wrap;
  gap: 0.35rem;
}
.btn {
  border: 1px solid #404249;
  background: #25262b;
  color: #e3e5e8;
  border-radius: 8px;
  padding: 0.45rem 0.9rem;
  min-height: 2.05rem;
  font-weight: 600;
  cursor: pointer;
  font-size: 0.84rem;
}
.btn:hover:not(:disabled) {
  border-color: #5865f2;
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
.btn.tiny {
  padding: 0.28rem 0.55rem;
  min-height: 1.85rem;
  font-size: 0.78rem;
}
.btn.danger {
  border-color: #ed4245;
  color: #ed4245;
}
.control-flags {
  display: flex;
  flex-wrap: wrap;
  gap: 1rem;
  margin-top: 0.55rem;
  font-size: 0.78rem;
  color: #b5bac1;
}
.flag-check {
  display: inline-flex;
  align-items: center;
  gap: 0.35rem;
  cursor: pointer;
}
.flag-check input {
  accent-color: #5865f2;
}
.run-banner {
  margin-top: 0.65rem;
  padding: 0.45rem 0.65rem;
  border-radius: 8px;
  background: rgba(88, 101, 242, 0.15);
  color: #e3e5e8;
  font-size: 0.85rem;
}
.warn {
  color: #faa61a;
  margin-top: 0.45rem;
}
.summary {
  margin: 0.65rem 0 0.5rem;
  font-size: 0.85rem;
}
.muted {
  color: #949ba4;
}
.tiny {
  font-size: 0.72rem;
}
.mono {
  font-family: ui-monospace, monospace;
}
.err {
  color: #ed4245;
}
.ok {
  color: #3ba55d;
}
.run-fail-detail {
  margin-top: 0.35rem;
  color: #b5bac1;
  white-space: pre-wrap;
  font-family: ui-monospace, monospace;
  font-size: 0.68rem;
}
.group-pick {
  margin: 0.75rem 0;
  padding: 0.65rem 0.75rem;
  border-radius: 8px;
  background: #1e1f22;
  border: 1px solid #35373c;
}
.group-pick-head {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.45rem;
  margin-bottom: 0.55rem;
}
.group-pick-title {
  font-size: 0.85rem;
  font-weight: 600;
  color: #e3e5e8;
}
.group-grid {
  display: flex;
  flex-wrap: wrap;
  gap: 0.45rem;
}
.group-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  padding: 0.38rem 0.65rem;
  border-radius: 999px;
  border: 1px solid #404249;
  background: #25262b;
  cursor: pointer;
  font-size: 0.82rem;
}
.group-chip.on {
  border-color: #5865f2;
  background: rgba(88, 101, 242, 0.18);
}
.group-chip.off {
  opacity: 0.62;
}
.group-chip-input {
  accent-color: #5865f2;
}
.range-banner {
  margin: 0.55rem 0 0;
  padding: 0.45rem 0.65rem;
  border-radius: 8px;
  background: #1e1f22;
  border: 1px solid #35373c;
  font-size: 0.78rem;
  color: #dbdee1;
}
.history-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.35rem;
  margin: 0.5rem 0 0.85rem;
  padding: 0.55rem 0.65rem;
  border-radius: 8px;
  background: #1e1f22;
}
.history-label {
  font-size: 0.72rem;
  font-weight: 700;
  color: #7c8490;
  margin-right: 0.25rem;
}
.hist-chip {
  border: 1px solid #404249;
  background: #25262b;
  color: #b5bac1;
  border-radius: 999px;
  padding: 0.2rem 0.55rem;
  font-size: 0.72rem;
  cursor: pointer;
}
.hist-chip.on {
  border-color: #5865f2;
  color: #fff;
  background: #5865f2;
}
.table-wrap {
  overflow-x: auto;
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.85rem;
}
th,
td {
  text-align: left;
  padding: 0.45rem 0.35rem;
  vertical-align: middle;
}
th {
  color: #949ba4;
  font-weight: 600;
  background: #1e1f22;
}
.empty {
  text-align: center;
  color: #949ba4;
  padding: 1.5rem !important;
}
.table-total-row td {
  font-weight: 700;
  border-top: 1px solid #52565e;
  background: #25262b;
}
.pnl-total .muted {
  font-weight: 400;
}
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1200;
  background: rgba(0, 0, 0, 0.62);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}
.modal {
  width: min(920px, 100%);
  max-height: min(88vh, 900px);
  overflow: hidden;
  display: flex;
  flex-direction: column;
  background: #2b2d31;
  border: 1px solid #404249;
  border-radius: 12px;
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 0.75rem;
  padding: 1rem 1.1rem 0.65rem;
  border-bottom: 1px solid #35373c;
}
.modal-head h3 {
  margin: 0 0 0.25rem;
  font-size: 1.05rem;
  color: #f2f3f5;
}
.modal-sub {
  margin: 0;
  font-size: 0.72rem;
  color: #949ba4;
}
.modal-filters {
  display: flex;
  flex-wrap: wrap;
  gap: 0.55rem;
  align-items: flex-end;
  padding: 0.65rem 1.1rem;
  border-bottom: 1px solid #35373c;
}
.filter-field {
  display: flex;
  flex-direction: column;
  gap: 0.2rem;
  font-size: 0.68rem;
  color: #949ba4;
}
.dt-input {
  background: #1e1f22;
  border: 1px solid #404249;
  border-radius: 6px;
  color: #e3e5e8;
  padding: 0.35rem 0.5rem;
  font-size: 0.78rem;
}
.modal-summary {
  margin: 0;
  padding: 0.55rem 1.1rem;
  font-size: 0.78rem;
  color: #b5bac1;
  border-bottom: 1px solid #35373c;
}
.modal-table-wrap {
  overflow: auto;
  flex: 1;
  padding: 0.5rem 1.1rem 1rem;
}
.modal-table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.76rem;
}
.modal-table th,
.modal-table td {
  padding: 0.38rem 0.4rem;
  border-bottom: 1px solid #35373c;
  text-align: left;
  vertical-align: top;
}
.preview-cell {
  max-width: 220px;
  word-break: break-word;
  color: #949ba4;
}
</style>
