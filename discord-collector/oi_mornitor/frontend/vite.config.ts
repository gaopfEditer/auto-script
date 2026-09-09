import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";
import path from "node:path";
import { fileURLToPath } from "node:url";

const oiRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const collectorRoot = path.resolve(oiRoot, "..");

export default defineConfig(({ mode }) => {
  // discord-collector/.env 的 OI_WEB_PORT 对齐（本机常被占时用 8766）
  const env = loadEnv(mode, collectorRoot, "");
  const oiPort = Number(env.OI_WEB_PORT) || 8766;
  const apiTarget = `http://127.0.0.1:${oiPort}`;

  return {
    plugins: [react()],
    // 独立部署，base 为根路径
    base: "/",
    build: {
      // 构建产物供独立部署：
      // rsync 时一起上传 oi_mornitor/public/oi-dist/ 到独立静态根目录
      // 不再依赖 nginx 子路径路由
      outDir: "../public/oi-dist",
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
