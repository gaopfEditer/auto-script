<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import {
  BACKFILL_PERIOD_OPTIONS,
  fetchTelegramBackfillConfig,
  fetchTelegramBackfillHistory,
  fetchTelegramBackfillResults,
  fetchTelegramBackfillStatus,
  loadBackfillCacheLocal,
  loadSelectedChatIdsLocal,
  runTelegramBackfill,
  saveBackfillCacheLocal,
  saveSelectedChatIdsLocal,
  rebacktestTelegramBackfill,
  stopTelegramBackfill,
  backfillCardDigest,
  mutateMarketEntryOverrides,
} from "../lib/telegramBackfillApi.js";
import { dedupeBackfillCards } from "../lib/backfillCardDedup.js";
import { backfillOutcomeShortLabel, isBackfillKlineMiss } from "../lib/backfillCardQuality.js";

defineOptions({ name: "TelegramBackfillPanel" });

/** @type {import("vue").Ref<import("../lib/telegramBackfillApi.js").BackfillPeriod>} */
const period = ref("week");
const configGroups = ref(
  /** @type {Array<{ chatId: string, name: string, enabled?: boolean, note?: string }>} */ ([]),
);
/** @type {import("vue").Ref<string[]>} */
const selectedChatIds = ref([]);
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
const runPeriod = ref("");
const error = ref("");
const note = ref("");
const rebacktestLoading = ref(false);
const rebacktestRunning = ref(false);
const lastRebacktestFinishedAt = ref("");
/** 轮询仅用于 TG 拉取 vs batch 盈亏 */
const pollForRebacktest = ref(false);
const detailOpen = ref(false);
/** @type {import("vue").Ref<Record<string, unknown> | null>} */
const detailGroup = ref(null);
const cardFilterFrom = ref("");
const cardFilterTo = ref("");
/** @type {import("vue").Ref<Set<string>>} */
const cardPick = ref(new Set());
const marketEntryLoading = ref(false);
/** 全量重拉 + 重放（忽略 messages_db 覆盖区间） */
const forceFullScan = ref(false);
/** 批量回溯盈亏时忽略 digest 磁盘缓存 */
const skipBacktestCache = ref(false);
/** @type {import("vue").Ref<Record<string, number> | null>} */
const incrementalTotals = ref(null);

/** @type {ReturnType<typeof setInterval> | null} */
let pollTimer = null;

const periodLabel = computed(
  () => BACKFILL_PERIOD_OPTIONS.find((o) => o.id === period.value)?.label ?? period.value,
);

const viewingHistory = computed(() => Boolean(selectedRunId.value));

const selectedCount = computed(() => selectedChatIds.value.length);

const allGroupsSelected = computed(() => {
  const n = configGroups.value.length;
  return n > 0 && selectedChatIds.value.length === n;
});

/** @param {string} chatId */
function isGroupSelected(chatId) {
  return selectedChatIds.value.includes(chatId);
}

function syncSelectionFromConfig() {
  const ids = configGroups.value.map((g) => String(g.chatId));
  if (!ids.length) {
    selectedChatIds.value = [];
    return;
  }
  const saved = loadSelectedChatIdsLocal();
  if (saved.length) {
    const picked = ids.filter((id) => saved.includes(id));
    for (const id of ids) {
      if (!saved.includes(id)) picked.push(id);
    }
    selectedChatIds.value = picked;
  } else {
    selectedChatIds.value = [...ids];
  }
  saveSelectedChatIdsLocal(selectedChatIds.value);
}

function selectAllGroups() {
  selectedChatIds.value = configGroups.value.map((g) => String(g.chatId));
  saveSelectedChatIdsLocal(selectedChatIds.value);
}

function selectNoGroups() {
  selectedChatIds.value = [];
  saveSelectedChatIdsLocal(selectedChatIds.value);
}

/** @param {string} chatId @param {Event} e */
function onGroupCheck(chatId, e) {
  const checked = /** @type {HTMLInputElement} */ (e.target).checked;
  const set = new Set(selectedChatIds.value);
  if (checked) set.add(chatId);
  else set.delete(chatId);
  selectedChatIds.value = [...set];
  saveSelectedChatIdsLocal(selectedChatIds.value);
}

function formatRange() {
  if (!fromMs.value || !toMs.value) return "";
  const f = new Date(fromMs.value).toLocaleDateString("zh-CN");
  const t = new Date(toMs.value).toLocaleDateString("zh-CN");
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
  return `${t} · ${run.groupCount ?? "?"} 群`;
}

function formatWinRate(r) {
  const w = r?.winRate;
  if (w == null || Number.isNaN(Number(w))) return "—";
  const decided = (Number(r.wins) || 0) + (Number(r.losses) || 0);
  return `${Math.round(Number(w) * 100)}% (${r.wins ?? 0}/${decided || "?"})`;
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

/** @param {Record<string, unknown>} r */
function groupPnlAggregate(r) {
  const cached = Number(r.totalPnlPct);
  const cachedN = Number(r.pnlSummedCount);
  if (Number.isFinite(cached) && cachedN > 0) {
    return { sum: cached, count: cachedN };
  }
  return sumPnlFromItems(cardsForGroup(r));
}

/** @param {Record<string, unknown>} r */
function formatTotalPnl(r) {
  const { sum, count } = groupPnlAggregate(r);
  if (!count) return "—";
  const sign = sum >= 0 ? "+" : "";
  return `${sign}${sum.toFixed(2)}%`;
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

function formatRangeFull() {
  if (!fromMs.value || !toMs.value) return "";
  const f = new Date(fromMs.value).toLocaleString("zh-CN", { hour12: false });
  const t = new Date(toMs.value).toLocaleString("zh-CN", { hour12: false });
  return `${f} — ${t}`;
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
function cardsForGroup(g) {
  let list;
  if (Array.isArray(g.backtestItems) && g.backtestItems.length) {
    list = g.backtestItems;
  } else {
    const raw = Array.isArray(g.cards)
      ? g.cards
      : Array.isArray(g.samples)
        ? g.samples
        : [];
    list = raw.map((c) => ({
      ...c,
      signalAt: c.signalAt ?? c.at,
    }));
  }
  return dedupeBackfillCards(list).filter((c) => !c.backtestInvalid);
}

/** @param {Record<string, unknown>} g */
function openDetail(g) {
  detailGroup.value = g;
  cardFilterFrom.value = msToDatetimeLocal(fromMs.value);
  cardFilterTo.value = msToDatetimeLocal(toMs.value);
  cardPick.value = new Set();
  detailOpen.value = true;
}

function closeDetail() {
  detailOpen.value = false;
  detailGroup.value = null;
  cardPick.value = new Set();
}

/** @param {Record<string, unknown>} c */
function isCardNotEntered(c) {
  return !c.entered && !c.marketEntryOverride;
}

/** @param {Record<string, unknown>} c */
function isCardOverridden(c) {
  return Boolean(c.marketEntryOverride);
}

/** @param {string} digest @param {Event} e */
function onCardPick(digest, e) {
  const checked = /** @type {HTMLInputElement} */ (e.target).checked;
  const set = new Set(cardPick.value);
  if (checked) set.add(digest);
  else set.delete(digest);
  cardPick.value = set;
}

function selectAllNotEnteredInFilter() {
  const set = new Set(cardPick.value);
  for (const c of filteredDetailCards.value) {
    if (isCardNotEntered(c)) set.add(backfillCardDigest(c));
  }
  cardPick.value = set;
}

function selectAllOverriddenInFilter() {
  const set = new Set(cardPick.value);
  for (const c of filteredDetailCards.value) {
    if (isCardOverridden(c)) set.add(backfillCardDigest(c));
  }
  cardPick.value = set;
}

function clearCardPick() {
  cardPick.value = new Set();
}

/** @param {Record<string, unknown> | null} updatedGroup */
function patchDetailGroupFromServer(updatedGroup) {
  if (!updatedGroup) return;
  detailGroup.value = updatedGroup;
  const id = String(updatedGroup.chatId ?? "");
  const idx = rows.value.findIndex((r) => String(r.chatId) === id);
  if (idx >= 0) {
    const next = [...rows.value];
    next[idx] = { ...next[idx], ...updatedGroup };
    rows.value = next;
  }
}

async function onApplyMarketEntry() {
  const g = detailGroup.value;
  if (!g) return;
  const chatId = String(g.chatId ?? "");
  const digests = [...cardPick.value].filter((d) => {
    const card = filteredDetailCards.value.find((c) => backfillCardDigest(c) === d);
    return card && isCardNotEntered(card);
  });
  if (!digests.length) {
    error.value = "请勾选「未入场」的卡片（已覆盖的无需重复）";
    return;
  }
  marketEntryLoading.value = true;
  error.value = "";
  try {
    const data = await mutateMarketEntryOverrides(period.value, chatId, digests, "apply");
    patchDetailGroupFromServer(data.group);
    await loadResults();
    if (detailGroup.value) {
      const id = String(detailGroup.value.chatId ?? "");
      const updated = rows.value.find((r) => String(r.chatId) === id);
      if (updated) detailGroup.value = updated;
    }
    note.value = `已按信号时刻市价重算 ${digests.length} 张（计入胜率/合计盈亏）`;
    cardPick.value = new Set();
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    marketEntryLoading.value = false;
  }
}

async function onClearMarketEntryOverrides() {
  const g = detailGroup.value;
  if (!g) return;
  const chatId = String(g.chatId ?? "");
  const digests = [...cardPick.value].filter((d) => {
    const card = filteredDetailCards.value.find((c) => backfillCardDigest(c) === d);
    return card && isCardOverridden(card);
  });
  if (!digests.length) {
    error.value = "请勾选已「市价假设」的卡片再清空";
    return;
  }
  marketEntryLoading.value = true;
  error.value = "";
  try {
    const data = await mutateMarketEntryOverrides(period.value, chatId, digests, "clear");
    patchDetailGroupFromServer(data.group);
    await loadResults();
    if (detailGroup.value) {
      const id = String(detailGroup.value.chatId ?? "");
      const updated = rows.value.find((r) => String(r.chatId) === id);
      if (updated) detailGroup.value = updated;
    }
    note.value = `已清空 ${digests.length} 张市价假设，恢复为未入场（不计入胜率）`;
    cardPick.value = new Set();
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    marketEntryLoading.value = false;
  }
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

async function onRebacktest() {
  rebacktestLoading.value = true;
  error.value = "";
  try {
    const data = await rebacktestTelegramBackfill(period.value, selectedRunId.value || null, {
      skipCache: skipBacktestCache.value,
    });
    if (data.async) {
      rebacktestRunning.value = true;
      rebacktestLoading.value = true;
      pollForRebacktest.value = true;
      error.value = "";
      note.value =
        "批量盈亏在后台运行（近 2 月可能需 20–40 分钟）；请勿重复点击。collect:ui 终端须出现「K线 HTTP 代理：http://127.0.0.1:7890」";
      if (!pollTimer) {
        pollTimer = setInterval(() => void refreshStatus(), 2500);
      }
      return;
    }
    applyPayload(data);
    note.value = skipBacktestCache.value
      ? "已强制重算 batch 盈亏（忽略 digest 缓存）"
      : "已重新跑 batch 盈亏回溯（命中 digest 缓存的卡片会跳过 K 线）";
    if (detailGroup.value) {
      const id = String(detailGroup.value.chatId ?? "");
      const updated = rows.value.find((r) => String(r.chatId) === id);
      if (updated) detailGroup.value = updated;
    }
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    rebacktestLoading.value = false;
  }
}

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
    const cfg = await fetchTelegramBackfillConfig();
    configGroups.value = (cfg.groups ?? []).filter((g) => g.enabled !== false);
    syncSelectionFromConfig();
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  }
}

async function loadHistoryList() {
  try {
    const data = await fetchTelegramBackfillHistory(period.value);
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
    const data = await fetchTelegramBackfillResults(period.value, runId);
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
        note.value = "尚未获取数据，选择周期后点「开始获取数据」";
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
      Number(b.cardEmitCount ?? b.parsedSignalCount ?? 0) -
        Number(a.cardEmitCount ?? a.parsedSignalCount ?? 0) ||
      Number(b.tradeLikeCount ?? 0) - Number(a.tradeLikeCount ?? 0),
  );
  generatedAt.value = String(data.generatedAt ?? "");
  fromMs.value = Number(data.fromMs) || 0;
  toMs.value = Number(data.toMs) || 0;
  const inc = data.incrementalTotals;
  incrementalTotals.value =
    inc && typeof inc === "object" ? /** @type {Record<string, number>} */ (inc) : null;
  if (!note.value) note.value = "";
}

const incrementalSummary = computed(() => {
  const t = incrementalTotals.value;
  if (!t) return "";
  const parts = [];
  if (Number(t.messagesFetchedNew) > 0) parts.push(`新拉消息 ${t.messagesFetchedNew}`);
  if (Number(t.messagesSkippedExisting) > 0) parts.push(`跳过已存 ${t.messagesSkippedExisting}`);
  if (Number(t.messagesReplayed) > 0) parts.push(`重放 ${t.messagesReplayed}`);
  if (Number(t.fetchGaps) > 0) parts.push(`补缺口 ${t.fetchGaps}`);
  return parts.length ? `增量：${parts.join(" · ")}` : "";
});

/** @param {Record<string, unknown> | null | undefined} lastRun */
function applyLastRunFailure(lastRun) {
  if (!lastRun || lastRun.ok === true) return;
  if (String(lastRun.period ?? "") !== period.value) return;
  if (rows.value.length > 0) return;
  error.value = String(
    lastRun.failHint || `回溯失败（退出码 ${lastRun.exitCode ?? "?"}）`,
  );
  const tail = String(lastRun.stderrTail ?? "").trim();
  if (tail) {
    note.value = tail.split("\n").filter(Boolean).slice(-8).join("\n");
  } else if (lastRun.outFileExists === false) {
    note.value = "未生成结果文件，请查看 collect:ui 终端 [backfill] 日志";
  }
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
      note.value = `批量盈亏进行中：群 ${p.groupIndex}/${p.groupTotal} ${String(p.groupName ?? "")}`;
    }
    return;
  }
  if (!active) {
    rebacktestLoading.value = false;
    pollForRebacktest.value = false;
  }
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
        const id = String(detailGroup.value.chatId ?? "");
        const updated = rows.value.find((r) => String(r.chatId) === id);
        if (updated) detailGroup.value = updated;
      }
    });
  }
}

async function refreshStatus() {
  try {
    const st = await fetchTelegramBackfillStatus();
    running.value = Boolean(st.running);
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
            note.value = "数据获取完成；需要盈亏时请点「批量回溯盈亏」";
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

async function onRun() {
  error.value = "";
  note.value = "";
  selectedRunId.value = "";
  if (!selectedChatIds.value.length) {
    error.value = "请至少勾选一个群组";
    return;
  }
  try {
    await runTelegramBackfill(period.value, selectedChatIds.value, {
      force: forceFullScan.value,
    });
    running.value = true;
    runPeriod.value = period.value;
    if (!pollTimer) {
      pollTimer = setInterval(() => void refreshStatus(), 2500);
    }
    note.value = forceFullScan.value
      ? `全量拉取并重放建卡 ${selectedChatIds.value.length} 群 ·「${periodLabel.value}」；完成后请点「批量回溯盈亏」`
      : `增量拉取/建卡 ${selectedChatIds.value.length} 群 ·「${periodLabel.value}」；完成后请点「批量回溯盈亏」`;
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  }
}

async function onStop() {
  error.value = "";
  try {
    await stopTelegramBackfill();
    running.value = false;
    runPeriod.value = "";
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
    note.value = "已请求停止获取（Telethon 进程可能需几秒退出）";
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
      pollTimer = setInterval(() => void refreshStatus(), 2500);
    } else if (!running.value && !rebacktestRunning.value) {
      void fetchTelegramBackfillStatus()
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
  <div class="manual-stats tg-backfill-page">
    <header class="head">
      <div>
        <h1>Telegram 回溯</h1>
        <p>
          按 <code>telegram/backfill_groups.json</code> 拉群历史并重放建卡（与
          <code>listen.py</code> 同逻辑，不 POST）。「开始获取数据」只拉消息/建卡；盈亏请另点「批量回溯盈亏」（
          <code>batch_backtest</code>，与手动统计一致）。
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
              role="tab"
              :aria-selected="period === opt.id"
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
            :disabled="running || !selectedCount"
            @click="onRun"
          >
            开始获取数据（{{ selectedCount }} 群）
          </button>
          <button type="button" class="btn danger" :disabled="!running" @click="onStop">
            停止
          </button>
        </div>
        <div class="control-flags">
          <label class="flag-check" title="忽略 coverage，Telegram 全窗口重拉；仍按 msg_id 去重入库">
            <input v-model="forceFullScan" type="checkbox" :disabled="running" />
            全量重拉（忽略增量）
          </label>
          <label class="flag-check" title="批量回溯盈亏时不用 .backfill_cache/backtest 磁盘缓存">
            <input v-model="skipBacktestCache" type="checkbox" :disabled="rebacktestLoading" />
            盈亏重算忽略缓存
          </label>
        </div>
      </div>

      <p v-if="running" class="run-banner">
        正在获取群消息与建卡
        <template v-if="runPeriod">
          · 周期 {{ BACKFILL_PERIOD_OPTIONS.find((o) => o.id === runPeriod)?.label ?? runPeriod }}
        </template>
      </p>

      <div v-if="configGroups.length" class="group-pick">
        <div class="group-pick-head">
          <span class="group-pick-title">选择回溯群组</span>
          <span class="muted tiny">{{ selectedCount }} / {{ configGroups.length }} 已选</span>
          <button type="button" class="btn tiny" :disabled="running || allGroupsSelected" @click="selectAllGroups">
            全选
          </button>
          <button type="button" class="btn tiny" :disabled="running || !selectedCount" @click="selectNoGroups">
            清空
          </button>
        </div>
        <div class="group-grid" role="group" aria-label="回溯群组多选">
          <label
            v-for="g in configGroups"
            :key="g.chatId"
            class="group-chip"
            :class="{ on: isGroupSelected(g.chatId), off: !isGroupSelected(g.chatId) }"
            :title="g.note || g.name || ''"
          >
            <input
              type="checkbox"
              class="group-chip-input"
              :checked="isGroupSelected(g.chatId)"
              :disabled="running"
              @change="onGroupCheck(g.chatId, $event)"
            />
            <span class="group-chip-name">{{ g.name || "未命名群" }}</span>
          </label>
        </div>
      </div>
      <p v-else class="summary muted">未配置群：请编辑 telegram/backfill_groups.json</p>

      <p v-if="formatRangeFull()" class="range-banner">
        回溯时间窗口 · {{ periodLabel }} · {{ formatRangeFull() }}
      </p>
      <p v-if="incrementalSummary && !running" class="summary ok tiny">{{ incrementalSummary }}</p>

      <p class="summary muted">
        {{ periodLabel }}
        <template v-if="formatRange()"> · {{ formatRange() }}</template>
        · 配置群 {{ configGroups.length }} 个
        <template v-if="viewingHistory"> · 查看历史快照</template>
        <template v-else-if="generatedAt">
          · 最新生成 {{ new Date(generatedAt).toLocaleString("zh-CN") }}
        </template>
      </p>
      <p v-if="note" class="tiny" :class="error ? 'run-fail-detail' : 'ok'">{{ note }}</p>
      <p v-if="error" class="err">{{ error }}</p>

      <div v-if="historyRuns.length" class="history-bar">
        <span class="history-label">历史记录</span>
        <button
          type="button"
          class="hist-chip"
          :class="{ on: !selectedRunId }"
          @click="selectLatest"
        >
          最新缓存
        </button>
        <button
          v-for="h in historyRuns.slice(0, 12)"
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
              <th>群名</th>
              <th>chatId</th>
              <th>消息</th>
            <th>疑似(looks_like)</th>
              <th>建卡信号</th>
              <th>盈亏回溯</th>
              <th>胜率</th>
              <th>合计盈亏</th>
              <th>热门币</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="r in rows" :key="String(r.chatId)">
              <td>{{ r.name || "—" }}</td>
              <td class="mono tiny">{{ r.chatId }}</td>
              <td>{{ r.messageCount ?? "—" }}</td>
            <td>{{ r.tradeLikeCount ?? "—" }}</td>
            <td>{{ r.cardEmitCount ?? r.parsedSignalCount ?? "—" }}</td>
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
              <td colspan="10" class="empty">暂无结果 — 选周期后点「开始获取数据」，再点「批量回溯盈亏」</td>
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
      <div class="modal" role="dialog" aria-modal="true" aria-labelledby="tg-card-modal-title">
        <header class="modal-head">
          <div>
            <h3 id="tg-card-modal-title">{{ detailGroup.name }} · 回溯卡片</h3>
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

        <div class="modal-override-bar">
          <button
            type="button"
            class="btn tiny"
            :disabled="marketEntryLoading"
            @click="selectAllNotEnteredInFilter"
          >
            全选未入场
          </button>
          <button
            type="button"
            class="btn tiny"
            :disabled="marketEntryLoading"
            @click="selectAllOverriddenInFilter"
          >
            全选已市价假设
          </button>
          <button type="button" class="btn tiny" :disabled="!cardPick.size" @click="clearCardPick">
            取消勾选
          </button>
          <button
            type="button"
            class="btn tiny primary"
            :disabled="marketEntryLoading || !cardPick.size"
            @click="onApplyMarketEntry"
          >
            {{ marketEntryLoading ? "重算中…" : "按市价入场重算" }}
          </button>
          <button
            type="button"
            class="btn tiny danger"
            :disabled="marketEntryLoading || !cardPick.size"
            @click="onClearMarketEntryOverrides"
          >
            清空勾选覆盖
          </button>
          <span v-if="cardPick.size" class="muted tiny">已选 {{ cardPick.size }}</span>
        </div>

        <p class="modal-summary">
          筛选后 {{ detailSummary.total }} 张
          <template v-if="detailSummary.winRate != null">
            · 胜率 {{ Math.round(detailSummary.winRate * 100) }}%
            （{{ detailSummary.wins }}/{{ detailSummary.wins + detailSummary.losses }}）
          </template>
          <template v-if="detailSummary.klineMiss">
            · K线暂缺 {{ detailSummary.klineMiss }}（限速退避，不计胜率）
          </template>
          <template v-if="detailSummary.errors"> · 异常 {{ detailSummary.errors }}</template>
          <template v-if="detailSummary.pnlN">
            · 合计盈亏
            {{ detailSummary.totalPnl >= 0 ? "+" : "" }}{{ detailSummary.totalPnl.toFixed(2) }}%
            （{{ detailSummary.pnlN }} 张已计）
          </template>
          <span v-if="!detailGroup.backtestsRun && cardsForGroup(detailGroup).length" class="muted">
            · 尚未 batch 盈亏回溯，可点「批量回溯盈亏」
          </span>
          <span class="muted tiny"> · 同币/方向/阶段 20 分钟内仅保留最早一条</span>
        </p>

        <div class="modal-table-wrap">
          <table class="modal-table">
            <thead>
              <tr>
                <th class="col-check"></th>
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
              <tr
                v-for="(c, i) in filteredDetailCards"
                :key="backfillCardDigest(c) + i"
                :class="{ 'row-override': c.marketEntryOverride, 'row-not-entered': isCardNotEntered(c) }"
              >
                <td class="col-check">
                  <input
                    type="checkbox"
                    :checked="cardPick.has(backfillCardDigest(c))"
                    :disabled="marketEntryLoading"
                    @change="onCardPick(backfillCardDigest(c), $event)"
                  />
                </td>
                <td class="tiny">{{ formatSignalTime(c) }}</td>
                <td>{{ c.symbol || "—" }}</td>
                <td>{{ c.direction ?? "—" }}</td>
                <td class="tiny">{{ c.phase ?? "—" }}</td>
                <td
                  :class="{
                    ok: Number(c.pnlPct) > 0,
                    err: Number(c.pnlPct) < 0,
                  }"
                >
                  {{ formatPnl(c) }}
                </td>
                <td :class="outcomeCellClass(c)">
                  {{ outcomeLabel(c) }}
                </td>
                <td class="preview-cell tiny">{{ c.preview || "—" }}</td>
              </tr>
              <tr v-if="!filteredDetailCards.length">
                <td colspan="8" class="empty">该时间范围内无卡片</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.tg-backfill-page {
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
.control-row {
  max-width: 100%;
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
.btn.danger:hover:not(:disabled) {
  background: rgba(237, 66, 69, 0.12);
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
  user-select: none;
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
.warn {
  color: #faa61a;
}
.run-fail-detail {
  margin-top: 0.35rem;
  color: #b5bac1;
  white-space: pre-wrap;
  font-family: ui-monospace, monospace;
  font-size: 0.68rem;
}
.ok {
  color: #3ba55d;
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
  align-items: stretch;
}
.group-chip {
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  margin: 0;
  padding: 0.38rem 0.65rem;
  border-radius: 999px;
  border: 1px solid #404249;
  background: #25262b;
  cursor: pointer;
  user-select: none;
  transition:
    border-color 0.12s ease,
    background 0.12s ease,
    opacity 0.12s ease;
  max-width: 100%;
}
.group-chip:hover:not(:has(input:disabled)) {
  border-color: #52565e;
  background: #2b2d35;
}
.group-chip.on {
  border-color: #5865f2;
  background: rgba(88, 101, 242, 0.18);
}
.group-chip.off {
  opacity: 0.62;
}
.group-chip-input {
  flex-shrink: 0;
  margin: 0;
  accent-color: #5865f2;
  cursor: pointer;
}
.group-chip-name {
  font-size: 0.82rem;
  font-weight: 500;
  color: #f2f3f5;
  line-height: 1.25;
  word-break: break-word;
}
.group-chip:has(input:disabled) {
  cursor: not-allowed;
  opacity: 0.5;
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
.range-banner {
  margin: 0.55rem 0 0;
  padding: 0.45rem 0.65rem;
  border-radius: 8px;
  background: #1e1f22;
  border: 1px solid #35373c;
  color: #dbdee1;
  font-size: 0.78rem;
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
  box-shadow: 0 12px 40px rgba(0, 0, 0, 0.45);
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
.modal-override-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.4rem;
  margin: 0.65rem 0 0.35rem;
}
.col-check {
  width: 2rem;
  text-align: center;
}
.modal-table tr.row-not-entered td {
  opacity: 0.88;
}
.modal-table tr.row-override td {
  background: rgba(88, 101, 242, 0.08);
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
.detail-samples {
  margin-top: 0.75rem;
  font-size: 0.85rem;
}
.detail-samples summary {
  cursor: pointer;
  color: #b5bac1;
}
.detail-samples ul {
  margin: 0.35rem 0 0.5rem 1rem;
  padding: 0;
}
</style>
