<script setup>
import { onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import PageLoadingBlock from "../components/PageLoadingBlock.vue";
import { isLocalClient } from "../lib/localClient.js";

defineOptions({ name: "OiMonitorView" });

const route = useRoute();
const active = ref(false);
const loading = ref(true);
const embedUrl = ref("");
const error = ref("");
const hint = ref("");
const embedDeployError = ref("");
const latencyMs = ref(null);
/** 一旦激活过就保留 iframe，避免 status 抖动拆掉页面状态 */
const iframeReady = ref(false);

let pollTimer = null;

const iframeKey = ref(0);
const iframeLoading = ref(true);

const iframeSrc = embedUrl;

/** 生产默认 OI 独立站（与 op.c 主站分离） */
const DEFAULT_PUBLIC_OI_ORIGIN = "https://op.b.ezcoin.ink";

/**
 * @param {string} raw
 * @returns {string}
 */
function productionOiOriginFallback() {
  const fromEnv = String(import.meta.env.VITE_OI_PUBLIC_EMBED_URL ?? "").trim().replace(/\/$/, "");
  return fromEnv || DEFAULT_PUBLIC_OI_ORIGIN;
}

/** @param {string} url */
function isCollectorMainSiteUrl(url) {
  try {
    const u = new URL(String(url).trim(), location.href);
    if (u.origin === location.origin) return true;
    const host = u.hostname.toLowerCase();
    if (host !== "localhost" && host !== "127.0.0.1") return false;
    const port = u.port || (u.protocol === "https:" ? "443" : "80");
    const devPort = String(import.meta.env.VITE_DEV_PORT ?? "5178");
    return port === "3851" || port === "5178" || port === devPort;
  } catch {
    return false;
  }
}

/**
 * 访客浏览器禁止嵌 127.0.0.1；本机禁止嵌主站 dev/collect 端口（5178/3851）。
 * @param {string} url
 */
function sanitizeEmbedForBrowser(url) {
  const u = String(url ?? "").trim();
  if (!u) return "";
  if (isCollectorMainSiteUrl(u)) return "";
  if (isLocalClient()) return u;
  if (/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?/i.test(u)) {
    return `${productionOiOriginFallback()}/`;
  }
  return u;
}

/**
 * 本机开发：只用 OI :8765 / oi:dev :5173，忽略 status 里的公网或误配主站地址。
 * @param {Record<string, unknown>} [status]
 */
function resolveLocalOiEmbedBase(status) {
  const oiDev = String(import.meta.env.VITE_OI_EMBED_URL ?? "").trim();
  const candidates = [
    status?.localEmbedUrl,
    oiDev,
    "http://127.0.0.1:8765/",
    status?.embedUrl,
    status?.publicEmbedUrl,
  ];
  for (const raw of candidates) {
    const s = String(raw ?? "").trim();
    if (!s || isCollectorMainSiteUrl(s)) continue;
    return s;
  }
  return "http://127.0.0.1:8765/";
}

/**
 * @param {string} baseUrl status 或默认根地址（可含 ?v= 缓存戳）
 * @param {string} [symbol]
 */
function buildOiIframeSrc(baseUrl, symbol) {
  let root = sanitizeEmbedForBrowser(baseUrl);
  if (!root) {
    root = isLocalClient() ? "http://127.0.0.1:8765/" : `${productionOiOriginFallback()}/`;
  }
  const sym = String(symbol ?? "").trim().toUpperCase();
  if (!sym) return root;
  const hash = `#/patterns?symbol=${encodeURIComponent(sym)}&add=1`;
  const noHash = root.split("#")[0] || root;
  const withSlash = /\/$/.test(noHash) ? noHash : `${noHash}/`;
  return `${withSlash}${hash}`;
}

/**
 * @param {Record<string, unknown>} [status]
 * @param {string} [symbolOverride]
 */
function pickEmbedUrl(status, symbolOverride) {
  const sym =
    String(symbolOverride ?? route.query.symbol ?? "").trim() ||
    (() => {
      try {
        const q = new URLSearchParams(typeof location !== "undefined" ? location.search : "");
        return (q.get("symbol") || "").trim();
      } catch {
        return "";
      }
    })();

  let base = "";
  if (isLocalClient()) {
    base = resolveLocalOiEmbedBase(status);
  } else {
    // 线上只用公网 OI 站；绝不使用 embedUrl（未配公网时可能是 127.0.0.1 或误配成主站 op.c）
    base = String(status?.publicEmbedUrl ?? "").trim();
    if (!base || isCollectorMainSiteUrl(base)) {
      base = `${productionOiOriginFallback()}/`;
    }
  }
  return buildOiIframeSrc(base, sym);
}

function applySymbolToEmbed(sym) {
  const next = pickEmbedUrl({}, sym);
  if (next !== embedUrl.value) {
    embedUrl.value = next;
    iframeKey.value += 1;
    iframeReady.value = true;
  }
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
    const sym = String(route.query.symbol ?? "").trim();
    if (!sym || !embedUrl.value.includes("patterns?symbol=")) {
      const next = pickEmbedUrl(j);
      if (!isCollectorMainSiteUrl(next)) {
        embedUrl.value = next;
      }
    }
    embedDeployError.value = j.embedDeployError ? String(j.embedDeployError) : "";
    active.value = Boolean(j.active);
    error.value = j.error ? String(j.error) : "";
    hint.value = j.hint ? String(j.hint) : "";
    if (embedDeployError.value) {
      iframeReady.value = false;
      error.value = embedDeployError.value;
      return;
    }
    iframeReady.value = true;
    latencyMs.value = Number.isFinite(j.latencyMs) ? j.latencyMs : null;
  } catch (e) {
    active.value = false;
    iframeReady.value = false;
    error.value = String(e?.message ?? e);
    hint.value = "collect:ui 未响应；请先 pnpm run collect:ui（OI 在 8765 也需其代理 /api/oi/status）";
    if (!embedUrl.value) embedUrl.value = pickEmbedUrl({});
  } finally {
    loading.value = false;
  }
}

/** 手动打穿缓存：换 iframe key + 强制重新加载 iframe */
function forceReloadOiFrame() {
  iframeKey.value++;
  iframeReady.value = false;
  iframeLoading.value = true;
  void refreshStatus();
}

function onIframeLoad() {
  iframeLoading.value = false;
}

watch(iframeKey, () => {
  iframeLoading.value = true;
});

watch(
  () => String(route.query.symbol ?? "").trim().toUpperCase(),
  (sym) => {
    if (sym) applySymbolToEmbed(sym);
  }
);

onMounted(() => {
  const sym = String(route.query.symbol ?? "").trim();
  embedUrl.value = pickEmbedUrl({});
  if (sym) applySymbolToEmbed(sym);
  void refreshStatus();
  pollTimer = setInterval(() => void refreshStatus(), 5_000);
});

onUnmounted(() => {
  if (pollTimer) clearInterval(pollTimer);
});
</script>

<template>
  <div class="oi-shell" data-onboard="oi-frame">
    <div v-if="!iframeReady" class="oi-gate">
      <div class="oi-card">
        <h2>OI Monitor</h2>
        <p class="lead">模块已切换；等待 OI 后端就绪后自动嵌入独立 OI 站点。</p>
        <PageLoadingBlock
          v-if="loading"
          :overlay="false"
          message="连接 OI 服务…"
          hint="collect:ui 探测本机 :8765；iframe 指向 OI_PUBLIC_EMBED_URL"
        />
        <p v-else class="warn">{{ error || "未激活" }}</p>
        <p v-if="embedDeployError" class="warn deploy-err">{{ embedDeployError }}</p>
        <p v-if="hint && !embedDeployError" class="hint">{{ hint }}</p>
        <ol>
          <li>主站 <code>op.c</code>：<code>pnpm run collect:ui</code> + 静态 <code>collector-ui</code></li>
          <li>OI 站 <code>op.b</code>：仅部署 <code>oi_mornitor/public/oi-dist</code>（勿覆盖为 Vue 主站）</li>
          <li><code>OI_PUBLIC_EMBED_URL=https://op.b.ezcoin.ink</code>（主站 .env）</li>
        </ol>
        <p class="muted">
          嵌入地址：<code>{{ iframeSrc || embedUrl || "—" }}</code>
          <span v-if="latencyMs != null"> · {{ latencyMs }}ms</span>
        </p>
        <button type="button" class="retry" @click="refreshStatus">重新探测</button>
      </div>
    </div>
    <div v-else class="oi-frame-wrap">
      <PageLoadingBlock
        v-if="iframeLoading"
        message="加载 OI 信号页…"
        hint="首次打开需下载脚本并连接雷达快照，可能需十数秒"
      />
      <button
        type="button"
        class="oi-reload"
        title="OI 页面缓存卡住时点这里强制重载嵌入"
        @click="forceReloadOiFrame"
      >
        重载 OI
      </button>
      <iframe
        :key="iframeKey"
        class="oi-frame"
        :src="iframeSrc"
        title="OI Monitor"
        allow="clipboard-read; clipboard-write"
        @load="onIframeLoad"
      />
    </div>
  </div>
</template>

<style scoped>
.oi-shell {
  height: 100%;
  min-height: 0;
  background: #0b0d10;
  position: relative;
}
.oi-frame-wrap {
  position: relative;
  height: 100%;
  min-height: 0;
}
.oi-gate .oi-card {
  position: relative;
  min-height: 12rem;
}
.oi-frame {
  display: block;
  width: 100%;
  height: 100%;
  border: 0;
  background: #0b0d10;
}
.oi-reload {
  position: absolute;
  top: 8px;
  right: 10px;
  z-index: 5;
  appearance: none;
  background: rgba(30, 31, 34, 0.92);
  color: #dbdee1;
  border-radius: 6px;
  padding: 4px 10px;
  font-size: 0.72rem;
  font-weight: 600;
  cursor: pointer;
}
.oi-reload:hover {
  border-color: #b8ff3c;
  color: #fff;
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
.deploy-err {
  line-height: 1.55;
  white-space: pre-wrap;
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
