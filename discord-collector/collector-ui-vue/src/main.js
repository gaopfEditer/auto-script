import { createApp } from "vue";
import App from "./App.vue";
import router from "./router/index.js";
import { ensureCollectorSocket } from "./composables/useCollectorSocket.js";
import "./styles/theme.css";
import "./styles/show-theme.css";

// /content 独立页不连 Discord WS；其它路由再连
const path = typeof location !== "undefined" ? location.pathname : "";
if (!(path === "/content" || path.startsWith("/content/"))) {
  ensureCollectorSocket();
}
createApp(App).use(router).mount("#app");
