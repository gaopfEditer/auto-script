import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";

const root = path.dirname(fileURLToPath(import.meta.url));
const collectorRoot = path.resolve(root, "..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, collectorRoot, "");
  const uiPort = Number(env.COLLECTOR_UI_PORT) || 3851;
  const devPort = Number(env.VITE_DEV_PORT || env.COLLECTOR_VUE_DEV_PORT) || 5178;
  const apiTarget = `http://127.0.0.1:${uiPort}`;

  const uiMode = String(env.VITE_UI_MODE ?? "").trim().toLowerCase();
  const isDeployBuild =
    mode === "production" &&
    uiMode !== "local" &&
    uiMode !== "dev" &&
    uiMode !== "full";
  const pagesCsv = String(env.VITE_UI_PAGES ?? "show,fetch,oi").trim() || "show,fetch,oi";
  const pageSet = new Set(
    pagesCsv.split(/[,;\s]+/).map((s) => s.trim().toLowerCase()).filter(Boolean)
  );
  /** @param {string} name */
  const pageOn = (name) => !isDeployBuild || pageSet.has(name);

  if (mode === "production") {
    console.info(
      `[discord-collector-ui] build mode=${mode} deploy=${isDeployBuild} pages=${[...pageSet].join(",")}`
    );
  }

  return {
    define: {
      __UI_DEPLOY__: JSON.stringify(isDeployBuild),
      __UI_PAGE_SHOW__: JSON.stringify(pageOn("show")),
      __UI_PAGE_FETCH__: JSON.stringify(pageOn("fetch")),
      __UI_PAGE_OI__: JSON.stringify(pageOn("oi")),
      __UI_PAGE_CARDS__: JSON.stringify(pageOn("cards")),
      __UI_PAGE_EVAL__: JSON.stringify(pageOn("eval")),
      __UI_PAGE_TWITTER__: JSON.stringify(pageOn("twitter")),
      __UI_PAGE_ARCHIVES__: JSON.stringify(pageOn("archives")),
      __UI_PAGE_TRADE__: JSON.stringify(pageOn("trade")),
      __UI_PAGE_COMMUNITY__: JSON.stringify(pageOn("community")),
      __UI_PAGE_SIGNALS__: JSON.stringify(pageOn("signals")),
      __UI_PAGE_DEBUG__: JSON.stringify(pageOn("debug")),
      __UI_PAGE_CONTENT__: JSON.stringify(pageOn("content")),
      __UI_PAGE_HOME__: JSON.stringify(pageOn("home") || !isDeployBuild),
    },
    plugins: [
      vue(),
      {
        name: "discord-collector-proxy-banner",
        configureServer(server) {
          server.httpServer?.once("listening", () => {
            const addr = server.httpServer?.address();
            const port = addr && typeof addr === "object" ? addr.port : "?";
            console.info(
              `[discord-collector-ui] dev 端口 ${port}；/api、/ws → ${apiTarget}`
            );
          });
        },
      },
    ],
    root,
    envDir: collectorRoot,
    publicDir: false,
    build: {
      outDir: path.resolve(root, "../public/collector-ui"),
      emptyOutDir: true,
      rollupOptions: {
        input: path.resolve(root, "index.html"),
      },
    },
    server: {
      port: devPort,
      strictPort: true,
      proxy: {
        "/api": { target: apiTarget, changeOrigin: true },
        "/community-avatars": { target: apiTarget, changeOrigin: true },
        "/ws": {
          target: apiTarget,
          ws: true,
          changeOrigin: true,
          configure: (proxy) => {
            proxy.on("error", (err) => {
              console.warn("[discord-collector-ui] WS 代理错误（collect:ui 是否在运行？）:", err.message);
            });
          },
        },
      },
    },
  };
});
