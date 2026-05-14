<script setup>
import { RouterLink } from "vue-router";
</script>

<template>
  <div class="hub">
    <h1>Collector UI（Vue）</h1>
    <p>
      终端运行 <code>pnpm run collect:ui</code> 后在本页选择视图；开发时可另开
      <code>pnpm run dev:ui-vue</code>（需 collect:ui 已在 3840 端口提供 /api 与 /ws）。
    </p>
    <div class="actions">
      <RouterLink class="btn primary" to="/debug">CDP 请求 / 响应 / 诊断</RouterLink>
      <RouterLink class="btn" to="/show">消息流（Discord 风格）</RouterLink>
    </div>
  </div>
</template>

<style scoped>
.hub {
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
code {
  font-size: 0.85em;
  background: #1e1f22;
  padding: 0.1em 0.35em;
  border-radius: 4px;
}
.actions {
  display: flex;
  gap: 1rem;
  margin-top: 1.5rem;
}
.btn {
  flex: 1;
  text-align: center;
  padding: 0.75rem 1rem;
  border-radius: 8px;
  font-weight: 600;
  border: 1px solid #3f4147;
  background: #1e1f22;
  color: #dbdee1;
  text-decoration: none;
}
.btn.primary {
  background: #5865f2;
  border-color: #5865f2;
  color: #fff;
}
</style>
