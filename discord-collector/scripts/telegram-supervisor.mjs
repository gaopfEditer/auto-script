/**
 * 守护 telegram/listen.py：collect:ui 启动后后台常驻，与 /telegram 页面无关。
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
 * @param {{
 *   log?: { info: Function; warn: Function; debug?: Function };
 *   enabled?: boolean;
 *   checkIntervalMs?: number;
 *   pythonBin?: string;
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

  /** @type {import("node:child_process").ChildProcess | null} */
  let child = null;
  let stopping = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  let starting = false;
  let lastStartAt = 0;
  /** @type {number | null} */
  let externalPid = null;

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

  async function ensureOnce() {
    if (stopping) return false;

    if (child && !child.killed) {
      externalPid = null;
      return true;
    }

    const externals = findExternalListenPids(undefined);
    if (externals.length) {
      externalPid = externals[0];
      log.debug?.(
        `[telegram-supervisor] 检测到外部 listen.py pid=${externalPid}，跳过重复拉起`,
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
    if (
      ["1", "true", "yes", "on"].includes(
        String(process.env.TELEGRAM_LISTEN_STOP_WITH_UI ?? "0").toLowerCase(),
      ) &&
      child &&
      !child.killed
    ) {
      try {
        child.kill("SIGTERM");
      } catch {
        /* ignore */
      }
    }
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
