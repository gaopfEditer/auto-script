#!/usr/bin/env node
/**
 * collect:ui 看护：子进程异常退出后自动重拉（日志追加到 logs/collector-ui-server.log）。
 * 用法：pnpm run collect:ui:daemon  或 nohup pnpm run collect:ui:daemon &
 * 停止：touch data/collect-ui-daemon.stop  或 kill 本进程
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import { createWriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

import dotenv from "dotenv";

import { killListenersOnPort, findFreePortNear } from "./kill-port.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");
dotenv.config({ path: resolve(ROOT, ".env") });

const STOP_FILE = resolve(ROOT, "data/collect-ui-daemon.stop");
const LOG_FILE = resolve(ROOT, "logs/collector-ui-server.log");
const RESTART_MS = Math.max(3000, Number(process.env.COLLECT_UI_DAEMON_RESTART_MS ?? 8000) || 8000);

const preferred = String(process.env.COLLECTOR_UI_PORT ?? "3851").trim() || "3851";

/** @returns {Promise<number>} */
async function resolvePort() {
  const freed = await killListenersOnPort(preferred, "collect:ui:daemon");
  if (freed) return Number(preferred) || 3851;
  const alt = await findFreePortNear(Number(preferred) || 3851, 20);
  if (alt != null) {
    console.warn(`[collect-ui-daemon] ${preferred} 占用，改用 ${alt}`);
    return alt;
  }
  throw new Error(`无法释放 127.0.0.1:${preferred}`);
}

/** @param {number} port */
function runServer(port) {
  return new Promise((resolvePromise) => {
    fs.mkdirSync(dirname(LOG_FILE), { recursive: true });
    const logStream = createWriteStream(LOG_FILE, { flags: "a" });
    const stamp = new Date().toISOString();
    logStream.write(`\n--- collect-ui-daemon spawn ${stamp} port=${port} ---\n`);

    const child = spawn(process.execPath, [resolve(ROOT, "src/collector-ui-server.js")], {
      cwd: ROOT,
      env: { ...process.env, COLLECTOR_UI_PORT: String(port) },
      stdio: ["ignore", "pipe", "pipe"],
    });

    child.stdout?.pipe(logStream, { end: false });
    child.stderr?.pipe(logStream, { end: false });

    child.on("exit", (code, signal) => {
      logStream.write(
        `\n--- child exit code=${code ?? "null"} signal=${signal ?? "null"} at ${new Date().toISOString()} ---\n`
      );
      logStream.end();
      resolvePromise(code ?? (signal ? 128 : 1));
    });
  });
}

let stopping = false;
for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    stopping = true;
    try {
      fs.unlinkSync(STOP_FILE);
    } catch {
      /* ignore */
    }
  });
}

let port = await resolvePort();
console.log(`[collect-ui-daemon] 看护已启动 port=${port} log=${LOG_FILE}`);

while (!stopping) {
  if (fs.existsSync(STOP_FILE)) {
    console.log("[collect-ui-daemon] 发现 stop 文件，退出");
    try {
      fs.unlinkSync(STOP_FILE);
    } catch {
      /* ignore */
    }
    break;
  }
  const code = await runServer(port);
  if (stopping) break;
  console.warn(`[collect-ui-daemon] 服务退出 code=${code}，${RESTART_MS}ms 后重拉…`);
  await sleep(RESTART_MS);
  try {
    port = await resolvePort();
  } catch (e) {
    console.error(`[collect-ui-daemon] 端口释放失败: ${/** @type {Error} */ (e).message}`);
    await sleep(RESTART_MS);
  }
}

process.exit(0);