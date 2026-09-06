import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const oiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const collectorRoot = path.resolve(oiRoot, "..");

export default defineConfig(({ mode }) => {
  // 与 discord-collector/.env 的 OI_WEB_PORT 对齐（本机常被占时用 8766）
  const env = loadEnv(mode, collectorRoot, "");
  const oiPort = Number(env.OI_WEB_PORT) || 8766;
  const apiTarget = `http://127.0.0.1:${oiPort}`;

  return {
    plugins: [react()],
    build: {
      outDir: "../static/dist",
      emptyOutDir: true,
    },
    server: {
      port: 5173,
      proxy: {
        "/api": apiTarget,
        "/ws": { target: apiTarget, ws: true },
      },
    },
  };
});
