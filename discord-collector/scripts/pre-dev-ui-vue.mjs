#!/usr/bin/env node
/**
 * dev:ui-vue 启动前释放 Vite dev 端口（默认 5178），避免 Port already in use。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { killListenersOnPort } from "./kill-port.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dir, "../.env") });

const raw = process.env.VITE_DEV_PORT ?? process.env.COLLECTOR_VUE_DEV_PORT ?? "5178";
const port = String(raw).trim() || "5178";

await killListenersOnPort(port, "dev:ui-vue");

const apiPort = String(process.env.COLLECTOR_UI_PORT ?? "3851").trim() || "3851";
const apiBase = `http://127.0.0.1:${apiPort}`;
try {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 2500);
  const r = await fetch(`${apiBase}/api/youtube-archives/health`, { signal: ctrl.signal });
  clearTimeout(timer);
  if (!r.ok) {
    console.warn(`[discord-collector-ui] 警告：collect:ui (${apiBase}) 响应异常，/archives 可能很慢`);
  }
} catch {
  console.warn(
    `[discord-collector-ui] 警告：未连接 collect:ui (${apiBase})，请先运行 pnpm run collect:ui，否则 /archives /api 会超时`
  );
}
