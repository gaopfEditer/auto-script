/**
 * 确保 oi_mornitor 后台常驻：探测 :8765，挂了则拉起，挂了再重启。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");
const OI_DIR = resolve(ROOT, "oi_mornitor");
const DEFAULT_BASE = "http://127.0.0.1:8765";

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
  const pythonBin =
    opts.pythonBin ||
    process.env.OI_PYTHON ||
    process.env.PYTHON ||
    (process.platform === "win32" ? "python" : "python3");

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

    const args = [resolve(OI_DIR, "run.py"), "--backend-only", "--skip-build"];
    child = spawn(pythonBin, args, {
      cwd: ROOT,
      env: { ...process.env, PYTHONUNBUFFERED: "1" },
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

  async function ensureOnce() {
    if (stopping) return false;
    const ok = await probeOi(apiBase, Number(process.env.OI_HEALTH_TIMEOUT_MS ?? 3000));
    if (ok) return true;
    log.warn?.(`[oi-supervisor] ${apiBase} 未响应，正在拉起…`);
    spawnOi();
    // 等几秒再探
    await new Promise((r) => setTimeout(r, 2500));
    return probeOi(apiBase, 4000);
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

  return { stop, ensureOnce, get child() { return child; } };
}
