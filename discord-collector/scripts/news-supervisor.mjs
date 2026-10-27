/**
 * 守护 discord-collector/news_mornitor（默认 :8770）。
 * 与 auto-deal-eth CryptoPulse 同端口时，只认 service=news_mornitor，否则杀掉重拉。
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdirSync, createWriteStream } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");
const NEWS_DIR = resolve(ROOT, "news_mornitor");
const DEFAULT_BASE = "http://127.0.0.1:8770";
/** 正确实例的 health.service；CryptoPulse 为 "CryptoPulse" */
const EXPECTED_SERVICE = "news_mornitor";

/**
 * @param {string} base
 * @param {number} timeoutMs
 * @returns {Promise<{ ok: boolean, service?: string, wrong?: boolean, error?: string }>}
 */
async function probe(base, timeoutMs = 3000) {
  const root = String(base).replace(/\/$/, "");
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(`${root}/api/v1/health`, { signal: ctrl.signal });
    if (!r.ok) return { ok: false, error: `HTTP ${r.status}` };
    const j = await r.json().catch(() => null);
    if (!j || j.ok !== true) return { ok: false, error: "bad health body" };
    const service = typeof j.service === "string" ? j.service : "";
    if (service && service !== EXPECTED_SERVICE) {
      return { ok: false, wrong: true, service, error: `wrong service: ${service}` };
    }
    // 旧版无 service 字段时，再看首页是否仍是华尔街见闻
    if (!service) {
      try {
        const htmlRes = await fetch(`${root}/?_=${Date.now()}`, {
          signal: ctrl.signal,
          headers: { "Cache-Control": "no-cache" },
        });
        const html = htmlRes.ok ? await htmlRes.text() : "";
        if (/华尔街见闻|CryptoPulse|AkShare/i.test(html)) {
          return { ok: false, wrong: true, service: "CryptoPulse?", error: "legacy CryptoPulse UI" };
        }
      } catch {
        /* ignore */
      }
    }
    return { ok: true, service: service || EXPECTED_SERVICE };
  } catch (e) {
    return { ok: false, error: String(/** @type {Error} */ (e).message ?? e) };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} port
 * @param {{ log?: { info?: Function; warn?: Function } }} [opts]
 */
function freePort(port, opts = {}) {
  const log = opts.log || console;
  try {
    const out = execFileSync("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"], {
      encoding: "utf8",
      timeout: 5000,
    });
    const pids = [
      ...new Set(
        String(out)
          .split(/\s+/)
          .map((s) => s.trim())
          .filter(Boolean),
      ),
    ];
    for (const pid of pids) {
      try {
        process.kill(Number(pid), "SIGTERM");
        log.warn?.(`[news-supervisor] 已结束占用 :${port} 的进程 pid=${pid}`);
      } catch (e) {
        log.warn?.(`[news-supervisor] 结束 pid=${pid} 失败: ${/** @type {Error} */ (e).message}`);
      }
    }
  } catch {
    /* 无监听进程 */
  }
}

function resolvePython() {
  if (process.env.NEWS_PYTHON) return process.env.NEWS_PYTHON;
  const candidates = [
    // 仅复用 venv 依赖，不要跑 auto-deal-eth 的代码
    resolve(ROOT, "..", "..", "auto-deal-eth", "news_mornitor", "venv", "bin", "python"),
    resolve(NEWS_DIR, "venv", "bin", "python"),
    resolve(ROOT, "oi_mornitor", "venv", "bin", "python"),
  ];
  for (const p of candidates) {
    if (existsSync(p)) return p;
  }
  return process.platform === "win32" ? "python" : "python3";
}

/**
 * @param {{
 *   log?: { info: Function; warn: Function };
 *   baseUrl?: string;
 *   checkIntervalMs?: number;
 *   enabled?: boolean;
 * }} [opts]
 */
export function startNewsSupervisor(opts = {}) {
  const log = opts.log || console;
  const enabled =
    opts.enabled !== false &&
    !["0", "false", "no", "off"].includes(
      String(process.env.NEWS_AUTO_START ?? "1").toLowerCase(),
    );
  const baseUrl = String(
    opts.baseUrl || process.env.NEWS_WEB_BASE_URL || DEFAULT_BASE,
  ).replace(/\/$/, "");
  const checkIntervalMs = Math.max(
    5_000,
    Number(opts.checkIntervalMs ?? process.env.NEWS_SUPERVISOR_INTERVAL_MS ?? 20_000) ||
      20_000,
  );

  if (!enabled) {
    log.info?.("[news-supervisor] 已关闭（NEWS_AUTO_START=0）");
    return { stop() {} };
  }

  if (!existsSync(resolve(NEWS_DIR, "run.py"))) {
    log.warn?.(`[news-supervisor] 未找到 ${NEWS_DIR}/run.py，跳过`);
    return { stop() {} };
  }

  /** @type {import("node:child_process").ChildProcess | null} */
  let child = null;
  let stopped = false;
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  let starting = false;
  let lastStartAt = 0;

  const port = (() => {
    try {
      return new URL(baseUrl).port || "8770";
    } catch {
      return "8770";
    }
  })();

  const logDir = resolve(ROOT, "logs");
  mkdirSync(logDir, { recursive: true });
  const logPath = resolve(logDir, "news-mornitor.log");

  function spawnNews() {
    if (stopped || starting) return;
    const now = Date.now();
    if (now - lastStartAt < 8_000) return;
    starting = true;
    lastStartAt = now;

    // 先清端口：避免 CryptoPulse / 僵死进程占着 health 通但 UI 不对
    freePort(port, { log });

    const py = resolvePython();
    const out = createWriteStream(logPath, { flags: "a" });
    out.write(`\n---- spawn ${new Date().toISOString()} ----\n`);
    out.write(`python=${py}\nbase=${baseUrl}\nexpected=${EXPECTED_SERVICE}\n`);

    child = spawn(py, [resolve(NEWS_DIR, "run.py"), "web", "--port", String(port)], {
      cwd: ROOT,
      env: {
        ...process.env,
        PYTHONUNBUFFERED: "1",
        PYTHONPATH: ROOT,
        CRYPTO_PULSE_PORT: String(port),
        CRYPTO_PULSE_HOST: "127.0.0.1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    child.stdout?.pipe(out, { end: false });
    child.stderr?.pipe(out, { end: false });
    child.on("exit", (code, signal) => {
      log.warn?.(
        `[news-supervisor] news_mornitor 退出 code=${code} signal=${signal ?? ""} — 将自动重启`,
      );
      child = null;
      starting = false;
    });
    child.on("error", (err) => {
      log.warn?.(`[news-supervisor] 启动失败: ${err.message}`);
      child = null;
      starting = false;
    });
    log.info?.(
      `[news-supervisor] 已拉起 discord-collector news_mornitor → ${baseUrl} (${py}) | log=${logPath}`,
    );
    starting = false;
  }

  async function ensure() {
    if (stopped) return false;
    const st = await probe(baseUrl);
    if (st.ok) return true;
    if (st.wrong) {
      log.warn?.(
        `[news-supervisor] :${port} 被其他服务占用（${st.service || st.error}），将替换为金十/PANews 版`,
      );
    } else {
      log.warn?.(`[news-supervisor] ${baseUrl} 未响应（${st.error || "down"}），正在拉起…`);
    }
    spawnNews();
    await new Promise((r) => setTimeout(r, 2800));
    const again = await probe(baseUrl, 4000);
    if (again.ok) log.info?.(`[news-supervisor] news_mornitor 已在线 ${baseUrl}`);
    else log.warn?.(`[news-supervisor] 拉起后仍未就绪；请检查 ${logPath}`);
    return again.ok;
  }

  void ensure();
  timer = setInterval(() => {
    void ensure().catch((e) =>
      log.warn?.(`[news-supervisor] 巡检失败: ${/** @type {Error} */ (e).message}`),
    );
  }, checkIntervalMs);

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
      if (
        ["1", "true", "yes", "on"].includes(
          String(process.env.NEWS_STOP_WITH_UI ?? "0").toLowerCase(),
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
    },
    ensureOnce: ensure,
  };
}
