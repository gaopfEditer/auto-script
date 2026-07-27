<script setup>
import { computed } from "vue";
import { RouterLink, RouterView, useRoute } from "vue-router";
import NewCardToastStack from "./components/NewCardToastStack.vue";
import "./composables/useNewCardNotifications.js";
import { useDebugMode } from "./composables/useDebugMode.js";
import { ensureCollectorSocket, useCollectorSocket } from "./composables/useCollectorSocket.js";
import {
  getDefaultDeployPath,
  getModuleFromPath,
  getNavPages,
  getUiMode,
  isDeployUi,
  isOiModuleEnabled,
  isPageEnabled,
  UI_MODULES,
} from "./lib/uiMode.js";

const route = useRoute();
const { debugMode, setDebugMode } = useDebugMode();

ensureCollectorSocket();
const { status: wsStatus, error: wsError, reconnect: reconnectWs } = useCollectorSocket();

const uiMode = getUiMode();
const navPages = getNavPages();
const brandTo = isDeployUi() ? getDefaultDeployPath() : "/";
const showDebugToggle = !isDeployUi() || isPageEnabled("debug");
const showOiModule = isOiModuleEnabled();

const activeModule = computed(() => getModuleFromPath(route.path));
const isOi = computed(() => activeModule.value === "oi");

const moduleLinks = computed(() => {
  if (!showOiModule) return UI_MODULES.filter((m) => m.id === "discord");
  return UI_MODULES.map((m) => ({
    ...m,
    to: m.id === "discord" ? (isDeployUi() ? getDefaultDeployPath() : brandTo === "/" ? "/show" : brandTo) : m.to,
  }));
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
  <div class="app-shell" :data-ui-mode="uiMode" :data-module="activeModule">
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
      <nav v-if="!isOi" class="nav-links">
        <RouterLink v-for="p in navPages" :key="p.name" :to="p.path">{{ p.label }}</RouterLink>
      </nav>
      <div v-else class="oi-nav-spacer">OI Monitor · 行情 / 形态 / 沙盒</div>
      <button
        v-if="!isOi"
        type="button"
        class="ws-status"
        :class="wsStatus"
        :title="wsError || '点击重连 WebSocket'"
        @click="reconnectWs"
      >
        {{ wsStatusLabel }}
      </button>
      <button
        v-if="!isOi && showDebugToggle"
        class="debug-toggle"
        :class="{ on: debugMode }"
        @click="toggleDebug"
      >
        {{ debugMode ? "Debug 开" : "精简模式" }}
      </button>
    </header>
    <main class="main-outlet">
      <RouterView />
    </main>
    <NewCardToastStack v-if="!isOi" />
  </div>
</template>

<style scoped>
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
