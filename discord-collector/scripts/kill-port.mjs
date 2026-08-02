#!/usr/bin/env node
/**
 * 启动前释放占用 TCP 端口的 LISTEN 进程（macOS / Linux）。
 * 含 Ctrl+Z 挂起（T）与僵死（UE）提示。
 */
import { execSync } from "node:child_process";
import net from "node:net";
import process from "node:process";
import { setTimeout as sleep } from "node:timers/promises";

/**
 * @param {string | number} port
 * @returns {Set<string>}
 */
export function collectPidsOnPort(port) {
  const p = String(port ?? "").trim();
  /** @type {Set<string>} */
  const pids = new Set();
  if (!p) return pids;

  for (const cmd of [
    `lsof -nP -iTCP:${p} -sTCP:LISTEN -t`,
    `lsof -tiTCP:${p} -sTCP:LISTEN`,
    `lsof -nP -i:${p} -sTCP:LISTEN -t`,
  ]) {
    try {
      const out = execSync(cmd, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) {
        for (const pid of out.split(/\s+/)) {
          const s = pid.trim();
          if (s && /^\d+$/.test(s)) pids.add(s);
        }
      }
    } catch {
      /* 无占用 */
    }
  }

  return pids;
}

/** @param {string} pid */
function processStat(pid) {
  try {
    return execSync(`ps -p ${pid} -o stat=`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/** @param {string} pid */
function processGroupId(pid) {
  try {
    return execSync(`ps -p ${pid} -o pgid=`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "";
  }
}

/**
 * @param {number} n
 * @param {NodeJS.Signals | number} sig
 */
function signalPid(n, sig) {
  try {
    process.kill(n, sig);
    return true;
  } catch {
    try {
      const name = typeof sig === "string" ? sig.replace(/^SIG/, "") : String(sig);
      execSync(`kill -${name} ${n}`, { stdio: "ignore" });
      return true;
    } catch {
      return false;
    }
  }
}

/** @param {string} pid */
function forceKillPid(pid) {
  const n = Number(pid);
  if (!Number.isFinite(n) || n <= 1 || n === process.pid) return;

  const stat = processStat(pid);
  if (stat.includes("T") || stat.includes("t")) {
    signalPid(n, "SIGCONT");
  }

  signalPid(n, "SIGTERM");
  signalPid(n, "SIGKILL");

  const pgid = processGroupId(pid);
  if (pgid && pgid !== "1" && pgid !== String(process.pid)) {
    try {
      execSync(`kill -CONT -${pgid}`, { stdio: "ignore" });
    } catch {
      /* ignore */
    }
    try {
      execSync(`kill -9 -${pgid}`, { stdio: "ignore" });
    } catch {
      /* ignore */
    }
  }
}

/** @param {string | number} port */
export function isPortInUse(port) {
  return collectPidsOnPort(port).size > 0;
}

/**
 * 探测本机能否 bind（不依赖 lsof，可避开僵死 LISTEN 的误判边缘情况）。
 * @param {number} port
 * @returns {Promise<boolean>}
 */
export function canBindPort(port) {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.unref();
    s.once("error", () => resolve(false));
    s.listen(port, "127.0.0.1", () => {
      s.close(() => resolve(true));
    });
  });
}

/**
 * @param {number} startPort
 * @param {number} [span]
 * @returns {Promise<number | null>}
 */
export async function findFreePortNear(startPort, span = 20) {
  const base = Number(startPort) || 3851;
  for (let i = 0; i <= span; i++) {
    const p = base + i;
    if (p > 65535) break;
    if (await canBindPort(p)) return p;
  }
  return null;
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
  /** @type {string[]} */
  const wedged = [];

  for (let round = 0; round < 6; round++) {
    if (await canBindPort(Number(p))) {
      if (killed.size) {
        console.log(`[${label}] 已释放 127.0.0.1:${p}（结束 PID: ${[...killed].join(", ")}）`);
      }
      return true;
    }

    const pids = collectPidsOnPort(p);
    for (const pid of pids) {
      const st = processStat(pid);
      if (st.includes("UE") || st.includes("U")) {
        wedged.push(`${pid}(${st || "?"})`);
      }
      killed.add(pid);
      forceKillPid(pid);
    }

    try {
      execSync("pkill -9 -f src/collector-ui-server.js", { stdio: "ignore" });
    } catch {
      /* 无匹配 */
    }
    try {
      execSync("pkill -9 -f collector-ui-server.js", { stdio: "ignore" });
    } catch {
      /* 无匹配 */
    }

    await sleep(round === 0 ? 300 : 500);
  }

  if (await canBindPort(Number(p))) {
    if (killed.size) {
      console.log(`[${label}] 已释放 127.0.0.1:${p}（结束 PID: ${[...killed].join(", ")}）`);
    }
    return true;
  }

  const remain = [...collectPidsOnPort(p)];
  const tip = wedged.length
    ? ` 僵死进程 ${wedged.join(", ")}（macOS STAT=UE，kill -9 往往无效，需重启终端会话或换端口）`
    : "";
  console.warn(
    `[${label}] 警告: 127.0.0.1:${p} 仍被占用（PID: ${remain.join(", ") || "未知"}）。${tip}`
  );
  return false;
}
