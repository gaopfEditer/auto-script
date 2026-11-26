<script setup>
import { inject } from "vue";
import { useHideKolName } from "../composables/useHideKolName.js";

defineOptions({ name: "KolvipSigRankPane" });

/** @type {ReturnType<import('../composables/useKolvipSig.js').useKolvipSig>} */
const sig = inject("kolvipSig");
if (!sig) throw new Error("kolvipSig provide missing");

const { hideKolControlVisible, hideKolName, toggleHideKol, maskKolChannelLabel } = useHideKolName();

/** @param {{ name?: string }} row */
function pickRow(row) {
  if (row?.name) sig.pickBlogger(row.name);
}
</script>

<template>
  <div class="kv-sig-rank-pane">
    <div class="kv-sig-seg">
      <button
        v-for="(label, key) in sig.rangeLabels"
        :key="key"
        type="button"
        class="kv-sig-seg-btn"
        :class="{ on: sig.range === key }"
        @click="sig.range = key; sig.loadRank()"
      >
        {{ label }}
      </button>
      <button type="button" class="kv-sig-sync" :disabled="sig.syncing" @click="sig.onSync()">
        {{ sig.syncing ? "同步中…" : "从巨鲸拉取" }}
      </button>
      <button
        v-if="hideKolControlVisible"
        type="button"
        class="kv-hide-kol-btn"
        :class="{ on: hideKolName }"
        :title="hideKolName ? '显示 KOL 频道名称' : '隐藏 KOL 频道名称，便于本地截图调试'"
        @click="toggleHideKol"
      >
        {{ hideKolName ? "显示频道名称" : "隐藏频道名称" }}
      </button>
      <span v-if="sig.rank?.open != null" class="kv-sig-live">● {{ sig.rank.open }} 单进行中</span>
      <span v-if="sig.meta?.lastSyncAt" class="kv-sig-meta">同步 {{ sig.meta.lastSyncAt }}</span>
    </div>

    <p v-if="sig.error" class="kv-sig-err">{{ sig.error }}</p>
    <p v-else-if="sig.loading && !sig.rank" class="kv-sig-muted">加载中…</p>

    <div v-else class="kv-sig-rank-body">
      <p class="kv-sig-hint">
        口径与 kolvip「博主胜率分析」一致；点左侧频道看消息，右侧为博主成交明细。
      </p>
      <section class="card">
        <h2>榜单 <small>上榜需 ≥ {{ sig.rank?.min_count ?? 5 }} 单有结果</small></h2>
        <ul>
          <li
            v-for="(row, i) in sig.rankedList"
            :key="row.name"
            class="kv-sig-row"
            :class="{ on: row.name === sig.selectedName }"
            @click="pickRow(row)"
          >
            <span class="rk">{{ ["🥇", "🥈", "🥉"][i] || i + 1 }}</span>
            <div class="t">
              <b>{{ maskKolChannelLabel(row.name, i) }}</b>
              <small>{{ row.count }} 单 · 盈亏比 {{ row.pl || "–" }} · {{ sig.fmtR(row.r) }}</small>
            </div>
            <span class="wr" :class="row.win_rate >= 50 ? 'up' : 'dn'">
              {{ row.count ? row.win_rate + "%" : "–" }}
            </span>
          </li>
        </ul>
        <template v-if="sig.moreList.length">
          <h3>样本不足</h3>
          <ul>
            <li
              v-for="(row, j) in sig.moreList"
              :key="'m-' + row.name"
              class="kv-sig-row alt"
              :class="{ on: row.name === sig.selectedName }"
              @click="pickRow(row)"
            >
              <span class="rk">–</span>
              <div class="t">
                <b>{{ maskKolChannelLabel(row.name, sig.rankedList.length + j) }}</b>
                <small>{{ row.count }} 单</small>
              </div>
              <span class="wr muted">{{ row.count ? row.win_rate + "%" : "–" }}</span>
            </li>
          </ul>
        </template>
      </section>
    </div>
  </div>
</template>

<style scoped>
.kv-sig-rank-pane {
  padding: 0.75rem 1rem 1.25rem;
  color: #dbdee1;
  max-width: 720px;
}
.kv-sig-seg {
  display: flex;
  align-items: center;
  gap: 0.4rem;
  flex-wrap: wrap;
  margin-bottom: 0.75rem;
}
.kv-sig-seg-btn {
  padding: 0.35rem 0.75rem;
  border-radius: 8px;
  border: 1px solid #404249;
  background: #2b2d31;
  color: #949ba4;
  cursor: pointer;
  font-weight: 600;
  font-size: 0.82rem;
}
.kv-sig-seg-btn.on {
  background: #5865f2;
  border-color: #5865f2;
  color: #fff;
}
.kv-sig-sync {
  margin-left: 0.25rem;
  padding: 0.35rem 0.65rem;
  border-radius: 8px;
  border: none;
  background: #404249;
  color: #dbdee1;
  font-size: 0.78rem;
  cursor: pointer;
}
.kv-sig-sync:disabled {
  opacity: 0.55;
  cursor: default;
}
.kv-sig-live {
  font-size: 0.75rem;
  color: #49e57a;
}
.kv-sig-meta {
  font-size: 0.72rem;
  color: #949ba4;
}
.kv-sig-hint {
  font-size: 0.78rem;
  color: #949ba4;
  margin: 0 0 0.75rem;
  line-height: 1.45;
}
.card {
  background: #2b2d31;
  border: 1px solid #404249;
  border-radius: 10px;
  padding: 0.85rem 1rem;
}
.card h2,
.card h3 {
  margin: 0 0 0.65rem;
  font-size: 0.95rem;
}
.card h3 {
  margin-top: 1rem;
  font-size: 0.85rem;
  color: #b5bac1;
}
.kv-sig-row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.4rem 0.35rem;
  border-radius: 6px;
  cursor: pointer;
  list-style: none;
}
ul {
  list-style: none;
  margin: 0;
  padding: 0;
}
.kv-sig-row:hover,
.kv-sig-row.on {
  background: rgba(88, 101, 242, 0.15);
}
.kv-sig-row .rk {
  width: 1.5rem;
  text-align: center;
  flex-shrink: 0;
}
.kv-sig-row .t {
  flex: 1;
  min-width: 0;
}
.kv-sig-row .t b {
  display: block;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.kv-sig-row .t small {
  color: #949ba4;
  font-size: 0.68rem;
}
.kv-sig-row .wr {
  font-weight: 700;
  font-variant-numeric: tabular-nums;
}
.up {
  color: #49e57a;
}
.dn {
  color: #f23f43;
}
.muted {
  color: #949ba4;
}
.kv-sig-err {
  color: #f23f43;
}
.kv-sig-muted {
  color: #949ba4;
}

.kv-hide-kol-btn {
  margin-left: 0.25rem;
  padding: 0.35rem 0.65rem;
  border-radius: 8px;
  border: 1px solid #404249;
  background: #2b2d31;
  color: #b5bac1;
  font-size: 0.78rem;
  font-weight: 600;
  cursor: pointer;
}
.kv-hide-kol-btn.on {
  border-color: #5865f2;
  background: rgba(88, 101, 242, 0.18);
  color: #aeb4ff;
}
</style>
