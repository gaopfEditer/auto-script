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

  return {
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
