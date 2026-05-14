import { createRouter, createWebHistory } from "vue-router";

export default createRouter({
  history: createWebHistory("/"),
  routes: [
    { path: "/", name: "home", component: () => import("../views/HomeView.vue") },
    { path: "/debug", name: "debug", component: () => import("../views/DebugView.vue") },
    { path: "/show", name: "show", component: () => import("../views/ShowView.vue") },
  ],
});
