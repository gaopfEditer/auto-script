<script setup>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import NewCardToastStack from "./components/NewCardToastStack.vue";
import OnboardingGuide from "./components/OnboardingGuide.vue";
import "./composables/useNewCardNotifications.js";
import { useOnboardingGuide, isOnboardingCompleted, onboardingState } from "./composables/useOnboardingGuide.js";
import { useDebugMode } from "./composables/useDebugMode.js";
import {
  COLLECTOR_WS_REFRESH_EVENT,
  WS_DISCONNECT_WARN_MS,
  ensureCollectorSocket,
  useCollectorSocket,
} from "./composables/useCollectorSocket.js";
import {
  getDefaultDeployPath,
  getModuleFromPath,
  getNavPages,
  getUiMode,
  isDeployUi,
  isLocalModuleEnabled,
  isOiModuleEnabled,
  UI_MODULES,
} from "./lib/uiMode.js";

const route = useRoute();
const { open: openOnboarding } = useOnboardingGuide();
const { debugMode, setDebugMode } = useDebugMode();

const uiMode = getUiMode();
const brandTo = isDeployUi() ? getDefaultDeployPath() : "/";
const showOiModule = isOiModuleEnabled();
const showLocalModule = isLocalModuleEnabled();

const activeModule = computed(() => getModuleFromPath(route.path));
const isOi = computed(() => activeModule.value === "oi");
const isLocal = computed(() => activeModule.value === "local");
/** Discord / Local 共用二级导航；OI 用 spacer */
const showSubNav = computed(() => !isOi.value);
const navPages = computed(() =>
  getNavPages(isLocal.value ? "local" : "discord")
);
const showDebugToggle = computed(() => !isOi.value && !isDeployUi());
/** /content 独立全屏，不共用 Discord/OI 顶栏 */
const isContentStandalone = computed(() => activeModule.value === "content");

const { status: wsStatus, error: wsError, disconnectedSince, reconnect: reconnectWs } =
  useCollectorSocket();

/** 断线时长 tick，便于 >5min 提示 */
const nowTick = ref(Date.now());
/** @type {ReturnType<typeof setInterval> | null} */
let wsWarnTimer = null;

const wsDownMs = computed(() => {
  const since = disconnectedSince.value;
  if (!since || wsStatus.value === "open") return 0;
  return Math.max(0, nowTick.value - since);
});

const wsLongDisconnect = computed(() => wsDownMs.value >= WS_DISCONNECT_WARN_MS);

const wsDownLabel = computed(() => {
  const sec = Math.floor(wsDownMs.value / 1000);
  if (sec < 60) return `${sec}s`;
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return s ? `${m}分${s}秒` : `${m}分钟`;
});

watch(
  isContentStandalone,
  (standalone) => {
    if (!standalone) ensureCollectorSocket();
  },
  { immediate: true },
);

/** 静默刷新：重挂载路由视图，避免 location.reload */
const viewEpoch = ref(0);
function onWsSilentRefresh() {
  if (isContentStandalone.value) return;
  viewEpoch.value += 1;
}
onMounted(() => {
  window.addEventListener(COLLECTOR_WS_REFRESH_EVENT, onWsSilentRefresh);
  wsWarnTimer = setInterval(() => {
    nowTick.value = Date.now();
  }, 5_000);
  if (!isContentStandalone.value && !isOnboardingCompleted()) {
    window.setTimeout(() => openOnboarding(0), 800);
  }
});
onUnmounted(() => {
  window.removeEventListener(COLLECTOR_WS_REFRESH_EVENT, onWsSilentRefresh);
  if (wsWarnTimer) {
    clearInterval(wsWarnTimer);
    wsWarnTimer = null;
  }
});

const moduleLinks = computed(() => {
  let list = UI_MODULES;
  if (!showOiModule) list = list.filter((m) => m.id !== "oi");
  if (!showLocalModule) list = list.filter((m) => m.id !== "local");
  return list.map((m) => {
    if (m.id === "discord") {
      return {
        ...m,
        to: isDeployUi() ? getDefaultDeployPath() : brandTo === "/" ? "/show" : brandTo,
      };
    }
    return m;
  });
});

const wsStatusLabel = computed(() => {
  switch (wsStatus.value) {
    case "open":
      return "WS 已连接";
    case "connecting":
      return "WS 连接中…";
    case "error":
      return "WS 失败";
    default:
      return "WS 未连接";
  }
});

async function toggleDebug() {
  await setDebugMode(!debugMode.value);
}
</script>

<template>
  <!-- 内容板：独立页，无 Discord/OI 壳 -->
  <div v-if="isContentStandalone" class="content-standalone">
    <RouterView />
  </div>

  <div v-else class="app-shell" :data-ui-mode="uiMode" :data-module="activeModule">
    <header class="top-nav">
      <RouterLink :to="brandTo" class="brand">discord-collector</RouterLink>
      <nav class="module-switch" aria-label="模块">
        <RouterLink
          v-for="m in moduleLinks"
          :key="m.id"
          :to="m.to"
          class="module-link"
          :class="{ on: activeModule === m.id }"
        >
          {{ m.label }}
        </RouterLink>
      </nav>
      <nav v-if="showSubNav" class="nav-links">
        <RouterLink v-for="p in navPages" :key="p.name" :to="p.path">{{ p.label }}</RouterLink>
      </nav>
      <div v-else class="oi-nav-spacer">OI Monitor · 行情 / 形态 / 沙盒</div>
      <button
        type="button"
        class="guide-btn"
        title="新手操作指引"
        @click="openOnboarding(0)"
      >
        新手指引
      </button>
      <button
        v-if="!isOi"
        type="button"
        class="ws-status"
        :class="[wsStatus, { warn: wsLongDisconnect }]"
        :title="wsError || '点击重连 WebSocket'"
        @click="reconnectWs"
      >
        {{ wsLongDisconnect ? `WS 断线 ${wsDownLabel}` : wsStatusLabel }}
      </button>
      <button
        v-if="showDebugToggle"
        class="debug-toggle"
        :class="{ on: debugMode }"
        @click="toggleDebug"
      >
        {{ debugMode ? "Debug 开" : "精简模式" }}
      </button>
    </header>
    <div v-if="!isOi && wsLongDisconnect" class="ws-down-banner" role="alert">
      <span>实时通道已断开超过 {{ wsDownLabel }}，新消息可能收不到。已在自动重连。</span>
      <button type="button" class="ws-down-btn" @click="reconnectWs">立即重连</button>
    </div>
    <main class="main-outlet">
      <RouterView :key="viewEpoch" />
    </main>
    <OnboardingGuide v-if="!isOi || onboardingState.open" />
    <NewCardToastStack v-if="!isOi" />
  </div>
</template>

<style scoped>
.content-standalone {
  height: 100vh;
  min-height: 0;
  overflow: hidden;
  background: #0e0f12;
}
.app-shell {
  display: flex;
  flex-direction: column;
  height: 100vh;
  min-height: 0;
}
.top-nav {
  display: flex;
  align-items: center;
  gap: 1rem;
  padding: 0.55rem 1.1rem;
  background: #111214;
  border-bottom: 1px solid #000;
  flex-shrink: 0;
}
.brand {
  font-weight: 800;
  font-size: 0.95rem;
  color: #fff;
  text-decoration: none;
  flex-shrink: 0;
}
.module-switch {
  display: inline-flex;
  gap: 0.2rem;
  padding: 0.15rem;
  border-radius: 8px;
  background: #1e1f22;
  border: 1px solid #3f4147;
  flex-shrink: 0;
}
.module-link {
  color: #949ba4;
  text-decoration: none;
  font-size: 0.78rem;
  font-weight: 700;
  padding: 0.28rem 0.65rem;
  border-radius: 6px;
  white-space: nowrap;
}
.module-link.on {
  background: #5865f2;
  color: #fff;
}
.nav-links {
  display: flex;
  gap: 1rem;
  flex: 1;
  min-width: 0;
}
.nav-links a {
  color: #b5bac1;
  text-decoration: none;
  font-size: 0.88rem;
  font-weight: 600;
}
.nav-links a.router-link-active {
  color: #5865f2;
}
.oi-nav-spacer {
  flex: 1;
  color: #949ba4;
  font-size: 0.82rem;
  font-weight: 600;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.ws-status {
  border: 1px solid #3f4147;
  background: #2b2d31;
  color: #949ba4;
  padding: 0.3rem 0.55rem;
  border-radius: 6px;
  font-size: 0.72rem;
  cursor: pointer;
  white-space: nowrap;
}
.ws-status.open {
  border-color: #248046;
  background: rgba(36, 128, 70, 0.2);
  color: #57f287;
}
.ws-status.connecting {
  border-color: #5865f2;
  color: #aeb4ff;
}
.ws-status.error,
.ws-status.closed {
  border-color: #ed4245;
  background: rgba(237, 66, 69, 0.15);
  color: #f38688;
}
.ws-status.warn {
  border-color: #faa81a;
  background: rgba(250, 168, 26, 0.18);
  color: #faa81a;
  animation: ws-warn-pulse 1.6s ease-in-out infinite;
}
@keyframes ws-warn-pulse {
  50% {
    opacity: 0.72;
  }
}
.ws-down-banner {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.75rem;
  flex-wrap: wrap;
  padding: 0.45rem 1.1rem;
  background: #3d1f21;
  border-bottom: 1px solid #ed4245;
  color: #f2c0c2;
  font-size: 0.82rem;
  font-weight: 600;
  flex-shrink: 0;
}
.ws-down-btn {
  border: 1px solid #ed4245;
  background: rgba(237, 66, 69, 0.25);
  color: #fff;
  padding: 0.28rem 0.7rem;
  border-radius: 6px;
  font-size: 0.78rem;
  font-weight: 700;
  cursor: pointer;
  white-space: nowrap;
}
.ws-down-btn:hover {
  background: rgba(237, 66, 69, 0.45);
}
.guide-btn {
  border: 1px solid #4e5058;
  background: #2b2d31;
  color: #dbdee1;
  padding: 0.3rem 0.65rem;
  border-radius: 6px;
  font-size: 0.78rem;
  cursor: pointer;
  white-space: nowrap;
}
.guide-btn:hover {
  border-color: #5865f2;
  color: #fff;
}
.debug-toggle {
  border: 1px solid #3f4147;
  background: #2b2d31;
  color: #b5bac1;
  padding: 0.3rem 0.65rem;
  border-radius: 6px;
  font-size: 0.78rem;
  cursor: pointer;
}
.debug-toggle.on {
  background: #5865f2;
  border-color: #5865f2;
  color: #fff;
}
.main-outlet {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
