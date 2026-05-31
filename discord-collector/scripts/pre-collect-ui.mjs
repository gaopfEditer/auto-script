#!/usr/bin/env node
/**
 * collect:ui 启动前释放 COLLECTOR_UI_PORT（默认 3840），避免 address already in use。
 */
import { execSync } from "node:child_process";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const __dir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dir, "../.env") });

const port = String(process.env.COLLECTOR_UI_PORT ?? "3840").trim() || "3840";

async function killListenersOnPort(p) {
  let pids = [];
  try {
    const out = execSync(`lsof -iTCP:${p} -sTCP:LISTEN -n -P -t`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (out) pids = [...new Set(out.split("\n").map((s) => s.trim()).filter(Boolean))];
  } catch {
    return;
  }
  if (!pids.length) return;

  for (const pid of pids) {
    const n = Number(pid);
    if (!Number.isFinite(n)) continue;
    try {
      process.kill(n, "SIGKILL");
    } catch (e) {
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ESRCH") {
        try {
          execSync(`kill -9 ${n}`, { stdio: "ignore" });
        } catch {
          /* ignore */
        }
      }
    }
  }
  await sleep(200);
  console.log(`[collect:ui] 已释放 127.0.0.1:${p}（结束 PID: ${pids.join(", ")}）`);
}

await killListenersOnPort(port);
