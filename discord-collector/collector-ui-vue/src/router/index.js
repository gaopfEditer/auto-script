import { createRouter, createWebHistory } from "vue-router";
import {
  getDefaultDeployPath,
  getEnabledPageNames,
  isDeployUi,
  isPageEnabled,
} from "../lib/uiMode.js";

/** @type {import('vue-router').RouteRecordRaw[]} */
const allRoutes = [
  { path: "/", name: "home", component: () => import("../views/HomeView.vue") },
  { path: "/show", name: "show", component: () => import("../views/ShowView.vue") },
  { path: "/signals", name: "signals", component: () => import("../views/SignalOverviewView.vue") },
  { path: "/debug", name: "debug", component: () => import("../views/DebugView.vue") },
  { path: "/cards", name: "cards", component: () => import("../views/CardArchiveView.vue") },
  { path: "/fetch", name: "fetch", component: () => import("../views/YoutubeFetchView.vue") },
  { path: "/archives", name: "archives", component: () => import("../views/YoutubeArchivesView.vue") },
  { path: "/trade", name: "trade", component: () => import("../views/BitgetTradeView.vue") },
  { path: "/community", name: "community", component: () => import("../views/CommunityView.vue") },
  { path: "/oi", name: "oi", component: () => import("../views/OiMonitorView.vue") },
  { path: "/messages", redirect: "/show" },
];

function buildRoutes() {
  const enabled = getEnabledPageNames();
  const deploy = isDeployUi();
  const defaultPath = getDefaultDeployPath();

  /** @type {import('vue-router').RouteRecordRaw[]} */
  const routes = [];

  if (deploy) {
    // 首页跳到部署默认页
    routes.push({ path: "/", redirect: defaultPath });
  }

  for (const r of allRoutes) {
    if (r.redirect) {
      if (deploy && r.path === "/messages") {
        routes.push({ ...r, redirect: enabled.has("show") ? "/show" : defaultPath });
      } else if (!deploy) {
        routes.push(r);
      }
      continue;
    }
    const name = String(r.name ?? "");
    if (!name || !isPageEnabled(name)) continue;
    // deploy 下 "/" 已改 redirect，跳过原 home
    if (deploy && r.path === "/") continue;
    routes.push(r);
  }

  // 未开放路由落到默认页，避免 空白
  routes.push({
    path: "/:pathMatch(.*)*",
    redirect: deploy ? defaultPath : "/",
  });

  return routes;
}

const router = createRouter({
  history: createWebHistory("/"),
  routes: buildRoutes(),
});

export default router;
