#!/usr/bin/env node
/**
 * 启动前释放占用 TCP 端口的 LISTEN 进程（macOS / Linux）。
 */
import { execSync } from "node:child_process";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * @param {string | number} port
 * @returns {Set<string>}
 */
function collectPidsOnPort(port) {
  const p = String(port ?? "").trim();
  /** @type {Set<string>} */
  const pids = new Set();
  if (!p) return pids;

  for (const cmd of [
    `lsof -nP -iTCP:${p} -sTCP:LISTEN -t`,
    `lsof -ti tcp:${p}`,
    `lsof -ti :${p}`,
  ]) {
    try {
      const out = execSync(cmd, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) {
        for (const pid of out.split("\n")) {
          const s = pid.trim();
          if (s) pids.add(s);
        }
      }
    } catch {
      /* 无占用 */
    }
  }

  for (const pid of [...pids]) {
    try {
      const ppid = execSync(`ps -p ${pid} -o ppid=`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (ppid && ppid !== "1" && ppid !== String(process.pid)) pids.add(ppid);
    } catch {
      /* ignore */
    }
  }

  return pids;
}

/** @param {string | number} port */
function isPortInUse(port) {
  return collectPidsOnPort(port).size > 0;
}

/**
 * @param {string | number} port
 * @param {string} [label]
 */
export async function killListenersOnPort(port, label = "port") {
  const p = String(port ?? "").trim();
  if (!p) return false;

  /** @type {Set<string>} */
  const killed = new Set();

  for (let round = 0; round < 4; round++) {
    const pids = collectPidsOnPort(p);
    if (!pids.size) {
      if (killed.size) {
        console.log(`[${label}] 已释放 127.0.0.1:${p}（结束 PID: ${[...killed].join(", ")}）`);
      }
      return true;
    }

    for (const pid of pids) {
      const n = Number(pid);
      if (!Number.isFinite(n) || n === process.pid) continue;
      killed.add(pid);
      try {
        execSync(`kill -9 ${n}`, { stdio: "ignore" });
      } catch {
        try {
          process.kill(n, "SIGKILL");
        } catch {
          /* ignore */
        }
      }
    }

    try {
      execSync("pkill -9 -f src/collector-ui-server.js", { stdio: "ignore" });
    } catch {
      /* 无匹配 */
    }

    await sleep(round === 0 ? 250 : 400);
  }

  if (!isPortInUse(p)) {
    if (killed.size) {
      console.log(`[${label}] 已释放 127.0.0.1:${p}（结束 PID: ${[...killed].join(", ")}）`);
    }
    return true;
  }

  const remain = [...collectPidsOnPort(p)];
  console.warn(
    `[${label}] 警告: 127.0.0.1:${p} 仍被占用（PID: ${remain.join(", ")}）。` +
      " 请关闭运行 collect:ui 的终端，或改用 COLLECTOR_UI_PORT=3852"
  );
  return false;
}
