<script setup>
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import {
  createManualStatsCard,
  deleteArchiveCard,
  fetchArchiveCards,
  liquidateArchiveCards,
  updateManualStatsCard,
} from "../lib/cardArchiveApi.js";
import { outcomeLabel, resolveCardPnlPct } from "../lib/signalExecution.js";

defineOptions({ name: "ManualStatsView" });

const DRAFT_CACHE_KEY = "manual-stats-draft-rows-v2";
const BLOGGER_CACHE_KEY = "manual-stats-bloggers-v1";
const FILTER_CACHE_KEY = "manual-stats-filters-v1";

/**
 * @typedef {{
 *   lid: string,
 *   blogger: string,
 *   symbol: string,
 *   direction: "多" | "空",
 *   signalAt: string,
 *   entry: string,
 *   stopLoss: string,
 *   takeProfit: string,
 *   note: string,
 *   editCardId?: number | null,
 * }} DraftRow
 */

const draftRows = ref(/** @type {DraftRow[]} */ ([]));
const autoLiquidate = ref(true);
const fromDate = ref("");
const toDate = ref("");
const filterBlogger = ref("");

/** @type {import("vue").Ref<{ key: string, alias: string, label: string }[]>} */
const bloggerHistory = ref([]);

const cards = ref(/** @type {import("../lib/cardArchiveApi.js").ArchiveCard[]} */ ([]));
const loading = ref(false);
const saving = ref(false);
const error = ref("");
const okMsg = ref("");

let cacheReady = false;

function newLid() {
  return `r-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 7)}`;
}

function nowLocalDatetime() {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${hh}:${mm}`;
}

/** @returns {DraftRow} */
function emptyRow(partial = {}) {
  return {
    lid: newLid(),
    blogger: "",
    symbol: "",
    direction: "多",
    signalAt: nowLocalDatetime(),
    entry: "",
    stopLoss: "",
    takeProfit: "",
    note: "",
    editCardId: null,
    ...partial,
  };
}

/** @param {string | null | undefined} iso */
function toLocalDatetimeInput(iso) {
  if (!iso) return nowLocalDatetime();
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) {
    const s = String(iso);
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return s.slice(0, 16);
    if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return `${s}T12:00`;
    return nowLocalDatetime();
  }
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  return `${y}-${m}-${day}T${hh}:${mm}`;
}

/**
 * @param {string} raw
 * @returns {{ key: string, alias: string, label: string }}
 */
function parseBloggerLabel(raw) {
  const s = String(raw ?? "").trim();
  const pipe = s.indexOf("|");
  if (pipe >= 0) {
    const key = s.slice(0, pipe).trim();
    const alias = s.slice(pipe + 1).trim() || key;
    return { key, alias, label: key && alias !== key ? `${key}|${alias}` : key || alias };
  }
  return { key: s, alias: s, label: s };
}

/** @param {import("../lib/cardArchiveApi.js").ArchiveCard} c */
function cardBloggerInput(c) {
  const parsed = c.parsedJson && typeof c.parsedJson === "object" ? c.parsedJson : {};
  const key = String(parsed.bloggerKey ?? "").trim();
  const alias = String(c.channelName || parsed.bloggerAlias || parsed.channelName || "").trim();
  if (key && alias && key !== alias) return `${key}|${alias}`;
  if (key) return alias && alias !== key ? `${key}|${alias}` : key;
  const cid = String(c.channelId || "")
    .replace(/^manual-/i, "")
    .trim();
  if (cid && alias && cid.toLowerCase() !== alias.toLowerCase()) return `${cid}|${alias}`;
  return alias || cid || "";
}

/** @param {DraftRow} row */
function isRowBlank(row) {
  const fields = [row.blogger, row.symbol, row.entry, row.stopLoss, row.takeProfit, row.note];
  const hasContent = fields.some((x) => String(x ?? "").trim());
  // 仅默认方向+默认时间、无其它内容 → 空行
  return !hasContent;
}

/** @param {DraftRow} row */
function isRowComplete(row) {
  return Boolean(String(row.blogger).trim() && String(row.symbol).trim() && String(row.signalAt).trim());
}

/** @param {DraftRow} row */
function isRowPartial(row) {
  return !isRowBlank(row) && !isRowComplete(row);
}

const bloggerOptions = computed(() => {
  /** @type {Map<string, { key: string, alias: string, label: string }>} */
  const map = new Map();
  for (const b of bloggerHistory.value) {
    if (!b?.key) continue;
    map.set(b.key.toLowerCase(), b);
  }
  for (const c of cards.value) {
    const label = cardBloggerInput(c);
    if (!label) continue;
    const parsed = parseBloggerLabel(label);
    if (!parsed.key) continue;
    const k = parsed.key.toLowerCase();
    if (!map.has(k) || (parsed.alias && parsed.alias !== parsed.key)) {
      map.set(k, parsed);
    }
  }
  for (const r of draftRows.value) {
    const parsed = parseBloggerLabel(r.blogger);
    if (!parsed.key) continue;
    const k = parsed.key.toLowerCase();
    if (!map.has(k) || (parsed.alias && parsed.alias !== parsed.key)) {
      map.set(k, parsed);
    }
  }
  return [...map.values()].sort((a, b) => a.alias.localeCompare(b.alias, "zh"));
});

const filteredCards = computed(() => {
  const q = filterBlogger.value.trim().toLowerCase();
  if (!q) return cards.value;
  return cards.value.filter((c) => {
    const name = String(c.channelName ?? "").toLowerCase();
    const id = String(c.channelId ?? "").toLowerCase();
    const key = String(c.parsedJson?.bloggerKey ?? "").toLowerCase();
    return name.includes(q) || id.includes(q) || key.includes(q);
  });
});

const summary = computed(() => {
  let wins = 0;
  let losses = 0;
  let sum = 0;
  let n = 0;
  for (const c of filteredCards.value) {
    const pct = resolveCardPnlPct(c);
    if (pct == null || !Number.isFinite(pct)) continue;
    sum += pct;
    n += 1;
    if (pct > 0) wins += 1;
    else if (pct < 0) losses += 1;
  }
  return { wins, losses, sum, n, avg: n ? sum / n : null };
});

const draftStats = computed(() => {
  const blank = draftRows.value.filter(isRowBlank).length;
  const complete = draftRows.value.filter(isRowComplete).length;
  const partial = draftRows.value.filter(isRowPartial).length;
  return { blank, complete, partial, total: draftRows.value.length };
});

function loadCaches() {
  try {
    const raw = localStorage.getItem(DRAFT_CACHE_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list) && list.length) {
        draftRows.value = list.map((r) =>
          emptyRow({
            lid: String(r.lid || newLid()),
            blogger: String(r.blogger ?? ""),
            symbol: String(r.symbol ?? ""),
            direction: r.direction === "空" ? "空" : "多",
            signalAt: String(r.signalAt || nowLocalDatetime()).slice(0, 16),
            entry: String(r.entry ?? ""),
            stopLoss: String(r.stopLoss ?? ""),
            takeProfit: String(r.takeProfit ?? ""),
            note: String(r.note ?? ""),
            editCardId: r.editCardId != null ? Number(r.editCardId) : null,
          })
        );
      }
    }
  } catch {
    /* ignore */
  }
  if (!draftRows.value.length) draftRows.value = [emptyRow()];

  try {
    const raw = localStorage.getItem(BLOGGER_CACHE_KEY);
    if (raw) {
      const list = JSON.parse(raw);
      if (Array.isArray(list)) {
        bloggerHistory.value = list
          .map((x) => {
            if (typeof x === "string") return parseBloggerLabel(x);
            const key = String(x?.key ?? "").trim();
            const alias = String(x?.alias ?? x?.key ?? "").trim();
            if (!key) return null;
            return {
              key,
              alias: alias || key,
              label: alias && alias !== key ? `${key}|${alias}` : key,
            };
          })
          .filter(Boolean);
      }
    }
  } catch {
    /* ignore */
  }

  try {
    const raw = localStorage.getItem(FILTER_CACHE_KEY);
    if (raw) {
      const j = JSON.parse(raw);
      if (j.fromDate != null) fromDate.value = String(j.fromDate);
      if (j.toDate != null) toDate.value = String(j.toDate);
      if (j.filterBlogger != null) filterBlogger.value = String(j.filterBlogger);
      if (typeof j.autoLiquidate === "boolean") autoLiquidate.value = j.autoLiquidate;
    }
  } catch {
    /* ignore */
  }
}

function saveDraftCache() {
  if (!cacheReady) return;
  try {
    localStorage.setItem(DRAFT_CACHE_KEY, JSON.stringify(draftRows.value));
  } catch {
    /* ignore */
  }
}

function saveFilterCache() {
  if (!cacheReady) return;
  try {
    localStorage.setItem(
      FILTER_CACHE_KEY,
      JSON.stringify({
        fromDate: fromDate.value,
        toDate: toDate.value,
        filterBlogger: filterBlogger.value,
        autoLiquidate: autoLiquidate.value,
      })
    );
  } catch {
    /* ignore */
  }
}

function saveBloggerHistory() {
  try {
    localStorage.setItem(BLOGGER_CACHE_KEY, JSON.stringify(bloggerHistory.value.slice(0, 80)));
  } catch {
    /* ignore */
  }
}

/** @param {string} raw */
function rememberBlogger(raw) {
  const parsed = parseBloggerLabel(raw);
  if (!parsed.key) return;
  const k = parsed.key.toLowerCase();
  bloggerHistory.value = [
    parsed,
    ...bloggerHistory.value.filter((b) => b.key.toLowerCase() !== k),
  ].slice(0, 80);
  saveBloggerHistory();
}

function addEmptyRow(afterIndex = -1) {
  const row = emptyRow();
  // 继承上一行博主，方便连续录入同一博主
  const prev =
    afterIndex >= 0
      ? draftRows.value[afterIndex]
      : draftRows.value[draftRows.value.length - 1];
  if (prev?.blogger) row.blogger = prev.blogger;
  if (prev?.direction) row.direction = prev.direction;
  if (afterIndex >= 0 && afterIndex < draftRows.value.length - 1) {
    draftRows.value.splice(afterIndex + 1, 0, row);
  } else {
    draftRows.value.push(row);
  }
  return row;
}

/** @param {number} index */
function removeRow(index) {
  if (draftRows.value.length <= 1) {
    draftRows.value = [emptyRow()];
    return;
  }
  draftRows.value.splice(index, 1);
}

/**
 * @param {KeyboardEvent} e
 * @param {number} rowIndex
 * @param {string} field
 */
function onCellKeydown(e, rowIndex, field) {
  if (e.key !== "Enter" || e.isComposing) return;
  e.preventDefault();
  const isLast = rowIndex === draftRows.value.length - 1;
  if (isLast) {
    const row = addEmptyRow(rowIndex);
    void nextTick(() => {
      const el = document.querySelector(
        `[data-draft-lid="${row.lid}"][data-field="blogger"]`
      );
      if (el instanceof HTMLElement) el.focus();
    });
  } else {
    // 跳到下一行同列
    const next = draftRows.value[rowIndex + 1];
    void nextTick(() => {
      const el = document.querySelector(
        `[data-draft-lid="${next.lid}"][data-field="${field}"]`
      );
      if (el instanceof HTMLElement) el.focus();
    });
  }
}

/** @param {DraftRow} row */
function rowToBody(row) {
  const targets = String(row.takeProfit || "")
    .split(/[,/，\s]+/)
    .map((x) => x.trim())
    .filter(Boolean);
  return {
    bloggerName: row.blogger.trim(),
    symbol: row.symbol.trim(),
    direction: row.direction,
    date: row.signalAt,
    signalAt: row.signalAt,
    entry: row.entry.trim() || undefined,
    stopLoss: row.stopLoss.trim() || undefined,
    targets,
    note: row.note.trim() || undefined,
    liquidate: autoLiquidate.value,
  };
}

async function onArchive() {
  error.value = "";
  okMsg.value = "";

  const complete = draftRows.value.filter(isRowComplete);
  const partial = draftRows.value.filter(isRowPartial);
  const blank = draftRows.value.filter(isRowBlank);

  if (!complete.length && !partial.length) {
    error.value = "没有可归档的条目，请先填写博主、币种与时间";
    return;
  }

  if (partial.length) {
    const ok = confirm(
      `有 ${partial.length} 条不完整（缺博主/币种/时间），将跳过；完整 ${complete.length} 条将归档。是否继续？`
    );
    if (!ok) return;
  } else if (!complete.length) {
    error.value = "没有完整条目可归档";
    return;
  }

  saving.value = true;
  let okCount = 0;
  let failCount = 0;
  /** @type {string[]} */
  const failMsgs = [];

  try {
    for (const row of complete) {
      rememberBlogger(row.blogger);
      try {
        const body = rowToBody(row);
        if (row.editCardId) {
          await updateManualStatsCard(row.editCardId, body);
        } else {
          await createManualStatsCard(body);
        }
        okCount += 1;
      } catch (e) {
        failCount += 1;
        failMsgs.push(`${row.symbol || "?"}：${/** @type {Error} */ (e).message ?? e}`);
      }
    }

    // 保留未归档的不完整行 + 一条空行
    const keep = draftRows.value.filter(isRowPartial);
    draftRows.value = keep.length ? [...keep, emptyRow({ blogger: keep[0]?.blogger || "" })] : [emptyRow()];
    if (complete.some((r) => r.blogger)) {
      const lastBlogger = complete[complete.length - 1]?.blogger || "";
      if (lastBlogger && draftRows.value[0] && !draftRows.value[0].blogger) {
        draftRows.value[0].blogger = lastBlogger;
      }
    }
    saveDraftCache();
    await loadList();

    const skipNote =
      blank.length || partial.length
        ? ` · 跳过空行 ${blank.length} / 不完整 ${partial.length}`
        : "";
    okMsg.value = `已归档 ${okCount} 条${failCount ? ` · 失败 ${failCount}` : ""}${skipNote}`;
    if (failMsgs.length) error.value = failMsgs.slice(0, 3).join("；");
  } finally {
    saving.value = false;
  }
}

/** @param {import("../lib/cardArchiveApi.js").ArchiveCard} c */
function startEdit(c) {
  const row = emptyRow({
    blogger: cardBloggerInput(c),
    symbol: String(c.symbol || c.execution?.symbol || "").trim(),
    direction: /空|short/i.test(String(c.execution?.direction || "")) ? "空" : "多",
    signalAt: toLocalDatetimeInput(c.signalAt || c.createdAt || ""),
    entry: String(c.execution?.planned?.entryPrice || "").trim(),
    stopLoss: String(c.execution?.planned?.stopLossPrice || "").trim(),
    takeProfit: (c.execution?.planned?.takeProfitPrices || []).join(", "),
    note: String(c.note || "").trim(),
    editCardId: Number(c.id),
  });
  // 放到表格顶部，方便改完再归档
  draftRows.value = [row, ...draftRows.value.filter((r) => !isRowBlank(r) || r.editCardId)];
  okMsg.value = `已载入编辑 #${c.id}，改完点「归档」保存`;
  error.value = "";
  void nextTick(() => {
    const el = document.querySelector(`[data-draft-lid="${row.lid}"][data-field="blogger"]`);
    if (el instanceof HTMLElement) el.focus();
  });
}

async function loadList() {
  loading.value = true;
  error.value = "";
  try {
    /** @type {{ onlySources: string[], limit: number, days?: number, from?: string, to?: string }} */
    const opts = { onlySources: ["manual"], limit: 500 };
    if (fromDate.value) opts.from = fromDate.value;
    if (toDate.value) opts.to = `${toDate.value}T23:59:59.999+08:00`;
    if (!fromDate.value && !toDate.value) opts.days = 3650;
    const res = await fetchArchiveCards(opts);
    cards.value = (res.cards || []).filter((c) => {
      const st = String(c.sourceType || "").toLowerCase();
      return st === "manual" || st.endsWith(":manual");
    });
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  } finally {
    loading.value = false;
  }
}

/** @param {import("../lib/cardArchiveApi.js").ArchiveCard} c */
function cardDateTimeText(c) {
  const raw = c.signalAt || c.createdAt || "";
  const d = new Date(raw);
  if (Number.isNaN(d.getTime())) return String(raw).slice(0, 16) || "—";
  return d.toLocaleString("zh-CN", { hour12: false });
}

/** @param {import("../lib/cardArchiveApi.js").ArchiveCard} c */
function pnlText(c) {
  const pct = resolveCardPnlPct(c);
  if (pct == null || !Number.isFinite(pct)) return "—";
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(2)}%`;
}

/** @param {import("../lib/cardArchiveApi.js").ArchiveCard} c */
function outcomeText(c) {
  const o = c.execution?.outcome;
  return o ? outcomeLabel(o) : "—";
}

/** @param {import("../lib/cardArchiveApi.js").ArchiveCard} c */
async function onDelete(c) {
  if (!confirm(`删除手动统计 #${c.id}（${c.channelName} ${c.symbol}）？`)) return;
  error.value = "";
  try {
    await deleteArchiveCard(Number(c.id));
    draftRows.value = draftRows.value.map((r) =>
      r.editCardId === Number(c.id) ? emptyRow({ blogger: r.blogger }) : r
    );
    await loadList();
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  }
}

/** @param {import("../lib/cardArchiveApi.js").ArchiveCard} c */
async function onReliquidate(c) {
  error.value = "";
  try {
    await liquidateArchiveCards({ cardIds: [Number(c.id)] });
    await loadList();
    okMsg.value = `已重新清算 #${c.id}`;
  } catch (e) {
    error.value = String(/** @type {Error} */ (e).message ?? e);
  }
}

watch(draftRows, () => saveDraftCache(), { deep: true });
watch([fromDate, toDate, filterBlogger, autoLiquidate], () => saveFilterCache());

onMounted(() => {
  loadCaches();
  cacheReady = true;
  void loadList();
});
</script>

<template>
  <div class="manual-stats">
    <header class="head">
      <div>
        <h1>手动统计</h1>
        <p>
          表格多行录入：回车新增空行；归档时跳过空行，不完整行会提示。博主格式
          <code>标识|别名</code>；入场价留空按市价清算。可在
          <RouterLink to="/cards">卡片</RouterLink> /
          <RouterLink to="/eval">评估</RouterLink>
          筛选。
        </p>
      </div>
      <RouterLink class="link-back" to="/local">← Local</RouterLink>
    </header>

    <section class="panel">
      <div class="list-head">
        <h2>录入表</h2>
        <div class="filters">
          <label class="check inline">
            <input v-model="autoLiquidate" type="checkbox" />
            归档后自动清算
          </label>
          <button type="button" class="btn" @click="addEmptyRow()">+ 行</button>
          <button type="button" class="btn primary" :disabled="saving" @click="onArchive">
            {{ saving ? "归档中…" : `归档（${draftStats.complete}）` }}
          </button>
        </div>
      </div>
      <p class="summary muted">
        共 {{ draftStats.total }} 行 · 完整 {{ draftStats.complete }} · 不完整
        {{ draftStats.partial }} · 空 {{ draftStats.blank }}（入场可空=市价）
      </p>

      <div class="table-wrap draft-wrap">
        <table class="draft-table">
          <thead>
            <tr>
              <th class="col-blogger">博主 标识|别名</th>
              <th class="col-sym">币种</th>
              <th class="col-dir">方向</th>
              <th class="col-time">日期时间</th>
              <th class="col-px">入场</th>
              <th class="col-px">止损</th>
              <th class="col-tp">止盈</th>
              <th class="col-note">备注</th>
              <th class="col-ops"></th>
            </tr>
          </thead>
          <tbody>
            <tr
              v-for="(row, idx) in draftRows"
              :key="row.lid"
              :class="{
                partial: isRowPartial(row),
                editing: row.editCardId,
              }"
            >
              <td>
                <input
                  v-model="row.blogger"
                  type="text"
                  list="manual-blogger-list"
                  placeholder="thankUcrypto|熬鹰"
                  :data-draft-lid="row.lid"
                  data-field="blogger"
                  @keydown="onCellKeydown($event, idx, 'blogger')"
                />
              </td>
              <td>
                <input
                  v-model="row.symbol"
                  type="text"
                  list="manual-symbol-list"
                  placeholder="BTC"
                  :data-draft-lid="row.lid"
                  data-field="symbol"
                  @keydown="onCellKeydown($event, idx, 'symbol')"
                />
              </td>
              <td>
                <select
                  v-model="row.direction"
                  :data-draft-lid="row.lid"
                  data-field="direction"
                  @keydown="onCellKeydown($event, idx, 'direction')"
                >
                  <option value="多">多</option>
                  <option value="空">空</option>
                </select>
              </td>
              <td>
                <input
                  v-model="row.signalAt"
                  type="datetime-local"
                  step="60"
                  :data-draft-lid="row.lid"
                  data-field="signalAt"
                  @keydown="onCellKeydown($event, idx, 'signalAt')"
                />
              </td>
              <td>
                <input
                  v-model="row.entry"
                  type="text"
                  placeholder="市价"
                  :data-draft-lid="row.lid"
                  data-field="entry"
                  @keydown="onCellKeydown($event, idx, 'entry')"
                />
              </td>
              <td>
                <input
                  v-model="row.stopLoss"
                  type="text"
                  :data-draft-lid="row.lid"
                  data-field="stopLoss"
                  @keydown="onCellKeydown($event, idx, 'stopLoss')"
                />
              </td>
              <td>
                <input
                  v-model="row.takeProfit"
                  type="text"
                  placeholder="70000,72000"
                  :data-draft-lid="row.lid"
                  data-field="takeProfit"
                  @keydown="onCellKeydown($event, idx, 'takeProfit')"
                />
              </td>
              <td>
                <input
                  v-model="row.note"
                  type="text"
                  :data-draft-lid="row.lid"
                  data-field="note"
                  @keydown="onCellKeydown($event, idx, 'note')"
                />
              </td>
              <td class="ops">
                <span v-if="row.editCardId" class="edit-tag">#{{ row.editCardId }}</span>
                <button type="button" class="btn tiny danger" title="删行" @click="removeRow(idx)">
                  ×
                </button>
              </td>
            </tr>
          </tbody>
        </table>
      </div>

      <datalist id="manual-blogger-list">
        <option v-for="b in bloggerOptions" :key="b.key" :value="b.label">
          {{ b.alias }}（{{ b.key }}）
        </option>
      </datalist>
      <datalist id="manual-symbol-list">
        <option value="BTC" />
        <option value="ETH" />
        <option value="SOL" />
      </datalist>

      <p v-if="error" class="err">{{ error }}</p>
      <p v-if="okMsg" class="ok">{{ okMsg }}</p>
    </section>

    <section class="panel">
      <div class="list-head">
        <h2>已归档</h2>
        <div class="filters">
          <input v-model="fromDate" type="date" title="起始" />
          <span class="muted">→</span>
          <input v-model="toDate" type="date" title="结束" />
          <input v-model="filterBlogger" type="text" placeholder="筛博主" class="filter-blogger" />
          <button type="button" class="btn" :disabled="loading" @click="loadList">
            {{ loading ? "加载中…" : "刷新" }}
          </button>
        </div>
      </div>
      <p class="summary">
        共 {{ filteredCards.length }} 条
        <template v-if="summary.n">
          · 已结算 {{ summary.n }} · 盈 {{ summary.wins }} / 亏 {{ summary.losses }}
          · 合计 {{ summary.sum > 0 ? "+" : "" }}{{ summary.sum.toFixed(2) }}%
          · 均
          {{
            summary.avg != null
              ? `${summary.avg > 0 ? "+" : ""}${summary.avg.toFixed(2)}%`
              : "—"
          }}
        </template>
      </p>
      <div class="table-wrap">
        <table>
          <thead>
            <tr>
              <th>时间</th>
              <th>博主</th>
              <th>币种</th>
              <th>方向</th>
              <th>结果</th>
              <th>盈亏</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="c in filteredCards" :key="c.id">
              <td>{{ cardDateTimeText(c) }}</td>
              <td>
                <div class="blogger">{{ c.channelName || "—" }}</div>
                <div class="muted tiny">{{ c.parsedJson?.bloggerKey || c.channelId }}</div>
              </td>
              <td>{{ c.symbol || "—" }}</td>
              <td>{{ c.execution?.direction || "—" }}</td>
              <td>{{ outcomeText(c) }}</td>
              <td
                :class="{
                  up: (resolveCardPnlPct(c) ?? 0) > 0,
                  down: (resolveCardPnlPct(c) ?? 0) < 0,
                }"
              >
                {{ pnlText(c) }}
              </td>
              <td class="ops">
                <button type="button" class="btn tiny" @click="startEdit(c)">改</button>
                <button type="button" class="btn tiny" @click="onReliquidate(c)">清算</button>
                <button type="button" class="btn tiny danger" @click="onDelete(c)">删</button>
              </td>
            </tr>
            <tr v-if="!loading && !filteredCards.length">
              <td colspan="7" class="empty">暂无已归档条目</td>
            </tr>
          </tbody>
        </table>
      </div>
    </section>
  </div>
</template>

<style scoped>
.manual-stats {
  max-width: 1100px;
  margin: 0 auto;
  padding: 1.25rem 1.5rem 3rem;
  color: #dbdee1;
}
.head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 1.25rem;
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
a {
  color: #00a8fc;
}
.link-back {
  flex-shrink: 0;
  color: #949ba4;
  text-decoration: none;
  font-size: 0.9rem;
}
.link-back:hover {
  color: #fff;
}
.panel {
  background: #2b2d31;
  border: 1px solid #3f4147;
  border-radius: 12px;
  padding: 1.15rem 1.25rem;
  margin-bottom: 1rem;
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
  gap: 0.4rem;
}
.filter-blogger {
  width: 7.5rem;
}
.summary {
  margin: 0.65rem 0 0.85rem;
  font-size: 0.85rem;
}
.muted {
  color: #949ba4;
}
.tiny {
  font-size: 0.72rem;
}
.check.inline {
  display: flex;
  flex-direction: row;
  align-items: center;
  gap: 0.35rem;
  font-size: 0.8rem;
  color: #b5bac1;
  margin-right: 0.5rem;
}
.btn {
  border: 1px solid #3f4147;
  background: #1e1f22;
  color: #dbdee1;
  border-radius: 8px;
  padding: 0.45rem 0.85rem;
  font-weight: 600;
  cursor: pointer;
  font-size: 0.85rem;
}
.btn:hover:not(:disabled) {
  border-color: #5865f2;
  color: #fff;
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
  padding: 0.15rem 0.4rem;
  font-size: 0.75rem;
  font-weight: 500;
}
.btn.danger:hover:not(:disabled) {
  border-color: #ed4245;
  color: #ed4245;
}
.err {
  color: #ed4245;
  margin-top: 0.75rem;
}
.ok {
  color: #3ba55d;
  margin-top: 0.75rem;
}
.table-wrap {
  overflow-x: auto;
}
.draft-wrap {
  border: 1px solid #3f4147;
  border-radius: 8px;
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
  border-bottom: 1px solid #3f4147;
  vertical-align: middle;
}
th {
  color: #949ba4;
  font-weight: 600;
  white-space: nowrap;
  background: #1e1f22;
  position: sticky;
  top: 0;
  z-index: 1;
}
.draft-table td {
  padding: 0.25rem;
}
.draft-table input,
.draft-table select {
  width: 100%;
  box-sizing: border-box;
  background: #1e1f22;
  border: 1px solid transparent;
  border-radius: 6px;
  color: #f2f3f5;
  padding: 0.4rem 0.45rem;
  font-size: 0.85rem;
}
.draft-table input:focus,
.draft-table select:focus {
  border-color: #5865f2;
  outline: none;
}
.draft-table tr.partial td {
  background: rgba(237, 66, 69, 0.08);
}
.draft-table tr.editing td {
  background: rgba(88, 101, 242, 0.1);
}
.col-blogger {
  min-width: 10rem;
}
.col-sym {
  min-width: 4.5rem;
}
.col-dir {
  min-width: 3.5rem;
}
.col-time {
  min-width: 11rem;
}
.col-px {
  min-width: 4.5rem;
}
.col-tp {
  min-width: 7rem;
}
.col-note {
  min-width: 5rem;
}
.col-ops {
  width: 3.5rem;
}
.ops {
  white-space: nowrap;
  display: flex;
  gap: 0.25rem;
  align-items: center;
}
.edit-tag {
  font-size: 0.7rem;
  color: #5865f2;
}
.blogger {
  color: #f2f3f5;
}
.up {
  color: #3ba55d;
  font-weight: 600;
}
.down {
  color: #ed4245;
  font-weight: 600;
}
.empty {
  text-align: center;
  color: #949ba4;
  padding: 1.5rem !important;
}
</style>
