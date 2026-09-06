#!/usr/bin/env node
/**
 * collect:ui 启动前：
 *   1. 释放 COLLECTOR_UI_PORT（默认 3851），自动改用附近空闲端口
 *   2. 拉起 telegram/listen.py（telegram/venv 中的 Python 环境）
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

// ── 1. Telegram listen.py ────────────────────────────────────────────────────────
const TELEGRAM_ROOT = resolve(ROOT, "..", "telegram");
const VENV_PYTHON = resolve(TELEGRAM_ROOT, "venv", "bin", "python");
const LISTEN_SCRIPT = resolve(TELEGRAM_ROOT, "listen.py");

const telegram = spawn(VENV_PYTHON, [LISTEN_SCRIPT], {
  cwd: TELEGRAM_ROOT,
  env: process.env,
  stdio: "inherit",
});

telegram.on("exit", (code, signal) => {
  console.error(`[collect:ui] telegram listen.py 已退出 code=${code} signal=${signal}，一同退出`);
  process.exit(code ?? 1);
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    if (!telegram.killed) telegram.kill(sig);
  });
}

// ── 2. collector-ui-server ──────────────────────────────────────────────────────
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
