<script setup>
import { inject } from "vue";

defineOptions({ name: "KolvipSigBloggerDetailPane" });

const props = defineProps({
  channelLabel: { type: String, default: "" },
});

/** @type {ReturnType<import('../composables/useKolvipSig.js').useKolvipSig>} */
const sig = inject("kolvipSig");
if (!sig) throw new Error("kolvipSig provide missing");

// sig 为 reactive 包裹，模板直接读字段
</script>

<template>
  <aside class="kolvip-sig-detail-panel" aria-label="博主胜率明细">
    <header class="kolvip-sig-detail-head">
      <span class="kolvip-sig-detail-title">博主明细</span>
      <span v-if="channelLabel" class="kolvip-sig-detail-ch" :title="channelLabel"># {{ channelLabel }}</span>
    </header>

    <template v-if="!sig.selectedName">
      <p class="kolvip-sig-detail-muted">在榜单或左侧频道选一位博主</p>
    </template>
    <template v-else>
      <h2 class="kolvip-sig-detail-name">{{ sig.stat?.name || sig.selectedName }}</h2>
      <div v-if="sig.stat" class="kolvip-sig-kpis">
        <div>
          <b :class="sig.stat.win_rate >= 50 ? 'up' : 'dn'">{{ sig.stat.count ? sig.stat.win_rate + "%" : "–" }}</b>
          <small>胜率</small>
        </div>
        <div>
          <b>{{ sig.stat.pl || "–" }}</b>
          <small>盈亏比</small>
        </div>
        <div>
          <b :class="sig.stat.r >= 0 ? 'up' : 'dn'">{{ sig.fmtR(sig.stat.r) }}</b>
          <small>累计收益</small>
        </div>
        <div>
          <b>{{ sig.stat.wins }} / {{ sig.stat.losses }}</b>
          <small>赢 / 亏</small>
        </div>
        <div>
          <b class="dn">{{ sig.stat.max_lose }}</b>
          <small>最大连亏</small>
        </div>
      </div>

      <h3>进行中 <span v-if="sig.openList.length" class="kv-live">● {{ sig.openList.length }}</span></h3>
      <p v-if="!sig.openList.length" class="kolvip-sig-detail-muted">无进行中单子</p>
      <ul v-else class="kv-open">
        <li v-for="s in sig.openList" :key="s.id">
          <b>{{ s.coin }}</b> {{ sig.sideLabel(s.side) }}
          <small>{{ s.status }}</small>
        </li>
      </ul>

      <h3>历史单子 <small>{{ sig.history.length }} 笔</small></h3>
      <div class="kv-tbl-wrap">
        <table class="kv-tbl">
          <thead>
            <tr>
              <th>币种</th>
              <th>方向</th>
              <th>结果</th>
              <th>收益</th>
            </tr>
          </thead>
          <tbody>
            <tr v-for="s in sig.history" :key="s.id">
              <td><b>{{ s.coin }}</b></td>
              <td :class="s.side > 0 ? 'up' : 'dn'">{{ sig.sideLabel(s.side) }}</td>
              <td>{{ s.status }}</td>
              <td class="n" :class="s.r > 0 ? 'up' : s.r < 0 ? 'dn' : ''">{{ sig.fmtR(s.r) }}</td>
            </tr>
          </tbody>
        </table>
      </div>
    </template>
  </aside>
</template>

<style scoped>
.kolvip-sig-detail-panel {
  background: #1e1f22;
  border-left: 1px solid #000;
  display: flex;
  flex-direction: column;
  min-height: 0;
  overflow: hidden;
  color: #dbdee1;
  font-size: 0.8rem;
}
.kolvip-sig-detail-head {
  padding: 0.55rem 0.65rem;
  border-bottom: 1px solid rgba(0, 0, 0, 0.35);
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  align-items: baseline;
  flex-shrink: 0;
}
.kolvip-sig-detail-title {
  font-weight: 700;
  color: #f2f3f5;
}
.kolvip-sig-detail-ch {
  font-size: 0.72rem;
  color: #949ba4;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  max-width: 100%;
}
.kolvip-sig-detail-panel > *:not(.kolvip-sig-detail-head) {
  padding-left: 0.65rem;
  padding-right: 0.65rem;
}
.kolvip-sig-detail-name {
  margin: 0.55rem 0 0.35rem;
  font-size: 0.9rem;
}
.kolvip-sig-detail-muted {
  color: #949ba4;
  padding: 0.75rem 0.65rem;
}
.kolvip-sig-kpis {
  display: grid;
  grid-template-columns: repeat(2, 1fr);
  gap: 0.4rem;
  margin-bottom: 0.5rem;
}
.kolvip-sig-kpis b {
  display: block;
  font-size: 0.95rem;
}
.kolvip-sig-kpis small {
  color: #949ba4;
  font-size: 0.62rem;
}
h3 {
  margin: 0.65rem 0 0.35rem;
  font-size: 0.78rem;
  color: #b5bac1;
  font-weight: 600;
}
h3 small {
  font-weight: 400;
  color: #949ba4;
}
.kv-live {
  color: #49e57a;
}
.kv-open {
  list-style: none;
  margin: 0;
  padding: 0;
}
.kv-open li {
  padding: 0.2rem 0;
  border-bottom: 1px solid rgba(64, 66, 73, 0.6);
}
.kv-open small {
  color: #949ba4;
  margin-left: 0.35rem;
}
.kv-tbl-wrap {
  flex: 1;
  overflow: auto;
  min-height: 0;
  padding-bottom: 0.75rem;
  margin-top: 0.25rem;
}
.kv-tbl {
  width: 100%;
  border-collapse: collapse;
  font-size: 0.72rem;
}
.kv-tbl th,
.kv-tbl td {
  padding: 0.3rem 0.25rem;
  border-bottom: 1px solid #404249;
  text-align: left;
}
.up {
  color: #49e57a;
}
.dn {
  color: #f23f43;
}
</style>