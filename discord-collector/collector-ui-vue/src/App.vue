<script setup>
import { computed } from "vue";
import { RouterLink, RouterView } from "vue-router";
import { useDebugMode } from "./composables/useDebugMode.js";
import { ensureCollectorSocket, useCollectorSocket } from "./composables/useCollectorSocket.js";

const { debugMode, setDebugMode } = useDebugMode();

ensureCollectorSocket();
const { status: wsStatus, error: wsError, reconnect: reconnectWs } = useCollectorSocket();

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
  <div class="app-shell">
    <header class="top-nav">
      <RouterLink to="/" class="brand">discord-collector</RouterLink>
      <nav class="nav-links">
        <RouterLink to="/show">Show</RouterLink>
        <RouterLink to="/cards">卡片</RouterLink>
        <RouterLink to="/fetch">拉取</RouterLink>
        <RouterLink to="/archives">文稿</RouterLink>
        <RouterLink to="/debug">Debug</RouterLink>
      </nav>
      <button
        type="button"
        class="ws-status"
        :class="wsStatus"
        :title="wsError || '点击重连 WebSocket'"
        @click="reconnectWs"
      >
        {{ wsStatusLabel }}
      </button>
      <button class="debug-toggle" :class="{ on: debugMode }" @click="toggleDebug">
        {{ debugMode ? "Debug 开" : "精简模式" }}
      </button>
    </header>
    <main class="main-outlet">
      <RouterView />
    </main>
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
  gap: 1.5rem;
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
}
.nav-links {
  display: flex;
  gap: 1rem;
  flex: 1;
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
