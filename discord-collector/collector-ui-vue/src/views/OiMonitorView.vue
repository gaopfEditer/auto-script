<script setup>
import { onMounted, onUnmounted, ref, watch } from "vue";

const active = ref(false);
const loading = ref(true);
const embedUrl = ref("");
const error = ref("");
const hint = ref("");
const latencyMs = ref(null);

let pollTimer = null;

/** @param {string} raw */
function normalizeEmbed(raw) {
  const s = String(raw || "").trim().replace(/\/$/, "");
  return s ? `${s}/` : "";
}

/**
 * 上云时 API 若仍返回 127.0.0.1，改用构建期公网地址。
 * @param {Record<string, unknown>} j
 */
function pickEmbedUrl(j) {
  const fromApi = normalizeEmbed(String(j.publicEmbedUrl || j.embedUrl || ""));
  const fromEnv = normalizeEmbed(String(import.meta.env.VITE_OI_PUBLIC_EMBED_URL || ""));
  const host = typeof location !== "undefined" ? location.hostname : "";
  const pageIsLocal = host === "localhost" || host === "127.0.0.1";
  const apiIsLocal = /^(https?:\/\/)?(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(
    fromApi.replace(/\/$/, "")
  );
  if (!pageIsLocal && apiIsLocal && fromEnv) return fromEnv;
  if (fromApi) return fromApi;
  if (fromEnv) return fromEnv;
  return "http://127.0.0.1:8765/";
}

async function refreshStatus() {
  try {
    const r = await fetch("/api/oi/status");
    const text = await r.text();
    if (!text.trim()) {
      throw new Error(
        r.status >= 500
          ? `collect:ui 不可用 (HTTP ${r.status})，请先 pnpm run collect:ui`
          : `collect:ui 返回空响应 (HTTP ${r.status})`
      );
    }
    let j;
    try {
      j = JSON.parse(text);
    } catch {
      throw new Error(
        `collect:ui 未返回 JSON (HTTP ${r.status})：${text.slice(0, 120)}`
      );
    }
    embedUrl.value = pickEmbedUrl(j);
    active.value = Boolean(j.active);
    error.value = j.error ? String(j.error) : "";
    hint.value = j.hint ? String(j.hint) : "";
    latencyMs.value = Number.isFinite(j.latencyMs) ? j.latencyMs : null;
  } catch (e) {
    active.value = false;
    error.value = String(e?.message ?? e);
    hint.value = "collect:ui 未响应；请先 pnpm run collect:ui（OI 在 8766 也需其代理 /api/oi/status）";
    if (!embedUrl.value) {
      embedUrl.value = pickEmbedUrl({});
    }
  } finally {
    loading.value = false;
  }
}

onMounted(() => {
  void refreshStatus();
  pollTimer = setInterval(() => void refreshStatus(), 5_000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});

watch(active, (ok) => {
  if (ok) loading.value = false;
});
</script>

<template>
  <div class="oi-shell">
    <div v-if="!active" class="oi-gate">
      <div class="oi-card">
        <h2>OI Monitor</h2>
        <p class="lead">模块已切换；等待 OI 后端就绪后自动嵌入。</p>
        <p v-if="loading" class="muted">探测中…</p>
        <p v-else class="warn">未激活{{ error ? `：${error}` : "" }}</p>
        <p v-if="hint" class="hint">{{ hint }}</p>
        <ol>
          <li>终端 A：<code>pnpm run collect:ui</code></li>
          <li>终端 B：<code>pnpm run dev:ui-vue</code></li>
          <li>终端 C：<code>pnpm run oi:dev</code> 或 <code>pnpm run oi:start</code></li>
        </ol>
        <p class="muted">
          嵌入地址：<code>{{ embedUrl || "—" }}</code>
          <span v-if="latencyMs != null"> · {{ latencyMs }}ms</span>
        </p>
        <button type="button" class="retry" @click="refreshStatus">重新探测</button>
      </div>
    </div>
    <iframe
      v-else
      class="oi-frame"
      :src="embedUrl"
      title="OI Monitor"
      allow="clipboard-read; clipboard-write"
    />
  </div>
</template>

<style scoped>
.oi-shell {
  height: 100%;
  min-height: 0;
  background: #0b0d10;
}
.oi-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #0b0d10;
}
.oi-gate {
  height: 100%;
  display: grid;
  place-items: center;
  padding: 1.5rem;
}
.oi-card {
  width: min(520px, 100%);
  background: #1e1f22;
  border: 1px solid #3f4147;
  border-radius: 12px;
  padding: 1.35rem 1.4rem;
}
h2 {
  margin: 0 0 0.35rem;
  color: #f2f3f5;
  font-size: 1.15rem;
}
.lead {
  margin: 0 0 0.75rem;
  color: #b5bac1;
  line-height: 1.5;
}
.warn {
  color: #f38688;
  margin: 0 0 0.5rem;
}
.muted,
.hint {
  color: #949ba4;
  font-size: 0.88rem;
  line-height: 1.45;
}
.hint {
  margin: 0 0 0.75rem;
}
ol {
  margin: 0.5rem 0 1rem;
  padding-left: 1.2rem;
  color: #dbdee1;
  line-height: 1.7;
  font-size: 0.9rem;
}
code {
  font-size: 0.84em;
  background: #111214;
  padding: 0.12em 0.35em;
  border-radius: 4px;
}
.retry {
  border: 1px solid #5865f2;
  background: #5865f2;
  color: #fff;
  border-radius: 8px;
  padding: 0.45rem 0.9rem;
  font-weight: 600;
  cursor: pointer;
}
</style>
