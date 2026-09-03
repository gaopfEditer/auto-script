<script setup>
import { RouterLink } from "vue-router";
</script>

<template>
  <div class="hub">
    <h1>Discord Collector</h1>
    <p>
      需要两个终端：<code>pnpm run collect:ui</code>（后端 3851）+ <code>pnpm run dev:ui-vue</code>（前端 dev）。
      请打开 Vite 提示的地址（如 <code>http://localhost:5178/show</code>），顶部应显示 <strong>WS 已连接</strong>。
    </p>
    <div class="actions">
      <RouterLink class="btn primary" to="/show">Show（群组 / 频道 / 消息）</RouterLink>
      <RouterLink class="btn" to="/eval">卡片评估</RouterLink>
      <RouterLink class="btn" to="/cards">统一卡片归档</RouterLink>
      <RouterLink class="btn primary" to="/community">社区</RouterLink>
      <RouterLink class="btn primary" to="/oi">OI Monitor</RouterLink>
      <RouterLink class="btn" to="/local/manual-stats">Local 本机工具</RouterLink>
    </div>
    <p class="note">
      顶栏 <strong>Discord | OI Monitor | Local</strong>。Local（Telegram / 推特 / 拉取 / 文稿 / 下单 / Debug）仅本地开发可见，不会打进部署包。
    </p>
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
  flex-wrap: wrap;
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
.note {
  margin-top: 1.25rem;
  color: #949ba4;
  font-size: 0.88rem;
  line-height: 1.5;
}
</style>
