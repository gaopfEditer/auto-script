<script setup>
import { ref, computed, watch, onMounted, onUnmounted } from "vue";
import {
  fetchTodayAutotradePnl,
  markTodayPnlOpenCard,
  publishTodayPnlSelection,
} from "../lib/todayAutotradePnlApi.js";
import { formatCardTime } from "../lib/discordSignalApi.js";

defineOptions({ name: "TodayAutotradePnlView" });

const MARGIN_CACHE = "today-pnl-margin-v2";
const DISPLAY_CACHE = "today-pnl-display-v1";

const loading = ref(false);
const error = ref("");
/** @type {import('vue').Ref<Record<string, unknown>|null>} */
const data = ref(null);
let timer = 0;

/** @type {import('vue').Ref<Record<string, number>>} */
const marginOverrides = ref({});
const batchMarginInput = ref("");
const selectedIds = ref(/** @type {Set<number>} */ (new Set()));
const pickerOpen = ref(false);
const publishLoading = ref(false);
const publishMessage = ref("");
const hideSource = ref(false);
const hideChannel = ref(false);
/** @type {import('vue').Ref<Record<number, { status: string, pnlPct?: number, markError?: string, markPrice?: number }>>} */
const mtmByCardId = ref({});
const mtmSweepActive = ref(false);
let mtmInFlight = 0;

function shanghaiTodayYmd() {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
  }).format(new Date());
}

/** 查询日 YYYY-MM-DD（上海）；默认今日 */
const selectedDayYmd = ref(shanghaiTodayYmd());

const isViewingToday = computed(
  () => data.value?.isQueryToday !== false && selectedDayYmd.value === shanghaiTodayYmd(),
);

function loadDisplayPrefs() {
  try {
    const raw = localStorage.getItem(DISPLAY_CACHE);
    if (!raw) return;
    const j = JSON.parse(raw);
    hideSource.value = Boolean(j?.hideSource);
    hideChannel.value = Boolean(j?.hideChannel);
  } catch {
    /* ignore */
  }
}

function persistDisplayPrefs() {
  try {
    localStorage.setItem(
      DISPLAY_CACHE,
      JSON.stringify({
        hideSource: hideSource.value,
        hideChannel: hideChannel.value,
      }),
    );
  } catch {
    /* ignore */
  }
}

function toggleHideSource() {
  hideSource.value = !hideSource.value;
  persistDisplayPrefs();
}

function toggleHideChannel() {
  hideChannel.value = !hideChannel.value;
  persistDisplayPrefs();
}

function onDayInputChange(ev) {
  const v = String(/** @type {HTMLInputElement} */ (ev.target).value ?? "").trim();
  if (!v) return;
  selectedDayYmd.value = v;
  void load();
}

function pickToday() {
  selectedDayYmd.value = shanghaiTodayYmd();
  void load();
}

function pickYesterday() {
  const start = Date.parse(`${shanghaiTodayYmd()}T00:00:00+08:00`) - 86_400_000;
  selectedDayYmd.value = new Intl.DateTimeFormat("en-CA", {
    timeZone: "Asia/Shanghai",
  }).format(new Date(start));
  void load();
}

/** @param {Record<string, unknown>} t */
function displaySourceLabel(t) {
  if (hideSource.value) return "*****";
  return String(t.sourceLabel || t.sourceType || "—");
}

/** @param {Record<string, unknown>} t */
function displayChannelLabel(t) {
  if (hideChannel.value) return "*****";
  const s = String(t.channelName || t.channelId || "").trim();
  return s || "—";
}

async function load() {
  loading.value = true;
  error.value = "";
  try {
    mtmByCardId.value = {};
    data.value = await fetchTodayAutotradePnl(selectedDayYmd.value);
    if (data.value?.queryDay) selectedDayYmd.value = String(data.value.queryDay);
    restoreMarginCache();
    void settleOpenPositions();
  } catch (e) {
    error.value = e instanceof Error ? e.message : String(e);
    data.value = null;
  } finally {
    loading.value = false;
  }
}

function cacheKey() {
  const fromMs = data.value?.fromMs;
  return fromMs != null ? `${MARGIN_CACHE}-${fromMs}` : null;
}

function restoreMarginCache() {
  const key = cacheKey();
  if (!key) return;
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return;
    const j = JSON.parse(raw);
    if (j?.margins && typeof j.margins === "object") {
      marginOverrides.value = { ...j.margins };
    }
    if (j?.batchDefault != null && batchMarginInput.value === "") {
      batchMarginInput.value = String(j.batchDefault);
    }
  } catch {
    /* ignore */
  }
}

function persistMarginCache() {
  const key = cacheKey();
  if (!key) return;
  try {
    localStorage.setItem(
      key,
      JSON.stringify({
        margins: marginOverrides.value,
        batchDefault: batchMarginInput.value,
      }),
    );
  } catch {
    /* ignore */
  }
}

watch(marginOverrides, () => persistMarginCache(), { deep: true });
watch(batchMarginInput, () => persistMarginCache());

const trades = computed(() => (Array.isArray(data.value?.trades) ? data.value.trades : []));

function marginFor(t) {
  const id = String(t.cardId);
  const ov = marginOverrides.value[id];
  if (ov != null && Number.isFinite(Number(ov)) && Number(ov) > 0) return Number(ov);
  return Number(t.defaultMarginUsdt ?? t.marginUsdt ?? 2);
}

/** @param {Record<string, unknown>} t */
function mtmStateFor(t) {
  const id = Number(t.cardId);
  return mtmByCardId.value[id] ?? null;
}

/** @param {Record<string, unknown>} t */
function displayPnlPct(t) {
  if (!t.closed) {
    const mtm = mtmStateFor(t);
    if (mtm?.status === "ok" && mtm.pnlPct != null && Number.isFinite(Number(mtm.pnlPct))) {
      return Number(mtm.pnlPct);
    }
  }
  if (t.pnlPct == null || !Number.isFinite(Number(t.pnlPct))) return null;
  return Number(t.pnlPct);
}

function pnlUsdtFor(t, pnlPct) {
  const pct = pnlPct != null ? pnlPct : displayPnlPct(t);
  if (pct == null || !Number.isFinite(Number(pct))) return null;
  return Math.round((marginFor(t) * Number(pct)) / 100 * 100) / 100;
}

/** @param {Record<string, unknown>} t */
function enrichTrade(t) {
  const pnlPct = displayPnlPct(t);
  const mtm = mtmStateFor(t);
  return {
    ...t,
    effectiveMarginUsdt: marginFor(t),
    effectivePnlPct: pnlPct,
    effectivePnlUsdt: pnlUsdtFor(t, pnlPct),
    mtmStatus: mtm?.status ?? "",
    mtmError: mtm?.markError ?? "",
    mtmMarkPrice: mtm?.markPrice,
  };
}

const rows = computed(() => trades.value.map((t) => enrichTrade(t)));

const summary = computed(() => {
  let sumPnlUsdt = 0;
  let closedPnl = 0;
  let openCount = 0;
  let closedCount = 0;
  for (const t of rows.value) {
    if (t.closed) closedCount += 1;
    else openCount += 1;
    const p = t.effectivePnlUsdt;
    if (p != null && Number.isFinite(Number(p))) {
      sumPnlUsdt += Number(p);
      if (t.closed) closedPnl += Number(p);
    }
  }
  return {
    tradeCards: rows.value.length,
    openCount,
    closedCount,
    sumPnlUsdt: Math.round(sumPnlUsdt * 100) / 100,
    closedPnlUsdt: Math.round(closedPnl * 100) / 100,
    note: data.value?.summary?.note ?? "",
  };
});

const dayLabel = computed(() => String(data.value?.dayLabel ?? ""));
const publishEnabled = computed(() => data.value?.publishEnabled !== false);
const sumPnl = computed(() => Number(summary.value?.sumPnlUsdt ?? 0));
const sumClass = computed(() => (sumPnl.value >= 0 ? "up" : "down"));

const allSelected = computed(
  () => rows.value.length > 0 && selectedIds.value.size === rows.value.length,
);
const someSelected = computed(() => selectedIds.value.size > 0);

const selectedRows = computed(() =>
  rows.value.filter((t) => selectedIds.value.has(Number(t.cardId))),
);

const pickerSumPnl = computed(() => {
  let s = 0;
  for (const t of selectedRows.value) {
    const p = t.effectivePnlUsdt;
    if (p != null && Number.isFinite(Number(p))) s += Number(p);
  }
  return Math.round(s * 100) / 100;
});

function toggleSelectAll() {
  if (allSelected.value) {
    selectedIds.value = new Set();
    return;
  }
  selectedIds.value = new Set(rows.value.map((t) => Number(t.cardId)));
}

/** @param {number} cardId */
function toggleRow(cardId) {
  const next = new Set(selectedIds.value);
  if (next.has(cardId)) next.delete(cardId);
  else next.add(cardId);
  selectedIds.value = next;
}

function applyBatchMargin() {
  const m = Number(batchMarginInput.value);
  if (!Number.isFinite(m) || m <= 0) {
    error.value = "批量保证金须为正数";
    return;
  }
  error.value = "";
  const next = { ...marginOverrides.value };
  for (const t of trades.value) {
    next[String(t.cardId)] = m;
  }
  marginOverrides.value = next;
}

/** @param {number} cardId @param {string|number} v */
function setRowMargin(cardId, v) {
  const m = Number(v);
  if (!Number.isFinite(m) || m <= 0) return;
  marginOverrides.value = { ...marginOverrides.value, [String(cardId)]: m };
}

function resetRowMargin(cardId) {
  const next = { ...marginOverrides.value };
  delete next[String(cardId)];
  marginOverrides.value = next;
}

function resetAllMargins() {
  marginOverrides.value = {};
}

function openPicker() {
  if (!selectedRows.value.length) {
    error.value = "请先勾选至少一行";
    return;
  }
  error.value = "";
  pickerOpen.value = true;
}

function closePicker() {
  pickerOpen.value = false;
  publishMessage.value = "";
}

function buildPublishRows() {
  return selectedRows.value.map((t) => ({
    sourceLabel: displaySourceLabel(t),
    channelName: displayChannelLabel(t),
    symbol: t.symbol,
    marginUsdt: t.effectiveMarginUsdt,
    pnlPct: t.effectivePnlPct,
    pnlUsdt: t.effectivePnlUsdt,
    statusLabel: outcomeLabel(t),
    uid: t.uid,
  }));
}

/** @param {Record<string, unknown>} t */
function fmtRowPct(t) {
  if (!t.closed && t.mtmStatus === "pending") return "结算中…";
  if (!t.closed && t.mtmStatus === "error") {
    return t.mtmError || "现价失败";
  }
  return fmtPct(t.effectivePnlPct);
}

/** @param {Record<string, unknown>} t */
function fmtRowPnl(t) {
  if (!t.closed && t.mtmStatus === "pending") return "…";
  if (!t.closed && t.mtmStatus === "error") return "—";
  return fmtPnl(t.effectivePnlUsdt);
}

/** @param {number} cardId */
async function markOneOpenRow(cardId) {
  mtmInFlight += 1;
  mtmSweepActive.value = true;
  mtmByCardId.value = {
    ...mtmByCardId.value,
    [cardId]: { status: "pending" },
  };
  try {
    const j = await markTodayPnlOpenCard(cardId);
    if (j?.skipped) {
      const next = { ...mtmByCardId.value };
      delete next[cardId];
      mtmByCardId.value = next;
      return;
    }
    if (j?.ok) {
      mtmByCardId.value = {
        ...mtmByCardId.value,
        [cardId]: {
          status: "ok",
          pnlPct: Number(j.pnlPct),
          markPrice: j.markPrice != null ? Number(j.markPrice) : undefined,
        },
      };
      return;
    }
    mtmByCardId.value = {
      ...mtmByCardId.value,
      [cardId]: {
        status: "error",
        markError: String(j?.markError ?? j?.error ?? "现价获取失败"),
      },
    };
  } catch (e) {
    mtmByCardId.value = {
      ...mtmByCardId.value,
      [cardId]: {
        status: "error",
        markError: e instanceof Error ? e.message : String(e),
      },
    };
  } finally {
    mtmInFlight = Math.max(0, mtmInFlight - 1);
    mtmSweepActive.value = mtmInFlight > 0;
  }
}

function settleOpenPositions() {
  const open = trades.value.filter((t) => !t.closed);
  for (const t of open) {
    void markOneOpenRow(Number(t.cardId));
  }
}

async function publishPickerToOperate() {
  if (!selectedRows.value.length) {
    publishMessage.value = "没有可发布的行";
    return;
  }
  publishLoading.value = true;
  publishMessage.value = "";
  error.value = "";
  try {
    const j = await publishTodayPnlSelection({
      dayLabel: dayLabel.value,
      sumPnlUsdt: pickerSumPnl.value,
      rows: buildPublishRows(),
    });
    const job = j?.jobId ? `任务 ${j.jobId}` : "已排队";
    publishMessage.value = `CDP 发布已提交（${job}）`;
  } catch (e) {
    publishMessage.value = e instanceof Error ? e.message : String(e);
  } finally {
    publishLoading.value = false;
  }
}

function fmtPnl(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)} U`;
}

function fmtPct(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

function outcomeLabel(t) {
  const outcome =
    String(t?.displayOutcome ?? t?.progressOutcome ?? "").trim() ||
    (t?.effectivePnlPct != null && Number.isFinite(Number(t.effectivePnlPct))
      ? Number(t.effectivePnlPct) >= 0
        ? "take_profit"
        : "stop_loss"
      : "");
  if (outcome === "take_profit") return "止盈";
  if (outcome === "stop_loss") return "止损";
  if (t?.closed) return "已结算";
  return "持仓中";
}

/** @param {string | null | undefined} v */
function fmtPlanPrice(v) {
  const s = String(v ?? "").trim();
  return s || "—";
}

/** @param {Record<string, unknown>} t */
function fmtTakeProfit(t) {
  const text = String(t.takeProfitText ?? "").trim();
  if (text) return text;
  const arr = Array.isArray(t.takeProfitPrices) ? t.takeProfitPrices : [];
  const joined = arr.map((x) => String(x ?? "").trim()).filter(Boolean).join(", ");
  return joined || "—";
}

/** @param {Record<string, unknown>} t */
function fmtSignalTime(t) {
  const raw = t.signalAt;
  if (!raw) return "—";
  const s = formatCardTime({ signalAt: raw });
  return s || "—";
}

function restartAutoRefresh() {
  if (timer) clearInterval(timer);
  timer = 0;
  if (isViewingToday.value) {
    timer = window.setInterval(() => void load(), 60_000);
  }
}

watch(isViewingToday, () => restartAutoRefresh());

onMounted(() => {
  loadDisplayPrefs();
  void load();
  restartAutoRefresh();
});
onUnmounted(() => {
  if (timer) clearInterval(timer);
});
</script>

<template>
  <div class="page today-pnl-page" :class="{ loading }">
    <header class="hero" aria-label="今日跟单盈亏摘要">
      <p class="hero-kicker">巨鲸 / Telegram / 币安广场 · 路径结算</p>
      <h1 class="hero-date">{{ dayLabel || "今日（上海）" }}</h1>
      <div class="hero-day-pick">
        <label class="day-label" for="today-pnl-day">查询日</label>
        <input
          id="today-pnl-day"
          type="date"
          class="day-inp"
          :value="selectedDayYmd"
          :max="shanghaiTodayYmd()"
          @change="onDayInputChange"
        />
        <button type="button" class="btn-secondary day-btn" @click="pickYesterday">昨天</button>
        <button type="button" class="btn-secondary day-btn" @click="pickToday">今天</button>
      </div>
      <p class="hero-pnl" :class="sumClass">{{ fmtPnl(sumPnl) }}</p>
      <p class="hero-sub">
        有效卡 <strong>{{ summary.tradeCards ?? 0 }}</strong> 张 · 已结
        <strong>{{ summary.closedCount ?? 0 }}</strong> · 持仓
        <strong>{{ summary.openCount ?? 0 }}</strong>
        <template v-if="someSelected">
          · 已勾选 <strong>{{ selectedIds.size }}</strong> 张
        </template>
      </p>
      <p class="hero-note">{{ summary.note }}</p>
      <button type="button" class="btn-refresh" :disabled="loading" @click="load">刷新</button>
    </header>

    <section class="toolbar">
      <div class="toolbar-row">
        <label class="batch-label">批量保证金 (U)</label>
        <input
          v-model="batchMarginInput"
          type="number"
          min="0.01"
          step="0.01"
          class="margin-inp batch"
          placeholder="如 100"
        />
        <button type="button" class="btn-secondary" @click="applyBatchMargin">应用到全部</button>
        <button type="button" class="btn-secondary" @click="resetAllMargins">恢复默认基数</button>
        <button
          type="button"
          class="btn-secondary"
          :disabled="mtmSweepActive || !summary.openCount"
          :title="
            summary.openCount
              ? `按现价重算本页「持仓中」行（${selectedDayYmd}）`
              : '本查询日无持仓中'
          "
          @click="settleOpenPositions"
        >
          {{ mtmSweepActive ? "持仓结算中…" : "重新结算持仓中" }}
        </button>
      </div>
      <div class="toolbar-row">
        <button type="button" class="btn-primary" :disabled="!someSelected" @click="openPicker">
          生成勾选弹窗表（{{ selectedIds.size }}）
        </button>
        <button
          type="button"
          class="btn-secondary hide-toggle"
          :class="{ on: hideSource }"
          :title="hideSource ? '显示来源列' : '隐藏来源（截图用 *****）'"
          @click="toggleHideSource"
        >
          {{ hideSource ? "显示来源" : "隐藏来源" }}
        </button>
        <button
          type="button"
          class="btn-secondary hide-toggle"
          :class="{ on: hideChannel }"
          :title="hideChannel ? '显示频道名称' : '隐藏频道名称（截图用 *****）'"
          @click="toggleHideChannel"
        >
          {{ hideChannel ? "显示频道" : "隐藏频道" }}
        </button>
      </div>
    </section>

    <p v-if="error" class="err">{{ error }}</p>

    <section v-if="rows.length" class="table-wrap">
      <table class="tbl">
        <thead>
          <tr>
            <th class="col-check">
              <input
                type="checkbox"
                :checked="allSelected"
                :indeterminate="someSelected && !allSelected"
                aria-label="全选"
                @change="toggleSelectAll"
              />
            </th>
            <th>来源</th>
            <th>原帖</th>
            <th>卡片</th>
            <th>频道</th>
            <th>币种</th>
            <th>保证金 (U)</th>
            <th>盈亏%</th>
            <th>盈亏U</th>
            <th>状态</th>
            <th>信号时间</th>
            <th>入场</th>
            <th>止损</th>
            <th>止盈</th>
          </tr>
        </thead>
        <tbody>
          <tr v-for="t in rows" :key="t.cardId" :class="{ selected: selectedIds.has(Number(t.cardId)) }">
            <td class="col-check">
              <input
                type="checkbox"
                :checked="selectedIds.has(Number(t.cardId))"
                :aria-label="`选择 ${t.uid}`"
                @change="toggleRow(Number(t.cardId))"
              />
            </td>
            <td>
              <span class="src-tag">{{ displaySourceLabel(t) }}</span>
              <span v-if="!hideSource && t.hasLiveAutotrade" class="live-dot" title="有实盘跟单">跟</span>
            </td>
            <td class="post-cell">
              <a
                v-if="t.sourcePostUrl"
                class="post-link"
                :href="t.sourcePostUrl"
                target="_blank"
                rel="noopener noreferrer"
                title="打开原帖"
              >
                打开
              </a>
              <span v-else class="muted">—</span>
            </td>
            <td class="mono">{{ t.uid }}</td>
            <td>{{ displayChannelLabel(t) }}</td>
            <td class="mono">{{ t.symbol }}</td>
            <td class="margin-cell">
              <input
                type="number"
                min="0.01"
                step="0.01"
                class="margin-inp"
                :value="t.effectiveMarginUsdt"
                @change="setRowMargin(Number(t.cardId), ($event.target).value)"
              />
              <button
                v-if="marginOverrides[String(t.cardId)] != null"
                type="button"
                class="btn-link"
                title="恢复默认"
                @click="resetRowMargin(Number(t.cardId))"
              >
                默认{{ t.defaultMarginUsdt ?? t.marginUsdt }}U
              </button>
            </td>
            <td
              :class="
                t.mtmStatus === 'error'
                  ? 'mtm-err'
                  : Number(t.effectivePnlPct) >= 0
                    ? 'up'
                    : 'down'
              "
              :title="
                t.mtmMarkPrice != null && !t.closed
                  ? `现价 ${t.mtmMarkPrice}`
                  : t.mtmError || undefined
              "
            >
              {{ fmtRowPct(t) }}
            </td>
            <td :class="Number(t.effectivePnlUsdt) >= 0 ? 'up' : 'down'">
              {{ fmtRowPnl(t) }}
            </td>
            <td>{{ outcomeLabel(t) }}</td>
            <td class="time" :title="'Asia/Shanghai (UTC+8)'">{{ fmtSignalTime(t) }}</td>
            <td
              class="mono tpsl entry-col"
              :title="t.entryPriceKind === 'market_at_signal' ? '发单当时的市价（非现价）' : undefined"
            >
              {{ fmtPlanPrice(t.entryPriceDisplay) }}
            </td>
            <td class="mono tpsl">{{ fmtPlanPrice(t.stopLossPrice) }}</td>
            <td class="mono tpsl">{{ fmtTakeProfit(t) }}</td>
          </tr>
        </tbody>
      </table>
    </section>
    <p v-else-if="!loading" class="empty">今日暂无可结算卡（collect:ui 需加载最新 API）。</p>

    <div v-if="pickerOpen" class="modal-backdrop" @click.self="closePicker">
      <div class="modal-panel" role="dialog" aria-modal="true">
        <header class="modal-head">
          <div>
            <h2>勾选结算表</h2>
            <p class="modal-sub">
              {{ selectedRows.length }} 笔 · 合计
              <strong :class="pickerSumPnl >= 0 ? 'up' : 'down'">{{ fmtPnl(pickerSumPnl) }}</strong>
            </p>
          </div>
          <div class="modal-actions">
            <button
              type="button"
              class="btn-publish"
              :disabled="publishLoading || !selectedRows.length || !publishEnabled"
              :title="
                publishEnabled
                  ? '经 python-ai-operate CDP 发到已配置平台（需 :8787）'
                  : 'TRADE_SIGNAL_AI_PUBLISH 未开启，请在 .env 打开后重启 collect:ui'
              "
              @click="publishPickerToOperate"
            >
              {{ publishLoading ? "发布中…" : "发布" }}
            </button>
            <button type="button" class="modal-close" aria-label="关闭" @click="closePicker">×</button>
          </div>
        </header>
        <p v-if="publishMessage" class="modal-publish-msg">{{ publishMessage }}</p>
        <div class="modal-body">
          <table class="tbl modal-tbl">
            <thead>
              <tr>
                <th>来源</th>
                <th>原帖</th>
                <th>卡片</th>
                <th>博主/频道</th>
                <th>币种</th>
                <th>保证金</th>
                <th>盈亏%</th>
                <th>盈亏U</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="t in selectedRows" :key="'pick-' + t.cardId">
                <td>{{ displaySourceLabel(t) }}</td>
                <td class="post-cell">
                  <a
                    v-if="t.sourcePostUrl"
                    class="post-link"
                    :href="t.sourcePostUrl"
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    打开
                  </a>
                  <span v-else class="muted">—</span>
                </td>
                <td class="mono">{{ t.uid }}</td>
                <td>{{ displayChannelLabel(t) }}</td>
                <td class="mono">{{ t.symbol }}</td>
                <td>{{ t.effectiveMarginUsdt }}U</td>
                <td
                  :class="
                    t.effectivePnlPct == null
                      ? ''
                      : Number(t.effectivePnlPct) >= 0
                        ? 'up'
                        : 'down'
                  "
                >
                  {{ fmtPct(t.effectivePnlPct) }}
                </td>
                <td
                  :class="
                    t.effectivePnlUsdt == null
                      ? ''
                      : Number(t.effectivePnlUsdt) >= 0
                        ? 'up'
                        : 'down'
                  "
                >
                  {{ fmtPnl(t.effectivePnlUsdt) }}
                </td>
                <td>{{ outcomeLabel(t) }}</td>
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </div>
  </div>
</template>

<style scoped>
.today-pnl-page {
  box-sizing: border-box;
  max-width: 1180px;
  margin: 0 auto;
  padding: 1rem 1.5rem 2.5rem;
  min-height: min-content;
}
.hero {
  background: linear-gradient(145deg, #1e1f22 0%, #2b2d31 55%, #1a3d2e 100%);
  border: 1px solid #404249;
  border-radius: 16px;
  padding: 1.5rem 1.75rem 1.35rem;
  margin-bottom: 1rem;
  text-align: center;
}
.hero-kicker {
  margin: 0;
  font-size: 0.85rem;
  color: #b5bac1;
  letter-spacing: 0.06em;
}
.hero-date {
  margin: 0.35rem 0 0.5rem;
  font-size: 1.05rem;
  font-weight: 600;
  color: #f2f3f5;
}
.hero-day-pick {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
  margin: 0.25rem 0 0.5rem;
}
.day-label {
  font-size: 0.85rem;
  color: #b5bac1;
}
.day-inp {
  font: inherit;
  padding: 0.25rem 0.4rem;
  border-radius: 6px;
  border: 1px solid #404249;
  background: #2b2d31;
  color: #f2f3f5;
}
.day-btn {
  padding: 0.25rem 0.65rem;
  font-size: 0.85rem;
}
.hero-pnl {
  margin: 0;
  font-size: 2.75rem;
  font-weight: 800;
  line-height: 1.1;
  font-variant-numeric: tabular-nums;
}
.hero-pnl.up {
  color: #3ba55c;
}
.hero-pnl.down {
  color: #ed4245;
}
.hero-sub {
  margin: 0.65rem 0 0;
  color: #dbdee1;
  font-size: 0.92rem;
}
.hero-note {
  margin: 0.75rem 0 0;
  font-size: 0.78rem;
  color: #949ba4;
  line-height: 1.45;
}
.btn-refresh {
  margin-top: 1rem;
  padding: 0.45rem 1.1rem;
  border-radius: 8px;
  border: 1px solid #5865f2;
  background: #5865f2;
  color: #fff;
  font-weight: 600;
  cursor: pointer;
}
.btn-refresh:disabled {
  opacity: 0.55;
  cursor: default;
}
.toolbar {
  display: flex;
  flex-direction: column;
  gap: 0.65rem;
  margin-bottom: 1rem;
  padding: 0.85rem 1rem;
  background: #2b2d31;
  border: 1px solid #404249;
  border-radius: 12px;
}
.toolbar-row {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 0.5rem;
}
.batch-label {
  font-size: 0.85rem;
  color: #b5bac1;
}
.btn-secondary,
.btn-primary {
  padding: 0.4rem 0.85rem;
  border-radius: 8px;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  border: 1px solid #4e5058;
  background: #383a40;
  color: #f2f3f5;
}
.btn-primary {
  border-color: #5865f2;
  background: #5865f2;
}
.btn-primary:disabled {
  opacity: 0.45;
  cursor: default;
}
.hide-toggle.on {
  background: rgba(88, 101, 242, 0.22);
  border-color: rgba(88, 101, 242, 0.55);
  color: #c7ceff;
}
.post-cell {
  white-space: nowrap;
}
.post-link {
  color: #00a8fc;
  text-decoration: none;
  font-size: 0.85rem;
  font-weight: 600;
}
.post-link:hover {
  text-decoration: underline;
}
.muted {
  color: #72767d;
}
.btn-link {
  display: block;
  margin-top: 0.2rem;
  padding: 0;
  border: none;
  background: none;
  color: #5865f2;
  font-size: 0.72rem;
  cursor: pointer;
  text-decoration: underline;
}
.err {
  color: #ed4245;
  margin-bottom: 0.75rem;
}
.table-wrap {
  overflow-x: auto;
  border: 1px solid #404249;
  border-radius: 12px;
  background: #2b2d31;
}
.tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.86rem;
}
.tbl th,
.tbl td {
  padding: 0.55rem 0.65rem;
  border-bottom: 1px solid #383a40;
  text-align: left;
}
.tbl th {
  color: #b5bac1;
  font-weight: 600;
  background: #232428;
}
.tbl tr.selected td {
  background: rgba(88, 101, 242, 0.08);
}
.col-check {
  width: 2.5rem;
  text-align: center;
}
.mono {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
}
.time {
  font-size: 0.78rem;
  color: #949ba4;
  white-space: nowrap;
}
.mtm-err {
  color: #faa81a;
  font-size: 0.8rem;
}
.tpsl {
  font-size: 0.8rem;
  max-width: 9rem;
  word-break: break-all;
}
.margin-cell {
  min-width: 6.5rem;
}
.margin-inp {
  width: 4.5rem;
  padding: 0.25rem 0.35rem;
  border-radius: 6px;
  border: 1px solid #4e5058;
  background: #1e1f22;
  color: #f2f3f5;
  font-variant-numeric: tabular-nums;
}
.margin-inp.batch {
  width: 5.5rem;
}
.src-tag {
  font-size: 0.78rem;
  color: #dbdee1;
}
.live-dot {
  margin-left: 0.25rem;
  font-size: 0.7rem;
  padding: 0.05rem 0.3rem;
  border-radius: 4px;
  background: #3ba55c33;
  color: #3ba55c;
}
.up {
  color: #3ba55c;
}
.down {
  color: #ed4245;
}
.empty {
  color: #949ba4;
  text-align: center;
  padding: 2rem;
}
.modal-backdrop {
  position: fixed;
  inset: 0;
  z-index: 200;
  background: rgba(0, 0, 0, 0.65);
  display: flex;
  align-items: center;
  justify-content: center;
  padding: 1rem;
}
.modal-panel {
  width: min(960px, 100%);
  max-height: 88vh;
  background: #2b2d31;
  border: 1px solid #404249;
  border-radius: 14px;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.modal-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  padding: 1rem 1.15rem;
  border-bottom: 1px solid #404249;
}
.modal-head h2 {
  margin: 0;
  font-size: 1.1rem;
}
.modal-sub {
  margin: 0.35rem 0 0;
  font-size: 0.88rem;
  color: #b5bac1;
}
.modal-actions {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  flex-shrink: 0;
}
.btn-publish {
  padding: 0.35rem 0.85rem;
  border-radius: 8px;
  border: 1px solid #5865f2;
  background: #5865f2;
  color: #fff;
  font-size: 0.85rem;
  font-weight: 600;
  cursor: pointer;
  white-space: nowrap;
}
.btn-publish:disabled {
  opacity: 0.45;
  cursor: default;
}
.modal-publish-msg {
  margin: 0;
  padding: 0.5rem 1.15rem;
  font-size: 0.82rem;
  color: #b5bac1;
  border-bottom: 1px solid #404249;
  background: #2b2d31;
}
.modal-close {
  border: none;
  background: transparent;
  color: #b5bac1;
  font-size: 1.5rem;
  line-height: 1;
  cursor: pointer;
}
.modal-body {
  overflow: auto;
  padding: 0.75rem 1rem 1.25rem;
}
.modal-tbl {
  font-size: 0.84rem;
}
</style>