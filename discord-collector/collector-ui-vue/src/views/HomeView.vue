<script setup>
import { RouterLink } from "vue-router";
</script>

<template>
  <div class="hub">
    <h1>Discord Collector</h1>
    <p>
      需要两个终端：<code>pnpm run collect:ui</code>（后端 3851）+ <code>pnpm run dev:ui-vue</code>（前端 dev）。
      请打开 Vite 提示的地址（如 <code>http://localhost:5189/show</code>），顶部应显示 <strong>WS 已连接</strong>。
    </p>
    <div class="actions">
      <RouterLink class="btn primary" to="/show">Show（群组 / 频道 / 消息）</RouterLink>
      <RouterLink class="btn" to="/signals">信号概览 / 历史</RouterLink>
      <RouterLink class="btn" to="/cards">统一卡片归档（来源/币种/时间）</RouterLink>
      <RouterLink class="btn" to="/fetch">提交 YouTube URL 拉取文稿</RouterLink>
      <RouterLink class="btn" to="/archives">YouTube 文稿归档预览</RouterLink>
      <RouterLink class="btn" to="/trade">Bitget 手动下单</RouterLink>
      <RouterLink class="btn primary" to="/community">社区（广场 / 签到 / 打赏 / 头衔）</RouterLink>
      <RouterLink class="btn primary" to="/oi">OI Monitor（行情 / 形态 / 沙盒）</RouterLink>
      <RouterLink class="btn" to="/debug">Debug（网络 / WS 帧）</RouterLink>
    </div>
    <p class="note">
      OI 模块需另开终端 <code>pnpm run oi:start</code>（完整）或 <code>oi:dev</code>；顶栏可在 Discord / OI 间切换。部署版已包含 OI，上云需 frp 映射 8765 并配置 <code>OI_PUBLIC_EMBED_URL</code>。
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
