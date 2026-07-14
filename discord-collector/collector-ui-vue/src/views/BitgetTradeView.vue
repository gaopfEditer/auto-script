<script setup>
import { ref, computed, watch, onMounted } from "vue";
import { RouterLink } from "vue-router";
import {
  fetchBitgetPreview,
  fetchBitgetOrders,
  fetchBitgetStatus,
  placeBitgetOrder,
} from "../lib/bitgetApi.js";

defineOptions({ name: "BitgetTradeView" });

const symbolInput = ref("");
const side = ref(/** @type {"buy"|"sell"} */ ("buy"));
const orderType = ref(/** @type {"market"|"limit"} */ ("market"));
const limitPrice = ref("");
const stopLoss = ref("");
const takeProfit = ref("");

const preview = ref(/** @type {Record<string, unknown> | null} */ (null));
const previewLoading = ref(false);
const previewError = ref("");

const status = ref(/** @type {Record<string, unknown> | null} */ (null));
const submitting = ref(false);
const submitResult = ref("");
const submitOk = ref(/** @type {boolean | null} */ (null));

const historyLoading = ref(false);
const historyTab = ref(/** @type {"local"|"exchange"|"all"} */ ("all"));
const localOrders = ref(/** @type {Record<string, unknown>[]} */ ([]));
const exchangeOrders = ref(/** @type {Record<string, unknown>[]} */ ([]));
const historyFilter = ref("");

const leverageInput = ref(30);
const orderSizeInput = ref(1);
const lastAppliedSymbol = ref("");

let previewTimer = 0;

const tierLabel = computed(() => String(preview.value?.tierLabel ?? "—"));
const lastPrice = computed(() => preview.value?.lastPrice);
const estimatedSize = computed(() => preview.value?.estimatedSize);
const positionNotionalUsdt = computed(() => {
  const v = Number(preview.value?.positionNotionalUsdt);
  return Number.isFinite(v) ? v.toFixed(2) : null;
});
const dryRun = computed(() => Boolean(preview.value?.dryRun ?? status.value?.dryRun));
const configured = computed(() => Boolean(preview.value?.configured ?? status.value?.configured));
const defaultLeverageHint = computed(() => Number(preview.value?.defaultLeverage ?? status.value?.altcoinLeverage ?? 30));
const defaultOrderSizeHint = computed(() => Number(preview.value?.defaultOrderSizeUsdt ?? status.value?.orderSizeUsdt ?? 1));

const mergedHistory = computed(() => {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  if (historyTab.value === "local" || historyTab.value === "all") {
    for (const r of localOrders.value) {
      rows.push({ ...r, _source: "local" });
    }
  }
  if (historyTab.value === "exchange" || historyTab.value === "all") {
    for (const r of exchangeOrders.value) {
      rows.push({
        id: r.orderId ?? r.clientOid ?? `ex-${r.cTime ?? Date.now()}`,
        at: r.cTime ? new Date(Number(r.cTime)).toISOString() : r.updateTime,
        symbol: r.symbol,
        side: r.side,
        orderType: r.orderType,
        size: r.size,
        price: r.priceAvg ?? r.price,
        status: r.state ?? r.status,
        leverage: r.leverage,
        _source: "exchange",
        raw: r,
      });
    }
  }
  const q = historyFilter.value.trim().toUpperCase();
  const filtered = q
    ? rows.filter((r) => String(r.symbol ?? "").toUpperCase().includes(q))
    : rows;
  return filtered.sort((a, b) => {
    const ta = new Date(String(a.at ?? 0)).getTime();
    const tb = new Date(String(b.at ?? 0)).getTime();
    return tb - ta;
  });
});

/** @param {unknown} v */
function fmtTime(v) {
  if (!v) return "—";
  const d = new Date(String(v));
  return Number.isNaN(d.getTime()) ? String(v) : d.toLocaleString("zh-CN", { hour12: false });
}

/** @param {unknown} sideVal */
function sideLabel(sideVal) {
  const s = String(sideVal ?? "").toLowerCase();
  if (s === "sell") return "做空";
  if (s === "buy") return "做多";
  return String(sideVal ?? "—");
}

/** @param {unknown} st */
function statusClass(st) {
  const s = String(st ?? "").toLowerCase();
  if (s.includes("fail") || s === "cancelled") return "bad";
  if (s.includes("dry")) return "warn";
  if (s.includes("place") || s.includes("filled") || s === "live") return "good";
  return "";
}

async function loadStatus() {
  try {
    status.value = await fetchBitgetStatus();
  } catch {
    status.value = null;
  }
}

async function refreshPreview(resetDefaults = false) {
  const sym = symbolInput.value.trim();
  if (!sym) {
    preview.value = null;
    previewError.value = "";
    lastAppliedSymbol.value = "";
    return;
  }
  previewLoading.value = true;
  previewError.value = "";
  try {
    let data = await fetchBitgetPreview(sym);
    if (!data.ok) {
      preview.value = null;
      previewError.value = String(data.error ?? "预览失败");
      return;
    }
    const bare = String(data.bareSymbol ?? sym).toUpperCase();
    if (data.bareSymbol && symbolInput.value.trim().toUpperCase() !== bare) {
      symbolInput.value = bare;
    }
    if (resetDefaults || bare !== lastAppliedSymbol.value) {
      lastAppliedSymbol.value = bare;
      leverageInput.value = Number(data.defaultLeverage ?? data.leverage ?? 30);
      orderSizeInput.value = Number(data.defaultOrderSizeUsdt ?? data.orderSizeUsdt ?? 1);
    }
    data = await fetchBitgetPreview(bare || sym, {
      orderSizeUsdt: orderSizeInput.value,
      leverage: leverageInput.value,
    });
    if (!data.ok) {
      preview.value = null;
      previewError.value = String(data.error ?? "预览失败");
      return;
    }
    preview.value = data;
  } catch (e) {
    previewError.value = e instanceof Error ? e.message : String(e);
    preview.value = null;
  } finally {
    previewLoading.value = false;
  }
}

function resetTradeDefaults() {
  void refreshPreview(true);
}

function schedulePreview(resetDefaults = false) {
  clearTimeout(previewTimer);
  previewTimer = window.setTimeout(() => void refreshPreview(resetDefaults), 350);
}

async function loadHistory() {
  historyLoading.value = true;
  try {
    const data = await fetchBitgetOrders({ limit: 80, symbol: historyFilter.value.trim() || undefined });
    if (data.ok) {
      localOrders.value = data.local ?? [];
      exchangeOrders.value = data.exchange ?? [];
    }
  } catch {
    localOrders.value = [];
    exchangeOrders.value = [];
  } finally {
    historyLoading.value = false;
  }
}

async function submitOrder() {
  const sym = symbolInput.value.trim();
  if (!sym) {
    submitOk.value = false;
    submitResult.value = "请输入币种";
    return;
  }
  submitting.value = true;
  submitOk.value = null;
  submitResult.value = "";
  try {
    const body = {
      symbol: sym,
      side: side.value,
      orderType: orderType.value,
      orderSizeUsdt: orderSizeInput.value,
      leverage: leverageInput.value,
    };
    if (orderType.value === "limit" && limitPrice.value.trim()) {
      body.price = limitPrice.value.trim();
    }
    if (stopLoss.value.trim()) body.stopLossPrice = stopLoss.value.trim();
    if (takeProfit.value.trim()) body.takeProfitPrice = takeProfit.value.trim();

    const data = await placeBitgetOrder(body);
    if (data.ok) {
      submitOk.value = true;
      submitResult.value = data.dryRun
        ? `模拟下单成功（dry-run）· ${String(data.record?.symbol ?? sym)} ${sideLabel(data.record?.side ?? side.value)}`
        : `下单成功 · orderId=${data.record?.orderId ?? "—"}`;
      await loadHistory();
    } else {
      submitOk.value = false;
      submitResult.value = [data.error, data.hint].filter(Boolean).join("：") || "下单失败";
    }
  } catch (e) {
    submitOk.value = false;
    submitResult.value = e instanceof Error ? e.message : String(e);
  } finally {
    submitting.value = false;
  }
}

watch(symbolInput, () => schedulePreview(true));

watch([leverageInput, orderSizeInput], () => {
  if (lastAppliedSymbol.value) schedulePreview(false);
});

onMounted(async () => {
  await loadStatus();
  await loadHistory();
});
</script>

<template>
  <div class="trade-page">
    <header class="trade-head">
      <div>
        <h1>Bitget 下单</h1>
        <p class="sub">
          输入币种自动匹配杠杆与金额 ·
          <span v-if="dryRun" class="pill warn">Dry-run 模拟</span>
          <span v-else class="pill good">实盘</span>
          <span v-if="!configured" class="pill bad">API 未配置</span>
        </p>
      </div>
      <div class="head-links">
        <RouterLink to="/" class="link">首页</RouterLink>
        <RouterLink to="/debug" class="link">Debug</RouterLink>
        <button type="button" class="btn ghost" :disabled="historyLoading" @click="loadHistory">
          {{ historyLoading ? "刷新中…" : "刷新历史" }}
        </button>
      </div>
    </header>

    <div class="trade-grid">
      <section class="panel form-panel">
        <h2>下单</h2>

        <label class="field">
          <span>币种</span>
          <input
            v-model="symbolInput"
            type="text"
            placeholder="BTC / ETH / XPIN / DOGE …"
            spellcheck="false"
            autocomplete="off"
          />
        </label>

        <div v-if="previewLoading" class="hint">正在获取行情与参数…</div>
        <div v-else-if="previewError" class="hint err">{{ previewError }}</div>

        <div v-if="preview?.ok" class="auto-box">
          <div class="auto-row">
            <span class="lbl">合约</span>
            <strong>{{ preview.symbol }}</strong>
          </div>
          <div class="auto-row">
            <span class="lbl">分类</span>
            <span>{{ tierLabel }}</span>
          </div>
          <div v-if="lastPrice" class="auto-row">
            <span class="lbl">最新价</span>
            <span>{{ lastPrice }}</span>
          </div>
          <div v-if="estimatedSize" class="auto-row">
            <span class="lbl">预估数量</span>
            <span>{{ estimatedSize }}</span>
          </div>
          <div v-if="positionNotionalUsdt" class="auto-row">
            <span class="lbl">仓位名义</span>
            <span>≈ {{ positionNotionalUsdt }} USDT（保证金 × 杠杆）</span>
          </div>
          <div v-if="preview.minTradeUsdt" class="auto-row">
            <span class="lbl">最小名义</span>
            <span>{{ preview.minTradeUsdt }} USDT</span>
          </div>
          <p v-if="preview.sizeWarning" class="size-warn">{{ preview.sizeWarning }}</p>
        </div>

        <div class="field-row">
          <label class="field">
            <span>杠杆 (x)</span>
            <input
              v-model.number="leverageInput"
              type="number"
              min="1"
              max="150"
              step="1"
              inputmode="numeric"
            />
            <span class="field-hint">默认 {{ defaultLeverageHint }}x</span>
          </label>
          <label class="field">
            <span>保证金 (USDT)</span>
            <input
              v-model.number="orderSizeInput"
              type="number"
              min="0.01"
              step="0.01"
              inputmode="decimal"
            />
            <span class="field-hint">默认 {{ defaultOrderSizeHint }} USDT，与 Bitget App 一致</span>
          </label>
        </div>

        <button type="button" class="btn ghost reset-defaults" @click="resetTradeDefaults">
          恢复默认杠杆/金额
        </button>

        <div class="field-row">
          <label class="field">
            <span>方向</span>
            <select v-model="side">
              <option value="buy">做多</option>
              <option value="sell">做空</option>
            </select>
          </label>
          <label class="field">
            <span>类型</span>
            <select v-model="orderType">
              <option value="market">市价</option>
              <option value="limit">限价</option>
            </select>
          </label>
        </div>

        <label v-if="orderType === 'limit'" class="field">
          <span>限价</span>
          <input v-model="limitPrice" type="text" inputmode="decimal" placeholder="留空则用最新价" />
        </label>

        <div class="field-row">
          <label class="field">
            <span>止损（可选）</span>
            <input v-model="stopLoss" type="text" inputmode="decimal" placeholder="presetStopLoss" />
          </label>
          <label class="field">
            <span>止盈（可选）</span>
            <input v-model="takeProfit" type="text" inputmode="decimal" placeholder="presetTakeProfit" />
          </label>
        </div>

        <button
          type="button"
          class="btn primary submit"
          :disabled="submitting || !symbolInput.trim()"
          @click="submitOrder"
        >
          {{ submitting ? "提交中…" : dryRun ? "模拟下单" : "确认下单" }}
        </button>

        <p v-if="submitResult" class="submit-result" :class="{ ok: submitOk, bad: submitOk === false }">
          {{ submitResult }}
        </p>

        <p class="footnote">
          切换币种会自动填入默认杠杆/金额；可手动修改后下单。BTC/ETH 默认 {{ status?.majorLeverage ?? 100 }}x，山寨
          {{ status?.altcoinLeverage ?? 30 }}x，保证金 {{ status?.orderSizeUsdt ?? 1 }} USDT（.env）
        </p>
      </section>

      <section class="panel history-panel">
        <div class="history-head">
          <h2>历史订单</h2>
          <div class="tabs">
            <button type="button" :class="{ active: historyTab === 'all' }" @click="historyTab = 'all'">全部</button>
            <button type="button" :class="{ active: historyTab === 'local' }" @click="historyTab = 'local'">
              本地
            </button>
            <button type="button" :class="{ active: historyTab === 'exchange' }" @click="historyTab = 'exchange'">
              交易所
            </button>
          </div>
        </div>

        <input
          v-model="historyFilter"
          class="filter-input"
          type="text"
          placeholder="按币种筛选历史…"
          @keyup.enter="loadHistory"
        />

        <div v-if="historyLoading" class="hint">加载中…</div>
        <div v-else-if="!mergedHistory.length" class="hint empty">暂无订单记录</div>

        <div v-else class="table-wrap">
          <table>
            <thead>
              <tr>
                <th>时间</th>
                <th>来源</th>
                <th>币种</th>
                <th>方向</th>
                <th>类型</th>
                <th>数量</th>
                <th>价格</th>
                <th>杠杆</th>
                <th>状态</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="row in mergedHistory" :key="String(row.id)">
                <td class="mono">{{ fmtTime(row.at) }}</td>
                <td>{{ row._source === "exchange" ? "交易所" : "本地" }}</td>
                <td>{{ String(row.symbol ?? "").replace(/USDT$/, "") }}</td>
                <td :class="String(row.side).toLowerCase() === 'sell' ? 'short' : 'long'">
                  {{ sideLabel(row.side) }}
                </td>
                <td>{{ row.orderType ?? "—" }}</td>
                <td class="mono">{{ row.size ?? "—" }}</td>
                <td class="mono">{{ row.price ?? row.fillPrice ?? "—" }}</td>
                <td>{{ row.leverage ? `${row.leverage}x` : "—" }}</td>
                <td><span class="status" :class="statusClass(row.status)">{{ row.status ?? "—" }}</span></td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>
    </div>
  </div>
</template>

<style scoped>
.trade-page {
  height: 100%;
  overflow: auto;
  padding: 1.25rem 1.5rem 2rem;
  background: #1e1f22;
  color: #dbdee1;
}
.trade-head {
  display: flex;
  justify-content: space-between;
  align-items: flex-start;
  gap: 1rem;
  margin-bottom: 1.25rem;
}
h1 {
  margin: 0;
  font-size: 1.35rem;
  color: #f2f3f5;
}
.sub {
  margin: 0.35rem 0 0;
  color: #949ba4;
  font-size: 0.88rem;
}
.head-links {
  display: flex;
  gap: 0.6rem;
  align-items: center;
}
.link {
  color: #aeb4ff;
  text-decoration: none;
  font-size: 0.85rem;
}
.trade-grid {
  display: grid;
  grid-template-columns: minmax(280px, 380px) 1fr;
  gap: 1rem;
  align-items: start;
}
@media (max-width: 960px) {
  .trade-grid {
    grid-template-columns: 1fr;
  }
}
.panel {
  background: #2b2d31;
  border: 1px solid #3f4147;
  border-radius: 12px;
  padding: 1rem 1.1rem;
}
.panel h2 {
  margin: 0 0 1rem;
  font-size: 1rem;
  color: #f2f3f5;
}
.field {
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  margin-bottom: 0.85rem;
}
.field span {
  font-size: 0.78rem;
  color: #949ba4;
  font-weight: 600;
}
.field-hint {
  font-size: 0.72rem;
  color: #72767d;
  font-weight: 400;
}
.reset-defaults {
  width: 100%;
  margin-bottom: 0.85rem;
}
.field input,
.field select,
.filter-input {
  background: #1e1f22;
  border: 1px solid #3f4147;
  border-radius: 8px;
  color: #f2f3f5;
  padding: 0.55rem 0.65rem;
  font-size: 0.92rem;
}
.field-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 0.65rem;
}
.auto-box {
  background: #1e1f22;
  border: 1px solid #3f4147;
  border-radius: 8px;
  padding: 0.65rem 0.75rem;
  margin-bottom: 0.85rem;
}
.auto-row {
  display: flex;
  justify-content: space-between;
  gap: 0.5rem;
  padding: 0.25rem 0;
  font-size: 0.88rem;
}
.auto-row .lbl {
  color: #949ba4;
}
.accent {
  color: #57f287;
}
.hint {
  color: #949ba4;
  font-size: 0.85rem;
  margin-bottom: 0.75rem;
}
.hint.err {
  color: #f38688;
}
.size-warn {
  margin: 0.5rem 0 0;
  font-size: 0.78rem;
  color: #fee75c;
  line-height: 1.45;
}
.hint.empty {
  padding: 2rem 0;
  text-align: center;
}
.btn {
  border: 1px solid #3f4147;
  background: #1e1f22;
  color: #dbdee1;
  border-radius: 8px;
  padding: 0.45rem 0.75rem;
  cursor: pointer;
  font-size: 0.85rem;
}
.btn.primary {
  background: #5865f2;
  border-color: #5865f2;
  color: #fff;
  font-weight: 700;
}
.btn.ghost {
  background: #2b2d31;
}
.btn:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.submit {
  width: 100%;
  padding: 0.7rem;
  margin-top: 0.25rem;
}
.submit-result {
  margin: 0.75rem 0 0;
  font-size: 0.88rem;
}
.submit-result.ok {
  color: #57f287;
}
.submit-result.bad {
  color: #f38688;
}
.footnote {
  margin: 1rem 0 0;
  font-size: 0.75rem;
  color: #72767d;
  line-height: 1.5;
}
.pill {
  display: inline-block;
  padding: 0.1rem 0.45rem;
  border-radius: 999px;
  font-size: 0.72rem;
  margin-left: 0.25rem;
}
.pill.warn {
  background: rgba(254, 231, 92, 0.15);
  color: #fee75c;
}
.pill.good {
  background: rgba(87, 242, 135, 0.15);
  color: #57f287;
}
.pill.bad {
  background: rgba(237, 66, 69, 0.15);
  color: #f38688;
}
.history-head {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.75rem;
  margin-bottom: 0.75rem;
}
.history-head h2 {
  margin: 0;
}
.tabs {
  display: flex;
  gap: 0.35rem;
}
.tabs button {
  border: 1px solid #3f4147;
  background: #1e1f22;
  color: #b5bac1;
  border-radius: 6px;
  padding: 0.25rem 0.55rem;
  font-size: 0.75rem;
  cursor: pointer;
}
.tabs button.active {
  background: #5865f2;
  border-color: #5865f2;
  color: #fff;
}
.filter-input {
  width: 100%;
  margin-bottom: 0.75rem;
}
.table-wrap {
  overflow: auto;
  max-height: calc(100vh - 220px);
}
table {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.8rem;
}
th,
td {
  padding: 0.45rem 0.5rem;
  border-bottom: 1px solid #3f4147;
  text-align: left;
  white-space: nowrap;
}
th {
  color: #949ba4;
  font-weight: 600;
  position: sticky;
  top: 0;
  background: #2b2d31;
}
.mono {
  font-family: ui-monospace, monospace;
  font-size: 0.78rem;
}
.long {
  color: #57f287;
}
.short {
  color: #f38688;
}
.status.good {
  color: #57f287;
}
.status.bad {
  color: #f38688;
}
.status.warn {
  color: #fee75c;
}
</style>
