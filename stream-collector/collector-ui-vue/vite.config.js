import path from "node:path";
import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv } from "vite";
import vue from "@vitejs/plugin-vue";

const root = path.dirname(fileURLToPath(import.meta.url));
/** 与 `stream-collector/.env` 中 `COLLECTOR_UI_PORT` 一致，避免 Vite 写死 3840 而后端改端口导致 POST 404 */
const collectorRoot = path.resolve(root, "..");

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, collectorRoot, "");
  const uiPort = Number(env.COLLECTOR_UI_PORT) || 3840;
  const apiTarget = `http://127.0.0.1:${uiPort}`;
  const wsTarget = `ws://127.0.0.1:${uiPort}`;

  return {
    plugins: [
      vue(),
      {
        name: "collector-proxy-banner",
        configureServer(server) {
          server.httpServer?.once("listening", () => {
            const addr = server.httpServer?.address();
            const port = addr && typeof addr === "object" ? addr.port : "?";
            console.info(
              `[collector-ui-vue] dev 服务端口 ${port}；/api、/ws → ${apiTarget}（读自 stream-collector/.env 的 COLLECTOR_UI_PORT，默认 3840；与 collect:ui 不一致时请改 .env 后重启本终端与 collect:ui）`
            );
          });
        },
      },
    ],
    root,
    publicDir: false,
    build: {
      outDir: path.resolve(root, "../public/collector-ui"),
      emptyOutDir: true,
      rollupOptions: {
        input: path.resolve(root, "index.html"),
      },
    },
    server: {
      port: 5174,
      strictPort: false,
      proxy: {
        "/api": {
          target: apiTarget,
          changeOrigin: true,
          configure(proxy) {
            proxy.on("error", (err, req) => {
              console.warn(
                `[vite-proxy /api] → ${apiTarget} | ${err.message} | ${req?.method ?? "?"} ${req?.url ?? ""}`
              );
            });
            proxy.on("proxyRes", (proxyRes, req) => {
              const sc = proxyRes.statusCode ?? 0;
              if (sc === 404 || sc === 502 || sc === 503) {
                console.warn(
                  `[vite-proxy /api] 上游 HTTP ${sc} ${req.method} ${req.url}（请确认 collect:ui 已监听 ${uiPort} 且路由含 POST /api/cdp/kook-channel）`
                );
              }
            });
          },
        },
        "/ws": {
          target: wsTarget,
          ws: true,
          changeOrigin: true,
          configure(proxy) {
            proxy.on("error", (err) => {
              console.warn(`[vite-proxy /ws] → ${wsTarget} | ${err.message}`);
            });
          },
        },
      },
    },
  };
});
