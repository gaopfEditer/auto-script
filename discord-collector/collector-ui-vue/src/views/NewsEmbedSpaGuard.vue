<script setup>
defineOptions({ name: "NewsEmbedSpaGuard" });
</script>

<template>
  <div class="guard">
    <h1>平台热点嵌入页未就绪</h1>
    <p>
      当前 URL 落到了主站 SPA，而不是 <code>/news-embed/</code> 静态页。请重新
      <code>pnpm run ui:build</code>（会同步 news 静态），并确保 Nginx 对
      <code>/news-embed/api/</code> 反代到 collect:ui（:3851）。
    </p>
    <p class="muted">正确入口：<RouterLink to="/news">/news</RouterLink></p>
  </div>
</template>

<style scoped>
.guard {
  padding: 2rem;
  color: #e8eef7;
  background: #0b0d10;
  min-height: 100vh;
  font-size: 0.9rem;
  line-height: 1.55;
}
h1 {
  font-size: 1.1rem;
  margin: 0 0 0.75rem;
}
.muted {
  color: rgba(160, 170, 190, 0.8);
  margin-top: 1rem;
}
code {
  color: #b3e5fc;
  font-size: 0.85em;
}
</style>
