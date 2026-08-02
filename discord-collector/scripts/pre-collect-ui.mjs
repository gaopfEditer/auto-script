#!/usr/bin/env node
/**
 * collect:ui 启动前释放 COLLECTOR_UI_PORT（默认 3851），再拉起 UI 服务。
 * 若端口被 Ctrl+Z / 僵死进程占死，自动改用附近空闲端口。
 */
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import dotenv from "dotenv";

import { killListenersOnPort, findFreePortNear } from "./kill-port.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");
dotenv.config({ path: resolve(ROOT, ".env") });

const preferred = String(process.env.COLLECTOR_UI_PORT ?? "3851").trim() || "3851";

let port = preferred;
const freed = await killListenersOnPort(preferred, "collect:ui");
if (!freed) {
  const alt = await findFreePortNear(Number(preferred) || 3851, 20);
  if (alt == null) {
    console.error(`[collect:ui] 无法释放 127.0.0.1:${preferred}，附近也无空闲端口，已中止`);
    process.exit(1);
  }
  port = String(alt);
  console.warn(
    `[collect:ui] ${preferred} 无法释放（多为 Ctrl+Z 留下的僵死 node），改用 ${port}`
  );
  console.warn(`[collect:ui] → http://127.0.0.1:${port}/`);
}

const child = spawn(process.execPath, [resolve(ROOT, "src/collector-ui-server.js")], {
  cwd: ROOT,
  env: { ...process.env, COLLECTOR_UI_PORT: port },
  stdio: "inherit",
});

child.on("exit", (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  process.exit(code ?? 1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (!child.killed) child.kill(sig);
  });
}
