/**
 * Local：Telegram 群组回溯（backfill_groups.json + backfill_scan.py）。
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { requireLocalRequest } from "./local-request.js";
import { createLogger } from "./logger.js";
import { CHANNEL_PROFILES_FILE, readTelegramChannelProfiles } from "./telegram-channel-profiles.js";
import { enrichTelegramBackfillFile } from "./telegram-backfill-enrich.js";
import {
  applyMarketOverridesToPayload,
  mutateMarketEntryOverrides,
  readMarketEntryOverrides,
} from "./telegram-backfill-market-entry.js";

const log = createLogger("telegram-backfill");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TELEGRAM_DIR = path.resolve(__dirname, "..", "..", "telegram");
const BACKFILL_CONFIG = path.join(TELEGRAM_DIR, "backfill_groups.json");
const CACHE_DIR = path.join(TELEGRAM_DIR, ".backfill_cache");
const HISTORY_DIR = path.join(CACHE_DIR, "history");
const SCAN_SCRIPT = path.join(TELEGRAM_DIR, "backfill_scan.py");
const RUNNING_FILE = path.join(CACHE_DIR, "running.json");
const LAST_RUN_FILE = path.join(CACHE_DIR, "last_run.json");

/** @type {import("node:child_process").ChildProcess | null} */
let activeChild = null;

/** @type {null | {
 *   running: boolean;
 *   period: string;
 *   runId: string | null;
 *   file: string;
 *   startedAt: string;
 *   finishedAt?: string;
 *   error?: string;
 *   progress?: { groupIndex: number; groupTotal: number; groupName: string };
 * }} */
let rebacktestJob = null;

/** @type {Record<string, { days: number, label: string }>} */
export const BACKFILL_PERIODS = {
  week: { days: 7, label: "近 1 周" },
  month1: { days: 30, label: "近 1 月" },
  month2: { days: 60, label: "近 2 月" },
  month3: { days: 90, label: "近 3 月" },
  month4: { days: 120, label: "近 4 月" },
};

function resolvePythonBin() {
  if (process.env.TELEGRAM_LISTEN_PYTHON) return process.env.TELEGRAM_LISTEN_PYTHON;
  const venvPy =
    process.platform === "win32"
      ? path.join(TELEGRAM_DIR, "venv", "Scripts", "python.exe")
      : path.join(TELEGRAM_DIR, "venv", "bin", "python");
  if (fs.existsSync(venvPy)) return venvPy;
  return process.platform === "win32" ? "python" : "python3";
}

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {unknown} raw
 * @returns {keyof typeof BACKFILL_PERIODS}
 */
export function normalizePeriod(raw) {
  const p = String(raw ?? "week").trim().toLowerCase();
  if (p === "month" || p === "30d" || p === "m" || p === "1m") return "month1";
  if (p in BACKFILL_PERIODS) return /** @type {keyof typeof BACKFILL_PERIODS} */ (p);
  return "week";
}

/**
 * @param {string} period
 */
function cachePathForPeriod(period) {
  return path.join(CACHE_DIR, `${normalizePeriod(period)}.latest.json`);
}

/**
 * @param {string} period
 * @param {string} runId
 */
function historyFilePath(period, runId) {
  const safe = String(runId).replace(/[^\w.-]/g, "_");
  return path.join(HISTORY_DIR, normalizePeriod(period), `${safe}.json`);
}

function msgLimitForPeriod(period) {
  const env = Number(process.env.TELEGRAM_BACKFILL_MSG_LIMIT);
  if (Number.isFinite(env) && env > 0) return env;
  const key = normalizePeriod(period);
  const map = { week: 4000, month1: 8000, month2: 12000, month3: 16000, month4: 20000 };
  return map[key] ?? 4000;
}

/**
 * @param {unknown} cfg
 */
function mergeBackfillConfig(cfg) {
  const profiles = readTelegramChannelProfiles();
  const profileMap = Object.fromEntries(profiles.channels.map((c) => [c.chatId, c]));
  const rawGroups = cfg && typeof cfg === "object" && Array.isArray(cfg.groups) ? cfg.groups : [];
  /** @type {Array<Record<string, unknown>>} */
  const groups = [];
  for (const g of rawGroups) {
    if (!g || typeof g !== "object") continue;
    const chatId = String(g.chatId ?? g.chat_id ?? "").trim();
    if (!chatId) continue;
    const prof = profileMap[chatId];
    groups.push({
      chatId,
      name: String(g.name ?? prof?.name ?? chatId).trim(),
      avatar: String(g.avatar ?? prof?.avatar ?? "").trim(),
      enabled: g.enabled !== false,
      note: String(g.note ?? "").trim(),
    });
  }
  return {
    ok: true,
    configFile: BACKFILL_CONFIG,
    profilesFile: CHANNEL_PROFILES_FILE,
    periods: BACKFILL_PERIODS,
    groups,
  };
}

function sessionStemFromEnv(name) {
  return String(name ?? "telegram_client")
    .trim()
    .replace(/\.session$/i, "");
}

/** 回溯用独立 .session 副本，避免与 listen.py 争用 runlock / SQLite */
function ensureBackfillSessionStem() {
  const mainStem = sessionStemFromEnv(process.env.TELEGRAM_SESSION_NAME);
  const backfillStem = sessionStemFromEnv(
    process.env.TELEGRAM_BACKFILL_SESSION_NAME || `${mainStem}_backfill`,
  );
  const mainFile = path.join(TELEGRAM_DIR, `${mainStem}.session`);
  const backfillFile = path.join(TELEGRAM_DIR, `${backfillStem}.session`);
  if (!fs.existsSync(backfillFile) && fs.existsSync(mainFile)) {
    try {
      fs.copyFileSync(mainFile, backfillFile);
      for (const suf of ["-journal", "-wal", "-shm"]) {
        const src = mainFile + suf;
        const dst = backfillFile + suf;
        if (fs.existsSync(src)) fs.copyFileSync(src, dst);
      }
      log.info(`已复制 Telegram 会话 → ${backfillStem}.session（回溯专用，可与 listen 并行）`);
    } catch (e) {
      log.warn(`复制回溯会话失败: ${String(/** @type {Error} */ (e).message ?? e)}`);
    }
  }
  return backfillStem;
}

function readLastRun() {
  const raw = readJsonFile(LAST_RUN_FILE);
  return raw && typeof raw === "object" ? raw : null;
}

function readRunningState() {
  const raw = readJsonFile(RUNNING_FILE);
  const lastRun = readLastRun();
  if (activeChild && !activeChild.killed) {
    return { running: true, lastRun, ...(raw && typeof raw === "object" ? raw : {}) };
  }
  if (raw && typeof raw === "object" && raw.pid && !activeChild) {
    try {
      process.kill(Number(raw.pid), 0);
      return { running: true, lastRun, ...raw };
    } catch {
      /* stale */
    }
  }
  return { running: false, lastRun, ...(raw && typeof raw === "object" ? raw : {}) };
}

/**
 * @param {string} period
 */
function listHistoryRuns(period) {
  const key = normalizePeriod(period);
  const dir = path.join(HISTORY_DIR, key);
  if (!fs.existsSync(dir)) return [];
  /** @type {Array<{ id: string, file: string, generatedAt: string, fromMs: number, toMs: number, groupCount: number }>} */
  const runs = [];
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith(".json")) continue;
    const file = path.join(dir, name);
    const data = readJsonFile(file);
    if (!data || typeof data !== "object") continue;
    runs.push({
      id: name.replace(/\.json$/i, ""),
      file,
      generatedAt: String(data.generatedAt ?? ""),
      fromMs: Number(data.fromMs) || 0,
      toMs: Number(data.toMs) || 0,
      groupCount: Number(data.groupCount) || 0,
    });
  }
  runs.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
  return runs;
}

function stopActiveBackfill() {
  if (!activeChild || activeChild.killed) {
    activeChild = null;
    try {
      if (fs.existsSync(RUNNING_FILE)) fs.unlinkSync(RUNNING_FILE);
    } catch {
      /* ignore */
    }
    return { stopped: false, reason: "not_running" };
  }
  const pid = activeChild.pid;
  try {
    activeChild.kill("SIGTERM");
  } catch {
    /* ignore */
  }
  activeChild = null;
  try {
    if (fs.existsSync(RUNNING_FILE)) fs.unlinkSync(RUNNING_FILE);
  } catch {
    /* ignore */
  }
  log.info(`Telegram 回溯已停止 pid=${pid ?? "?"}`);
  return { stopped: true, pid };
}

/**
 * @param {import("express").Express} app
 */
export function registerTelegramBackfillRoutes(app) {
  app.get("/api/local/telegram-backfill/config", requireLocalRequest, (_req, res) => {
    const cfg = readJsonFile(BACKFILL_CONFIG);
    if (!cfg) {
      return res.status(404).json({
        ok: false,
        error: `未找到 ${BACKFILL_CONFIG}，可从 backfill_groups.example.json 复制`,
      });
    }
    res.json(mergeBackfillConfig(cfg));
  });

  app.get("/api/local/telegram-backfill/history", requireLocalRequest, (req, res) => {
    const period = normalizePeriod(req.query.period);
    res.json({ ok: true, period, runs: listHistoryRuns(period) });
  });

  app.get("/api/local/telegram-backfill/results", requireLocalRequest, (req, res) => {
    const period = normalizePeriod(req.query.period);
    const runId = String(req.query.runId ?? req.query.file ?? "").trim();
    let file = cachePathForPeriod(period);
    if (runId) {
      file = historyFilePath(period, runId);
    }
    const data = readJsonFile(file);
    if (!data) {
      return res.json({
        ok: true,
        period,
        cached: false,
        file,
        runId: runId || null,
        groups: [],
        ranking: [],
      });
    }
    const merged = applyMarketOverridesToPayload(data, period);
    res.json({
      ok: true,
      cached: true,
      file,
      runId: runId || null,
      ...merged,
    });
  });

  app.get("/api/local/telegram-backfill/market-entry-overrides", requireLocalRequest, (req, res) => {
    const period = normalizePeriod(req.query.period);
    const chatId = String(req.query.chatId ?? "").trim();
    const overrides = chatId
      ? readMarketEntryOverrides(period, chatId)
      : readMarketEntryOverrides(period);
    res.json({ ok: true, period, chatId: chatId || null, overrides });
  });

  app.post("/api/local/telegram-backfill/market-entry-overrides", requireLocalRequest, async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const period = normalizePeriod(body.period ?? req.query.period);
    const chatId = String(body.chatId ?? "").trim();
    const action = String(body.action ?? "apply").trim().toLowerCase() === "clear" ? "clear" : "apply";
    const rawDigests = Array.isArray(body.digests) ? body.digests : [];
    const digests = rawDigests.map((x) => String(x ?? "").trim()).filter(Boolean);
    if (!chatId) {
      return res.status(400).json({ ok: false, error: "缺少 chatId" });
    }
    if (!digests.length) {
      return res.status(400).json({ ok: false, error: "请至少选择一张卡片" });
    }
    const file = cachePathForPeriod(period);
    const data = readJsonFile(file);
    if (!data || !Array.isArray(data.groups)) {
      return res.status(404).json({ ok: false, error: "尚无回溯结果，请先完成回溯" });
    }
    const group = data.groups.find((g) => String(g?.chatId ?? "") === chatId);
    if (!group) {
      return res.status(404).json({ ok: false, error: "该群不在当前周期结果中" });
    }
    try {
      const result = await mutateMarketEntryOverrides({
        period,
        chatId,
        group,
        digests,
        action,
      });
      const refreshed = readJsonFile(file);
      const merged = applyMarketOverridesToPayload(refreshed ?? data, period);
      res.json({
        ok: true,
        period,
        chatId,
        action,
        ...result,
        group: merged.groups?.find((g) => String(g?.chatId ?? "") === chatId) ?? null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.get("/api/local/telegram-backfill/status", requireLocalRequest, (_req, res) => {
    const state = readRunningState();
    res.json({
      ok: true,
      periods: BACKFILL_PERIODS,
      ...state,
      rebacktest: rebacktestJob,
      cacheDir: CACHE_DIR,
      script: SCAN_SCRIPT,
    });
  });

  app.post("/api/local/telegram-backfill/rebacktest", requireLocalRequest, (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const period = normalizePeriod(body.period ?? req.query.period);
    const runId = String(body.runId ?? req.query.runId ?? "").trim();
    let file = cachePathForPeriod(period);
    if (runId) file = historyFilePath(period, runId);
    if (!fs.existsSync(file)) {
      return res.status(404).json({ ok: false, error: "尚无回溯缓存，请先完成一次回溯" });
    }
    if (rebacktestJob?.running) {
      return res.status(409).json({
        ok: false,
        error: "批量盈亏回溯进行中，请等待完成或重启 collect:ui",
        rebacktest: rebacktestJob,
      });
    }
    const maxPer = Math.min(
      200,
      Math.max(1, Number(process.env.TELEGRAM_BACKFILL_MAX_BACKTEST_SIGNALS) || 200),
    );
    const skipBacktestCache = Boolean(body.skipBacktestCache ?? body.skipCache);
    const startedAt = new Date().toISOString();
    rebacktestJob = {
      running: true,
      period,
      runId: runId || null,
      file,
      startedAt,
    };
    res.json({
      ok: true,
      async: true,
      period,
      runId: runId || null,
      file,
      message: "批量盈亏已在后台执行，可刷新页面；进度见状态轮询",
    });
    void (async () => {
      /** @type {{ groupIndex: number; groupTotal: number; groupName: string } | undefined} */
      let lastProgress;
      try {
        const data = await enrichTelegramBackfillFile(file, {
          maxBacktestsPerGroup: maxPer,
          skipBacktestCache,
          onGroupDone: (info) => {
            lastProgress = info;
            if (rebacktestJob?.running) rebacktestJob.progress = info;
          },
        });
        rebacktestJob = {
          running: false,
          period,
          runId: runId || null,
          file,
          startedAt,
          finishedAt: new Date().toISOString(),
          progress: lastProgress,
          groupCount: Array.isArray(data?.groups) ? data.groups.length : 0,
          ok: true,
        };
      } catch (e) {
        const msg = String(/** @type {Error} */ (e).message ?? e);
        log.warn(`Telegram batch 盈亏失败: ${msg}`);
        rebacktestJob = {
          running: false,
          period,
          runId: runId || null,
          file,
          startedAt,
          finishedAt: new Date().toISOString(),
          error: msg,
          progress: lastProgress,
        };
      }
    })();
  });

  app.post("/api/local/telegram-backfill/stop", requireLocalRequest, (_req, res) => {
    const result = stopActiveBackfill();
    if (!result.stopped && result.reason === "not_running") {
      return res.json({ ok: true, stopped: false, message: "当前没有进行中的回溯" });
    }
    res.json({ ok: true, ...result });
  });

  app.post("/api/local/telegram-backfill/run", requireLocalRequest, (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const period = normalizePeriod(body.period ?? req.query.period);
    if (readRunningState().running) {
      return res.status(409).json({ ok: false, error: "回溯任务进行中，请先停止或等待完成" });
    }
    if (!fs.existsSync(SCAN_SCRIPT)) {
      return res.status(500).json({ ok: false, error: `缺少 ${SCAN_SCRIPT}` });
    }
    if (!fs.existsSync(BACKFILL_CONFIG)) {
      return res.status(404).json({
        ok: false,
        error: "请先创建 telegram/backfill_groups.json",
      });
    }

    fs.mkdirSync(CACHE_DIR, { recursive: true });
    const outFile = cachePathForPeriod(period);
    const py = resolvePythonBin();
    const startedAt = new Date().toISOString();
    const limit = msgLimitForPeriod(period);
    const rawIds = Array.isArray(body.chatIds) ? body.chatIds : [];
    /** @type {string[]} */
    const chatIds = rawIds.map((x) => String(x ?? "").trim()).filter(Boolean);
    if (!chatIds.length) {
      return res.status(400).json({ ok: false, error: "请至少选择一个群组" });
    }

    const forceFull = Boolean(body.force ?? body.forceFetch);
    /** @type {string[]} */
    const spawnArgs = [
      SCAN_SCRIPT,
      "--period",
      period,
      "--out",
      outFile,
      "--limit",
      String(limit),
      "--chat-ids",
      chatIds.join(","),
    ];
    if (forceFull) spawnArgs.push("--force");

    const backfillSessionStem = ensureBackfillSessionStem();
    /** @type {string[]} */
    let stderrLines = [];

    const child = spawn(py, spawnArgs, {
      cwd: TELEGRAM_DIR,
      env: {
        ...process.env,
        TELEGRAM_SESSION_NAME: backfillSessionStem,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    activeChild = child;

    const runningMeta = {
      pid: child.pid,
      period,
      startedAt,
      outFile,
      limit,
      chatIds,
      sessionName: backfillSessionStem,
    };
    fs.writeFileSync(RUNNING_FILE, JSON.stringify(runningMeta, null, 2), "utf8");

    child.stdout?.on("data", (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        if (line.trim()) log.info(`[backfill] ${line.trim()}`);
      }
    });
    child.stderr?.on("data", (buf) => {
      for (const line of String(buf).split(/\r?\n/)) {
        const t = line.trim();
        if (t) {
          stderrLines.push(t);
          if (stderrLines.length > 80) stderrLines = stderrLines.slice(-80);
          log.warn(`[backfill] ${t}`);
        }
      }
    });

    child.on("close", (code) => {
      activeChild = null;
      const ok = code === 0 && fs.existsSync(outFile);
      const stderrTail = stderrLines.join("\n").slice(-2500);
      let failHint = "";
      if (!ok) {
        if (/runlock|单实例锁|TELEGRAM_SESSION_NAME/i.test(stderrTail)) {
          failHint =
            "Telegram 会话被 listen/其它脚本占用；已尝试用 *_backfill 会话，若仍失败请重启 collect:ui 或暂时停 listen";
        } else if (/AuthKey|未登录|login/i.test(stderrTail)) {
          failHint = "Telegram 未登录：请先在 telegram/ 下跑通 listen.py 登录后再回溯";
        } else if (code === 3) {
          failHint = "无法获取 Telegram 会话锁（与其它 Telethon 进程冲突）";
        }
      }
      try {
        fs.writeFileSync(
          LAST_RUN_FILE,
          JSON.stringify(
            {
              ok,
              exitCode: code ?? null,
              period,
              startedAt,
              finishedAt: new Date().toISOString(),
              outFile,
              outFileExists: fs.existsSync(outFile),
              sessionName: backfillSessionStem,
              stderrTail,
              failHint,
            },
            null,
            2,
          ),
          "utf8",
        );
      } catch {
        /* ignore */
      }
      try {
        if (fs.existsSync(RUNNING_FILE)) fs.unlinkSync(RUNNING_FILE);
      } catch {
        /* ignore */
      }
      if (!ok) {
        log.warn(`Telegram 数据获取失败 code=${code ?? "?"} ${failHint || stderrTail.slice(0, 120)}`);
      } else {
        log.info(
          `Telegram 群消息/建卡数据已写入 period=${period}（盈亏回溯请在前端点「批量回溯盈亏」）`,
        );
      }
    });

    res.status(202).json({
      ok: true,
      accepted: true,
      period,
      startedAt,
      pid: child.pid,
      limit,
      hint: "轮询 GET /api/local/telegram-backfill/status 或 results",
    });
  });
}
