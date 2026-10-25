<script setup>
import { RouterLink, RouterView, useRoute } from "vue-router";

defineOptions({ name: "ManualStatsLayout" });

const route = useRoute();

const tabs = [
  { to: "/local/manual-stats", label: "手动统计", exact: true },
  { to: "/local/manual-stats/telegram-backfill", label: "Telegram 回溯", exact: true },
  { to: "/local/manual-stats/discord-backfill", label: "Discord 回测", exact: true },
];

function isActive(tab) {
  const p = route.path;
  if (tab.exact) return p === tab.to || p === `${tab.to}/`;
  return p === tab.to || p.startsWith(`${tab.to}/`);
}
</script>

<template>
  <div class="manual-stats-layout">
    <nav class="page-tabs" aria-label="手动统计子页">
      <RouterLink
        v-for="t in tabs"
        :key="t.to"
        :to="t.to"
        class="page-tab"
        :class="{ on: isActive(t) }"
      >
        {{ t.label }}
      </RouterLink>
    </nav>
    <RouterView />
  </div>
</template>

<style scoped>
.manual-stats-layout {
  min-height: 100%;
}
.page-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 0.35rem;
  max-width: 1100px;
  margin: 0 auto;
  padding: 0.85rem 1.5rem 0;
}
.page-tab {
  display: inline-flex;
  align-items: center;
  padding: 0.42rem 0.85rem;
  border-radius: 8px;
  font-size: 0.88rem;
  font-weight: 600;
  text-decoration: none;
  color: #949ba4;
  background: #2b2d31;
  border: 1px solid #404249;
  transition:
    color 0.15s ease,
    border-color 0.15s ease,
    background 0.15s ease;
}
.page-tab:hover {
  color: #dbdee1;
  border-color: #52565e;
}
.page-tab.on {
  color: #fff;
  background: #5865f2;
  border-color: #5865f2;
}
</style>
