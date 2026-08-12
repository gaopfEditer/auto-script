/**
 * 守护 content_board（Python SQLite 图文 API，默认 :8767）。
 */
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");
const DEFAULT_BASE = "http://127.0.0.1:8767";

/**
 * @param {string} base
 * @param {number} timeoutMs
 */
async function probe(base, timeoutMs = 2500) {
  const root = String(base).replace(/\/$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${root}/api/content/health`, { signal: ctrl.signal });
    if (!r.ok) return false;
    const j = await r.json().catch(() => null);
    return Boolean(j && j.ok);
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

function resolvePython() {
  const venvPy = resolve(ROOT, "oi_mornitor/venv/bin/python");
  if (existsSync(venvPy)) return venvPy;
  return process.env.CONTENT_BOARD_PYTHON || "python3";
}

/**
 * @param {{ log?: Console, baseUrl?: string, checkIntervalMs?: number, enabled?: boolean }} [opts]
 */
export function startContentSupervisor(opts = {}) {
  const log = opts.log || console;
  const enabled = opts.enabled !== false;
  const baseUrl = String(opts.baseUrl || process.env.CONTENT_BOARD_BASE_URL || DEFAULT_BASE).replace(
    /\/$/,
    "",
  );
  const checkIntervalMs = Math.max(5_000, Number(opts.checkIntervalMs) || 20_000);
  if (!enabled) {
    return { stop() {} };
  }

  /** @type {import('node:child_process').ChildProcess | null} */
  let child = null;
  let stopped = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  let starting = false;

  const port = (() => {
    try {
      return new URL(baseUrl).port || "8767";
    } catch {
      return "8767";
    }
  })();

  async function ensure() {
    if (stopped || starting) return;
    if (await probe(baseUrl)) return;
    starting = true;
    try {
      if (child && !child.killed) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
        child = null;
      }
      const py = resolvePython();
      const logDir = resolve(ROOT, "logs");
      mkdirSync(logDir, { recursive: true });
      const out = createWriteStream(resolve(logDir, "content-board.log"), { flags: "a" });
      log.info?.(`[content-supervisor] 启动 content_board → ${baseUrl} (${py})`);
      child = spawn(
        py,
        ["-m", "content_board", "--host", "127.0.0.1", "--port", String(port)],
        {
          cwd: ROOT,
          env: {
            ...process.env,
            CONTENT_BOARD_PORT: String(port),
            PYTHONPATH: ROOT,
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      child.stdout?.pipe(out);
      child.stderr?.pipe(out);
      child.on("exit", (code, signal) => {
        log.warn?.(`[content-supervisor] 进程退出 code=${code} signal=${signal}`);
        child = null;
      });
    } finally {
      starting = false;
    }
  }

  void ensure();
  timer = setInterval(() => {
    void ensure();
  }, checkIntervalMs);

  return {
    stop() {
      stopped = true;
      if (timer) clearInterval(timer);
      timer = null;
      if (child && !child.killed) {
        try {
          child.kill("SIGTERM");
        } catch {
          /* ignore */
        }
      }
      child = null;
    },
  };
}
