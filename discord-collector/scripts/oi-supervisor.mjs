/**
 * 确保本仓库 oi_mornitor 后台常驻：探测 :8765，
 * 若被旁路/旧实例占用则接管并拉起本目录进程。
 */
import { spawn, execSync } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");
const OI_DIR = resolve(ROOT, "oi_mornitor");
const DEFAULT_BASE = "http://127.0.0.1:8765";
const EXPECTED_PACKAGE_ROOT = OI_DIR;

/**
 * @param {string} base
 * @param {number} timeoutMs
 */
async function probeOi(base, timeoutMs = 3000) {
  const url = `${String(base).replace(/\/$/, "")}/api/snapshot`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    return r.ok;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} base
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: boolean; packageRoot: string | null; sandboxMax: number | null; maxWatch: number | null }>}
 */
async function probeOiIdentity(base, timeoutMs = 4000) {
  const url = `${String(base).replace(/\/$/, "")}/api/patterns`;
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal });
    if (!r.ok) return { ok: false, packageRoot: null, sandboxMax: null, maxWatch: null };
    const j = await r.json();
    const packageRoot = typeof j.package_root === "string" ? j.package_root : null;
    const sandboxMax =
      typeof j.sandbox_max_concurrent === "number" ? j.sandbox_max_concurrent : null;
    const maxWatch = typeof j.max_watch_symbols === "number" ? j.max_watch_symbols : null;
    return { ok: true, packageRoot, sandboxMax, maxWatch };
  } catch {
    return { ok: false, packageRoot: null, sandboxMax: null, maxWatch: null };
  } finally {
    clearTimeout(timer);
  }
}

function resolvePythonBin(preferred) {
  if (preferred) return preferred;
  if (process.env.OI_PYTHON) return process.env.OI_PYTHON;
  if (process.env.PYTHON) return process.env.PYTHON;
  const venvPy =
    process.platform === "win32"
      ? resolve(OI_DIR, "venv", "Scripts", "python.exe")
      : resolve(OI_DIR, "venv", "bin", "python");
  if (existsSync(venvPy)) return venvPy;
  return process.platform === "win32" ? "python" : "python3";
}

function killListenerOnPort(port, log) {
  try {
    if (process.platform === "win32") return false;
    const out = execSync(`lsof -tiTCP:${port} -sTCP:LISTEN`, {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (!out) return false;
    const pids = out.split(/\s+/).filter(Boolean);
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGTERM");
        log.warn?.(`[oi-supervisor] 已 SIGTERM 占用 :${port} 的进程 pid=${pid}`);
      } catch (e) {
        log.warn?.(
          `[oi-supervisor] 结束 pid=${pid} 失败: ${/** @type {Error} */ (e).message}`
        );
      }
    }
    return pids.length > 0;
  } catch {
    return false;
  }
}

function samePath(a, b) {
  if (!a || !b) return false;
  const norm = (p) =>
    String(p)
      .replace(/\/+$/, "")
      .toLowerCase();
  return norm(a) === norm(b);
}

/**
 * @param {{
 *   log?: { info: Function; warn: Function; debug?: Function };
 *   apiBase?: string;
 *   enabled?: boolean;
 *   checkIntervalMs?: number;
 *   pythonBin?: string;
 * }} [opts]
 */
export function startOiSupervisor(opts = {}) {
  const log = opts.log ?? console;
  const enabled =
    opts.enabled !== false &&
    !["0", "false", "no", "off"].includes(String(process.env.OI_AUTO_START ?? "1").toLowerCase());
  if (!enabled) {
    log.info?.("[oi-supervisor] 已关闭（OI_AUTO_START=0）");
    return { stop() {}, ensureOnce: async () => false };
  }

  const apiBase = String(opts.apiBase || process.env.OI_WEB_BASE_URL || DEFAULT_BASE).replace(
    /\/$/,
    ""
  );
  const checkMs = Math.max(
    5_000,
    Number(opts.checkIntervalMs ?? process.env.OI_SUPERVISOR_INTERVAL_MS ?? 15_000) || 15_000
  );
  const pythonBin = resolvePythonBin(opts.pythonBin);
  const takeover =
    !["0", "false", "no", "off"].includes(
      String(process.env.OI_TAKEOVER_PORT ?? "1").toLowerCase()
    );

  /** @type {import("node:child_process").ChildProcess | null} */
  let child = null;
  let stopping = false;
  let timer = null;
  let starting = false;
  let lastStartAt = 0;

  const logDir = resolve(OI_DIR, "data");
  if (!existsSync(logDir)) mkdirSync(logDir, { recursive: true });
  const logPath = resolve(logDir, "oi-supervisor.log");

  function spawnOi() {
    if (stopping || starting) return;
    const now = Date.now();
    // 防抖：15s 内不重复拉起
    if (now - lastStartAt < 15_000 && child && !child.killed) return;
    starting = true;
    lastStartAt = now;

    const out = createWriteStream(logPath, { flags: "a" });
    out.write(`\n---- spawn ${new Date().toISOString()} ----\n`);
    out.write(`python=${pythonBin}\npackage_root=${EXPECTED_PACKAGE_ROOT}\n`);

    const args = [resolve(OI_DIR, "run.py"), "--backend-only", "--skip-build"];
    const childEnv = {
      ...process.env,
      PYTHONUNBUFFERED: "1",
      // 与 OI_WEB_BASE_URL 对齐，避免仍监听被旁路占用的 8765
      OI_WEB_PORT:
        process.env.OI_WEB_PORT ||
        (() => {
          try {
            return new URL(apiBase).port || "8765";
          } catch {
            return "8765";
          }
        })(),
    };
    child = spawn(pythonBin, args, {
      cwd: ROOT,
      env: childEnv,
      stdio: ["ignore", "pipe", "pipe"],
      detached: false,
    });

    child.stdout?.pipe(out, { end: false });
    child.stderr?.pipe(out, { end: false });

    child.on("exit", (code, signal) => {
      log.warn?.(
        `[oi-supervisor] oi_mornitor 退出 code=${code} signal=${signal ?? ""} — 将自动重启`
      );
      child = null;
      starting = false;
    });
    child.on("error", (err) => {
      log.warn?.(`[oi-supervisor] 启动失败: ${err.message}`);
      child = null;
      starting = false;
    });

    log.info?.(
      `[oi-supervisor] 已拉起 oi_mornitor (${pythonBin} run.py --backend-only) → ${apiBase} | log=${logPath}`
    );
    starting = false;
  }

  /**
   * @returns {Promise<boolean>}
   */
  async function isOurInstance() {
    const id = await probeOiIdentity(apiBase);
    if (!id.ok) return false;
    if (id.packageRoot) return samePath(id.packageRoot, EXPECTED_PACKAGE_ROOT);
    // 旧实例无 package_root：视为旁路，需接管
    log.warn?.(
      `[oi-supervisor] :8765 响应但无 package_root（旁路/旧代码） sandbox_max=${id.sandboxMax} max_watch=${id.maxWatch}`
    );
    return false;
  }

  async function ensureOnce() {
    if (stopping) return false;
    const up = await probeOi(apiBase, Number(process.env.OI_HEALTH_TIMEOUT_MS ?? 3000));
    if (up) {
      const ours = await isOurInstance();
      if (ours) return true;
      if (!takeover) {
        log.warn?.(
          `[oi-supervisor] 检测到非本仓库 oi（${EXPECTED_PACKAGE_ROOT}），已设 OI_TAKEOVER_PORT=0，跳过接管`
        );
        return false;
      }
      log.warn?.(
        `[oi-supervisor] 检测到非本仓库 oi 占用 ${apiBase}，正在接管 → ${EXPECTED_PACKAGE_ROOT}`
      );
      const port = Number(new URL(apiBase).port || 8765);
      killListenerOnPort(port, log);
      await new Promise((r) => setTimeout(r, 1200));
    } else {
      log.warn?.(`[oi-supervisor] ${apiBase} 未响应，正在拉起…`);
    }
    spawnOi();
    await new Promise((r) => setTimeout(r, 3500));
    const ok = (await probeOi(apiBase, 4000)) && (await isOurInstance());
    if (ok) {
      log.info?.(`[oi-supervisor] 本仓库 oi_mornitor 已在线 ${apiBase}`);
    } else {
      log.warn?.(
        `[oi-supervisor] 拉起后仍未确认为本仓库实例；请检查 ${logPath} 与 python=${pythonBin}`
      );
    }
    return ok;
  }

  void ensureOnce().then((ok) => {
    if (ok) log.info?.(`[oi-supervisor] oi_mornitor 已在线 ${apiBase}`);
  });

  timer = setInterval(() => {
    void ensureOnce().catch((e) =>
      log.warn?.(`[oi-supervisor] 巡检失败: ${/** @type {Error} */ (e).message}`)
    );
  }, checkMs);

  function stop() {
    stopping = true;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    // 不杀 oi 子进程：希望 collect:ui 退出后 oi 仍可独立跑；若需联动可设 OI_STOP_WITH_UI=1
    if (
      ["1", "true", "yes", "on"].includes(String(process.env.OI_STOP_WITH_UI ?? "0").toLowerCase()) &&
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

  return {
    stop,
    ensureOnce,
    get child() {
      return child;
    },
  };
}
