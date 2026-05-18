<script setup>
import { KeepAlive } from "vue";
import { RouterLink, RouterView } from "vue-router";
</script>

<template>
  <div class="app-shell">
    <header class="top-nav">
      <RouterLink to="/" class="brand">stream-collector</RouterLink>
      <nav class="nav-links">
        <RouterLink to="/debug">Debug</RouterLink>
        <RouterLink to="/show">Show</RouterLink>
      </nav>
    </header>
    <main class="main-outlet">
      <RouterView v-slot="{ Component }">
        <KeepAlive include="DebugView,ShowView">
          <component :is="Component" />
        </KeepAlive>
      </RouterView>
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
}
.nav-links a {
  color: #b5bac1;
  text-decoration: none;
  font-size: 0.88rem;
  font-weight: 600;
}
.nav-links a.router-link-active {
  color: #00a8fc;
}
.main-outlet {
  flex: 1;
  min-height: 0;
  overflow: hidden;
}
</style>
