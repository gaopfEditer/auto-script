import { createApp } from "vue";
import App from "./App.vue";
import router from "./router/index.js";
import { ensureCollectorSocket } from "./composables/useCollectorSocket.js";
import "./styles/theme.css";
import "./styles/show-theme.css";

ensureCollectorSocket();
createApp(App).use(router).mount("#app");
