/**
 * 守护 telegram/listen.py：collect:ui 启动后后台常驻，与 /telegram 页面无关。
 * 默认随 collect:ui 重启 listen（避免假在线的外部进程被误当成「已在线」）。
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");
const TELEGRAM_DIR = resolve(ROOT, "..", "telegram");
const LISTEN_SCRIPT = resolve(TELEGRAM_DIR, "listen.py");

function resolvePythonBin(preferred) {
  if (preferred) return preferred;
  if (process.env.TELEGRAM_LISTEN_PYTHON) return process.env.TELEGRAM_LISTEN_PYTHON;
  const venvPy =
    process.platform === "win32"
      ? resolve(TELEGRAM_DIR, "venv", "Scripts", "python.exe")
      : resolve(TELEGRAM_DIR, "venv", "bin", "python");
  if (existsSync(venvPy)) return venvPy;
  return process.platform === "win32" ? "python" : "python3";
}

/**
 * @param {number | undefined} excludePid
 * @returns {number[]}
 */
function findExternalListenPids(excludePid) {
  if (process.platform === "win32") return [];
  try {
    const out = execSync(`pgrep -f "${LISTEN_SCRIPT}"`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return [];
    return out
      .split(/\s+/)
      .map((s) => Number(s))
      .filter((pid) => Number.isFinite(pid) && pid > 0 && pid !== excludePid);
  } catch {
    return [];
  }
}

/**
 * @param {{ info?: Function; warn?: Function }} log
 * @param {number | undefined} keepPid 保留的 pid（通常为 supervisor 子进程）
 * @returns {number[]}
 */
function killAllListenPids(log, keepPid) {
  if (process.platform === "win32") return [];
  const pids = findExternalListenPids(keepPid);
  if (keepPid === undefined) {
    // 含当前子进程：再扫一遍全量
    try {
      const out = execSync(`pgrep -f "${LISTEN_SCRIPT}"`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
      }).trim();
      if (out) {
        for (const s of out.split(/\s+/)) {
          const pid = Number(s);
          if (Number.isFinite(pid) && pid > 0 && !pids.includes(pid)) pids.push(pid);
        }
      }
    } catch {
      /* none */
    }
  }
  for (const pid of pids) {
    try {
      process.kill(pid, "SIGTERM");
      log.info?.(`[telegram-supervisor] 已 SIGTERM listen.py pid=${pid}`);
    } catch (e) {
      log.warn?.(
        `[telegram-supervisor] 结束 listen pid=${pid} 失败: ${/** @type {Error} */ (e).message}`,
      );
    }
  }
  return pids;
}

/**
 * @param {{
 *   log?: { info: Function; warn: Function; debug?: Function };
 *   enabled?: boolean;
 *   checkIntervalMs?: number;
 *   pythonBin?: string;
 *   restartWithUi?: boolean;
 *   stopWithUi?: boolean;
 * }} [opts]
 */
export function startTelegramSupervisor(opts = {}) {
  const log = opts.log ?? console;
  const enabled =
    opts.enabled !== false &&
    !["0", "false", "no", "off"].includes(
      String(process.env.TELEGRAM_LISTEN_AUTO_START ?? "1").toLowerCase(),
    );
  if (!enabled) {
    log.info?.("[telegram-supervisor] 已关闭（TELEGRAM_LISTEN_AUTO_START=0）");
    return {
      stop() {},
      ensureOnce: async () => false,
      getStatus: () => ({ running: false, managed: false, pid: null, external: false }),
    };
  }

  if (!existsSync(LISTEN_SCRIPT)) {
    log.warn?.(`[telegram-supervisor] 未找到 ${LISTEN_SCRIPT}，跳过`);
    return {
      stop() {},
      ensureOnce: async () => false,
      getStatus: () => ({ running: false, managed: false, pid: null, external: false, error: "listen.py missing" }),
    };
  }

  const checkMs = Math.max(
    5_000,
    Number(opts.checkIntervalMs ?? process.env.TELEGRAM_SUPERVISOR_INTERVAL_MS ?? 20_000) || 20_000,
  );
  const pythonBin = resolvePythonBin(opts.pythonBin);
  /** collect:ui 每次启动时重启 listen（避免 Telethon 假在线、或误认外部旧进程） */
  const restartWithUi =
    opts.restartWithUi !== undefined
      ? opts.restartWithUi !== false
      : !["0", "false", "no", "off"].includes(
          String(process.env.TELEGRAM_RESTART_WITH_UI ?? "1").toLowerCase(),
        );
  const stopWithUi =
    opts.stopWithUi !== undefined
      ? opts.stopWithUi !== false
      : !["0", "false", "no", "off"].includes(
          String(process.env.TELEGRAM_LISTEN_STOP_WITH_UI ?? "1").toLowerCase(),
        );

  /** @type {import("node:child_process").ChildProcess | null} */
  let child = null;
  let stopping = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  let starting = false;
  let lastStartAt = 0;
  /** @type {number | null} */
  let externalPid = null;
  let bootstrapPending = true;

  const logDir = resolve(ROOT, "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = resolve(logDir, "telegram-listen.log");

  function spawnListen() {
    if (stopping || starting) return false;
    const now = Date.now();
    if (now - lastStartAt < 15_000 && child && !child.killed) return true;
    starting = true;
    lastStartAt = now;

    const out = createWriteStream(logPath, { flags: "a" });
    out.write(`\n---- spawn ${new Date().toISOString()} ----\n`);
    out.write(`python=${pythonBin}\nscript=${LISTEN_SCRIPT}\n`);

    child = spawn(pythonBin, [LISTEN_SCRIPT], {
      cwd: TELEGRAM_DIR,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    child.stdout?.pipe(out, { end: false });
    child.stderr?.pipe(out, { end: false });

    child.on("exit", (code, signal) => {
      log.warn?.(
        `[telegram-supervisor] listen.py 退出 code=${code} signal=${signal ?? ""} — 将自动重启`,
      );
      child = null;
      starting = false;
      externalPid = null;
    });
    child.on("error", (err) => {
      log.warn?.(`[telegram-supervisor] 启动失败: ${err.message}`);
      child = null;
      starting = false;
    });

    log.info?.(
      `[telegram-supervisor] 已拉起 listen.py (${pythonBin}) | log=${logPath}`,
    );
    starting = false;
    return true;
  }

  async function restartListen(reason) {
    log.info?.(`[telegram-supervisor] ${reason}`);
    if (child && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      child = null;
    }
    killAllListenPids(log, undefined);
    externalPid = null;
    await new Promise((r) => setTimeout(r, 1200));
    spawnListen();
    await new Promise((r) => setTimeout(r, 2500));
    const ok = Boolean(child && !child.killed);
    if (ok) {
      log.info?.("[telegram-supervisor] listen.py 已由本进程托管");
    } else {
      log.warn?.(`[telegram-supervisor] 拉起后仍未在线；请检查 ${logPath} 与 python=${pythonBin}`);
    }
    return ok;
  }

  async function finishBootstrap() {
    bootstrapPending = false;
  }

  async function ensureOnce() {
    if (stopping) return false;

    if (bootstrapPending && restartWithUi) {
      await finishBootstrap();
      return restartListen("collect:ui 已启动，正在重启 listen.py（随主进程刷新 Telethon 连接）…");
    }
    await finishBootstrap();

    if (child && !child.killed) {
      externalPid = null;
      return true;
    }

    const externals = findExternalListenPids(child?.pid);
    if (externals.length) {
      if (restartWithUi) {
        return restartListen(
          `检测到外部 listen.py pid=${externals.join(",")}，正在接管为 supervisor 子进程…`,
        );
      }
      externalPid = externals[0];
      log.debug?.(
        `[telegram-supervisor] 检测到外部 listen.py pid=${externalPid}，跳过重复拉起（TELEGRAM_RESTART_WITH_UI=0）`,
      );
      return true;
    }

    externalPid = null;
    if (!spawnListen()) return false;
    await new Promise((r) => setTimeout(r, 2500));
    return Boolean(child && !child.killed);
  }

  void ensureOnce().then((ok) => {
    if (ok) log.info?.("[telegram-supervisor] telegram listen 已在线（后台常驻，与 /telegram 页面无关）");
  });

  timer = setInterval(() => {
    void ensureOnce().catch((e) =>
      log.warn?.(`[telegram-supervisor] 巡检失败: ${/** @type {Error} */ (e).message}`),
    );
  }, checkMs);

  function stop() {
    stopping = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (!stopWithUi) return;
    if (child && !child.killed) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
      child = null;
    }
    killAllListenPids(log, undefined);
    externalPid = null;
  }

  function getStatus() {
    const managed = Boolean(child && !child.killed);
    const external = Boolean(externalPid);
    const running = managed || external;
    return {
      running,
      managed,
      external,
      pid: managed ? child?.pid ?? null : externalPid,
      logPath,
      script: LISTEN_SCRIPT,
    };
  }

  return { stop, ensureOnce, getStatus };
}
