import { createRouter, createWebHistory } from "vue-router";

/**
 * 页面开关由 vite.config.js `define` 注入（构建期布尔字面量），
 * 未启用页面的 `import()` 会被 Rollup DCE，不会打进产物。
 * 白名单见 discord-collector/.env.production → VITE_UI_PAGES。
 */
/* global __UI_DEPLOY__, __UI_PAGE_SHOW__, __UI_PAGE_FETCH__, __UI_PAGE_OI__,
   __UI_PAGE_CARDS__,    __UI_PAGE_EVAL__, __UI_PAGE_TELEGRAM__, __UI_PAGE_TWITTER__, __UI_PAGE_ARCHIVES__, __UI_PAGE_TRADE__, __UI_PAGE_COMMUNITY__,
   __UI_PAGE_DEBUG__, __UI_PAGE_HOME__, __UI_PAGE_CONTENT__ */

const IS_DEPLOY = __UI_DEPLOY__;
const DEFAULT_PATH = __UI_PAGE_SHOW__
  ? "/show"
  : __UI_PAGE_CARDS__
    ? "/cards"
    : __UI_PAGE_EVAL__
      ? "/eval"
      : __UI_PAGE_COMMUNITY__
        ? "/community"
        : __UI_PAGE_FETCH__
          ? "/fetch"
          : __UI_PAGE_OI__
            ? "/oi"
            : "/show";

/**
 * @returns {import('vue-router').RouteRecordRaw[]}
 */
function buildRoutes() {
  /** @type {import('vue-router').RouteRecordRaw[]} */
  const routes = [];

  if (IS_DEPLOY) {
    routes.push({ path: "/", redirect: DEFAULT_PATH });
  } else if (__UI_PAGE_HOME__) {
    routes.push({
      path: "/",
      name: "home",
      component: () => import("../views/HomeView.vue"),
    });
  }

  if (__UI_PAGE_SHOW__) {
    routes.push({
      path: "/show",
      name: "show",
      component: () => import("../views/ShowView.vue"),
    });
  }
  if (__UI_PAGE_FETCH__) {
    routes.push({
      path: "/fetch",
      name: "fetch",
      component: () => import("../views/YoutubeFetchView.vue"),
    });
  }
  if (__UI_PAGE_OI__) {
    routes.push({
      path: "/oi",
      name: "oi",
      component: () => import("../views/OiMonitorView.vue"),
    });
  }
  if (__UI_PAGE_CARDS__) {
    routes.push({
      path: "/cards",
      name: "cards",
      component: () => import("../views/CardArchiveView.vue"),
    });
  }
  if (__UI_PAGE_EVAL__) {
    routes.push({
      path: "/eval",
      name: "eval",
      component: () => import("../views/CardEvalView.vue"),
    });
    routes.push({ path: "/signals", redirect: "/eval" });
  }
  if (__UI_PAGE_TELEGRAM__) {
    routes.push({
      path: "/telegram",
      name: "telegram",
      component: () => import("../views/TelegramPromView.vue"),
    });
  }
  if (__UI_PAGE_TWITTER__) {
    routes.push({
      path: "/twitter",
      name: "twitter",
      component: () => import("../views/TwitterCdpView.vue"),
    });
  }
  if (__UI_PAGE_ARCHIVES__) {
    routes.push({
      path: "/archives",
      name: "archives",
      component: () => import("../views/YoutubeArchivesView.vue"),
    });
  }
  if (__UI_PAGE_TRADE__) {
    routes.push({
      path: "/trade",
      name: "trade",
      component: () => import("../views/BitgetTradeView.vue"),
    });
  }
  if (__UI_PAGE_COMMUNITY__) {
    routes.push({
      path: "/community",
      name: "community",
      component: () => import("../views/CommunityView.vue"),
    });
  }
  if (__UI_PAGE_DEBUG__) {
    routes.push({
      path: "/debug",
      name: "debug",
      component: () => import("../views/DebugView.vue"),
    });
  }
  if (__UI_PAGE_CONTENT__) {
    routes.push({
      path: "/content",
      name: "content",
      component: () => import("../views/ContentView.vue"),
    });
  }

  if (__UI_PAGE_SHOW__) {
    routes.push({ path: "/messages", redirect: "/show" });
  }

  routes.push({
    path: "/:pathMatch(.*)*",
    redirect: IS_DEPLOY ? DEFAULT_PATH : "/",
  });

  return routes;
}

const router = createRouter({
  history: createWebHistory("/"),
  routes: buildRoutes(),
});

export default router;
