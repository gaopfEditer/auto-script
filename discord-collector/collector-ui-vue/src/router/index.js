import { createRouter, createWebHistory } from "vue-router";

export default createRouter({
  history: createWebHistory("/"),
  routes: [
    { path: "/", name: "home", component: () => import("../views/HomeView.vue") },
    { path: "/show", name: "show", component: () => import("../views/ShowView.vue") },
    { path: "/signals", name: "signals", component: () => import("../views/SignalOverviewView.vue") },
    { path: "/debug", name: "debug", component: () => import("../views/DebugView.vue") },
    { path: "/cards", name: "cards", component: () => import("../views/CardArchiveView.vue") },
    { path: "/fetch", name: "fetch", component: () => import("../views/YoutubeFetchView.vue") },
    { path: "/archives", name: "archives", component: () => import("../views/YoutubeArchivesView.vue") },
    { path: "/trade", name: "trade", component: () => import("../views/BitgetTradeView.vue") },
    { path: "/messages", redirect: "/show" },
  ],
});
