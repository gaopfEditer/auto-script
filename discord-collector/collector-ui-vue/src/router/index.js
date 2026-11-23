import { createRouter, createWebHistory } from "vue-router";

/**
 * 页面开关由 vite.config.js `define` 注入（构建期布尔字面量），
 * 未启用页面的 `import()` 会被 Rollup DCE，不会打进产物。
 * 白名单见 discord-collector/.env.production → VITE_UI_PAGES。
 */
/* global __UI_DEPLOY__, __UI_PAGE_SHOW__, __UI_PAGE_FETCH__, __UI_PAGE_OI__, __UI_PAGE_NEWS__,
   __UI_PAGE_CARDS__,    __UI_PAGE_EVAL__, __UI_PAGE_TELEGRAM__, __UI_PAGE_ARCHIVES__, __UI_PAGE_COMMUNITY__,
   __UI_PAGE_DEBUG__, __UI_PAGE_HOME__, __UI_PAGE_CONTENT__, __UI_PAGE_MANUAL_STATS__ */

const IS_DEPLOY = __UI_DEPLOY__;
const DEFAULT_PATH = __UI_PAGE_SHOW__
  ? "/show"
  : __UI_PAGE_CARDS__
    ? "/cards"
    : __UI_PAGE_EVAL__
      ? "/eval"
      : __UI_PAGE_COMMUNITY__
        ? "/community"
        : __UI_PAGE_OI__
          ? "/oi"
          : __UI_PAGE_NEWS__
            ? "/news"
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
    routes.push({ path: "/show", redirect: "/show/rank" });
    routes.push({
      path: "/show/rank",
      name: "show-rank",
      component: () => import("../views/ShowView.vue"),
    });
    routes.push({
      path: "/show/messages",
      name: "show-messages",
      component: () => import("../views/ShowView.vue"),
    });
    routes.push({ path: "/show/kolvip-sig", redirect: "/show/rank" });
  }
  if (__UI_PAGE_OI__) {
    routes.push({
      path: "/oi",
      name: "oi",
      component: () => import("../views/OiMonitorView.vue"),
    });
  }
  if (__UI_PAGE_NEWS__) {
    routes.push({
      path: "/news",
      name: "news",
      component: () => import("../views/NewsHotView.vue"),
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
  if (__UI_PAGE_COMMUNITY__) {
    routes.push({
      path: "/community",
      name: "community",
      component: () => import("../views/CommunityView.vue"),
    });
  }
  if (__UI_PAGE_TELEGRAM__) {
    routes.push({
      path: "/telegram",
      name: "telegram",
      component: () => import("../views/TelegramPromView.vue"),
    });
  }

  // —— Local 模块（仅非 deploy；构建期 __UI_PAGE_* = false 时整段 DCE）——
  if (__UI_PAGE_MANUAL_STATS__) {
    routes.push({
      path: "/local/manual-stats",
      component: () => import("../views/ManualStatsLayout.vue"),
      children: [
        {
          path: "",
          name: "manual-stats",
          component: () => import("../views/ManualStatsView.vue"),
        },
        {
          path: "telegram-backfill",
          name: "manual-stats-telegram-backfill",
          component: () => import("../components/TelegramBackfillPanel.vue"),
        },
        {
          path: "discord-backfill",
          name: "manual-stats-discord-backfill",
          component: () => import("../components/DiscordBackfillPanel.vue"),
        },
        {
          path: "kolvip-backfill",
          name: "manual-stats-kolvip-backfill",
          component: () => import("../components/KolvipBackfillPanel.vue"),
        },
        {
          path: "kolvip-sig",
          name: "manual-stats-kolvip-sig",
          component: () => import("../views/KolvipSigView.vue"),
        },
      ],
    });
    routes.push({ path: "/local", redirect: "/local/manual-stats" });
    routes.push({
      path: "/local/membership",
      name: "membership",
      component: () => import("../views/MembershipCenterView.vue"),
    });
  }
  if (__UI_PAGE_FETCH__) {
    routes.push({
      path: "/fetch",
      name: "fetch",
      component: () => import("../views/YoutubeFetchView.vue"),
    });
  }
  if (__UI_PAGE_ARCHIVES__) {
    routes.push({
      path: "/archives",
      name: "archives",
      component: () => import("../views/YoutubeArchivesView.vue"),
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
    routes.push({ path: "/messages", redirect: "/show/messages" });
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

/** build 后 index 已更新但浏览器仍缓存旧 index/chunk 映射时，懒加载会 404；自动刷新一次 */
const CHUNK_RELOAD_KEY = "collector-ui-chunk-reload";

router.onError((error, to) => {
  const msg = String(error?.message ?? error ?? "");
  const chunkLoadFail =
    msg.includes("Failed to fetch dynamically imported module") ||
    msg.includes("Importing a module script failed") ||
    (error instanceof TypeError && msg.includes("fetch"));
  if (!chunkLoadFail || typeof window === "undefined") return;
  try {
    if (!sessionStorage.getItem(CHUNK_RELOAD_KEY)) {
      sessionStorage.setItem(CHUNK_RELOAD_KEY, "1");
      const target = to?.fullPath && to.fullPath !== "/" ? to.fullPath : window.location.pathname;
      window.location.assign(target + window.location.search + window.location.hash);
      return;
    }
    sessionStorage.removeItem(CHUNK_RELOAD_KEY);
  } catch {
    sessionStorage.removeItem(CHUNK_RELOAD_KEY);
  }
  console.error("[router] chunk load failed after reload", error);
});

export default router;
