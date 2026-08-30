<script setup>
import { RouterLink } from "vue-router";
import { getNavPages } from "../lib/uiMode.js";

const tools = getNavPages("local").filter((p) => p.name !== "local");
</script>

<template>
  <div class="local-hub">
    <h1>Local · 本机工具</h1>
    <p>
      这些页面只在本地开发出现，<strong>不会打进部署包</strong>。
      顶栏 Discord / OI Monitor / Local 可切换；部署版仅保留 Discord + OI。
    </p>
    <div class="actions">
      <RouterLink v-for="p in tools" :key="p.name" class="btn" :to="p.path">{{ p.label }}</RouterLink>
    </div>
  </div>
</template>

<style scoped>
.local-hub {
  max-width: 560px;
  margin: 3rem auto;
  padding: 2rem;
  background: #2b2d31;
  border-radius: 12px;
  border: 1px solid #3f4147;
}
h1 {
  margin: 0 0 0.5rem;
  font-size: 1.35rem;
  color: #f2f3f5;
}
p {
  color: #949ba4;
  line-height: 1.55;
  margin: 0;
}
.actions {
  display: flex;
  flex-wrap: wrap;
  gap: 0.85rem;
  margin-top: 1.5rem;
}
.btn {
  flex: 1 1 140px;
  text-align: center;
  padding: 0.75rem 1rem;
  border-radius: 8px;
  font-weight: 600;
  border: 1px solid #3f4147;
  background: #1e1f22;
  color: #dbdee1;
  text-decoration: none;
}
.btn:hover {
  border-color: #5865f2;
  color: #fff;
}
</style>
