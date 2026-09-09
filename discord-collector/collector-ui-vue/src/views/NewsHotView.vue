<script setup>
import { onMounted, onUnmounted, ref } from "vue";

defineOptions({ name: "NewsHotView" });

const active = ref(false);
const loading = ref(true);
const embedUrl = ref("");
const error = ref("");
const hint = ref("");
const latencyMs = ref(null);
const iframeReady = ref(false);

let pollTimer = null;

/**
 * 根据当前页面 URL 判断：
 * - http://localhost/* → 嵌本机 news (http://127.0.0.1:8770/)
 * - https://* → 生产同源 /news/index.html
 * @param {Record<string, unknown>} j
 */
function pickEmbedUrl(j) {
  const protocol = String(typeof location !== "undefined" ? location.protocol : "https:");
  if (protocol === "http:") {
    return "http://127.0.0.1:8770/";
  }
  return "/news/index.html";
}

const iframeSrc = embedUrl;

async function refreshStatus() {
  try {
    const r = await fetch("/api/news/status");
    const text = await r.text();
    if (!text.trim()) {
      throw new Error(
        r.status >= 500
          ? `collect:ui 不可用 (HTTP ${r.status})，请先 pnpm run collect:ui`
          : `collect:ui 返回空响应 (HTTP ${r.status})`,
      );
    }
    const j = JSON.parse(text);
    embedUrl.value = pickEmbedUrl(j);
    active.value = Boolean(j.active);
    error.value = j.error ? String(j.error) : "";
    hint.value = j.hint ? String(j.hint) : "";
    latencyMs.value = Number.isFinite(j.latencyMs) ? j.latencyMs : null;
    iframeReady.value = Boolean(j.active);
  } catch (e) {
    active.value = false;
    iframeReady.value = false;
    error.value = String(e?.message ?? e);
    hint.value = "collect:ui 未响应；平台热点由 collect:ui 自动守护 :8770";
    if (!embedUrl.value) embedUrl.value = pickEmbedUrl({});
  } finally {
    loading.value = false;
  }
}

async function restartAndRefresh() {
  loading.value = true;
  try {
    await fetch("/api/news/restart", { method: "POST" });
  } catch {
    /* ignore — let refreshStatus show result */
  }
  // 延迟等进程拉起
  await new Promise((r) => setTimeout(r, 3000));
  await refreshStatus();
}

onMounted(() => {
  void refreshStatus();
  pollTimer = setInterval(() => void refreshStatus(), 5_000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div class="news-shell">
    <div v-if="!iframeReady" class="news-gate">
      <div class="news-card">
        <h2>平台热点</h2>
        <p class="lead">金十+PANews · 币安 · OKX · Foresight · CoinDesk · BlockBeats</p>
        <p v-if="loading" class="muted">探测中…</p>
        <p v-else class="warn">未激活{{ error ? `：${error}` : "" }}</p>
        <p v-if="hint" class="hint">{{ hint }}</p>
        <ol>
          <li>确认已运行 <code>pnpm run collect:ui</code>（会自动守护 news）</li>
          <li>不要同时跑 <code>auto-deal-eth</code> 的 CryptoPulse（同占 :8770，会变成华尔街见闻且没有币圈 tab）</li>
          <li>或手动：<code>pnpm run news:start</code></li>
        </ol>
        <p class="muted">
          嵌入地址：<code>{{ iframeSrc || embedUrl || "—" }}</code>
          <span v-if="latencyMs != null"> · {{ latencyMs }}ms</span>
        </p>
        <button type="button" class="retry" @click="restartAndRefresh">重新探测</button>
      </div>
    </div>
    <iframe
      v-else
      class="news-frame"
      :src="iframeSrc"
      title="平台热点"
      allow="clipboard-read; clipboard-write"
    />
  </div>
</template>

<style scoped>
.news-shell {
  height: 100%;
  min-height: 0;
  background: #0b0d10;
  position: relative;
}
.news-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #0b0d10;
}
.news-gate {
  height: 100%;
  display: grid;
  place-items: center;
  padding: 24px;
}
.news-card {
  max-width: 520px;
  padding: 20px 22px;
  border-radius: 12px;
  border: 1px solid rgba(255, 255, 255, 0.08);
  background: rgba(255, 255, 255, 0.03);
  color: #e8eef7;
}
.news-card h2 {
  margin: 0 0 8px;
  font-size: 1.1rem;
}
.lead {
  margin: 0 0 12px;
  color: rgba(200, 210, 230, 0.85);
  font-size: 0.88rem;
}
.muted {
  color: rgba(160, 170, 190, 0.75);
  font-size: 0.8rem;
}
.warn {
  color: #ffab91;
  font-size: 0.85rem;
}
.hint {
  color: rgba(184, 255, 60, 0.75);
  font-size: 0.78rem;
}
ol {
  margin: 10px 0;
  padding-left: 1.2rem;
  font-size: 0.8rem;
  line-height: 1.5;
  color: rgba(200, 210, 230, 0.85);
}
code {
  font-size: 0.75rem;
  color: #b3e5fc;
}
.retry {
  margin-top: 8px;
  appearance: none;
  border: 1px solid rgba(255, 255, 255, 0.18);
  background: rgba(255, 255, 255, 0.06);
  color: #e8eef7;
  border-radius: 8px;
  padding: 6px 12px;
  cursor: pointer;
}
</style>
