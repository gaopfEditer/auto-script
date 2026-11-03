/**
 * Local：巨鲸 kolvip 手动回溯（Discord 同款 period/频道/历史/批量盈亏）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { enrichDiscordBackfillFile } from "./discord-backfill-enrich.js";
import {
  KOLVIP_BACKFILL_PERIODS,
  loadKolvipManualBackfillGroups,
  normalizeKolvipBackfillPeriod,
  runKolvipManualBackfillScan,
} from "./kolvip-backfill-manual-engine.js";
import { requireLocalRequest } from "./local-request.js";
import { createLogger } from "./logger.js";

const log = createLogger("kolvip-manual-backfill");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
const CACHE_DIR = path.join(DATA_DIR, ".kolvip_backfill_cache");
const HISTORY_DIR = path.join(CACHE_DIR, "history");
const RUNNING_FILE = path.join(CACHE_DIR, "running.json");
const LAST_RUN_FILE = path.join(CACHE_DIR, "last_run.json");

/** @type {{ abort: boolean; promise: Promise<void> | null }} */
const jobState = { abort: false, promise: null };

/** @type {Record<string, unknown> | null} */
let rebacktestJob = null;

function readJsonFile(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, "utf8"));
  } catch {
    return null;
  }
}

/**
 * @param {string} period
 */
function cachePathForPeriod(period) {
  return path.join(CACHE_DIR, `${normalizeKolvipBackfillPeriod(period)}.latest.json`);
}

/**
 * @param {string} period
 * @param {string} runId
 */
function historyFilePath(period, runId) {
  const safe = String(runId).replace(/[^\w.-]/g, "_");
  return path.join(HISTORY_DIR, normalizeKolvipBackfillPeriod(period), `${safe}.json`);
}

function readLastRun() {
  const raw = readJsonFile(LAST_RUN_FILE);
  return raw && typeof raw === "object" ? raw : null;
}

function readRunningState() {
  const raw = readJsonFile(RUNNING_FILE);
  const lastRun = readLastRun();
  const running = Boolean(jobState.promise);
  if (running) {
    return { running: true, lastRun, ...(raw && typeof raw === "object" ? raw : {}) };
  }
  return { running: false, lastRun, ...(raw && typeof raw === "object" ? raw : {}) };
}

/**
 * @param {{
 *   store: Record<string, unknown>;
 *   signalCards: unknown;
 * }} deps
 */
export function registerKolvipManualBackfillRoutes(app, deps) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(HISTORY_DIR, { recursive: true });

  app.get("/api/local/kolvip-backfill/config", requireLocalRequest, async (_req, res) => {
    try {
      const groups = await loadKolvipManualBackfillGroups();
      res.json({
        ok: true,
        groups,
        periods: KOLVIP_BACKFILL_PERIODS,
        cacheDir: CACHE_DIR,
        note:
          "精选映射 + 目录 browse 频道；「开始获取数据」仅拉取/建卡，「批量回溯盈亏」单独限速跑 K 线",
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.get("/api/local/kolvip-backfill/history", requireLocalRequest, (req, res) => {
    const period = normalizeKolvipBackfillPeriod(req.query.period);
    const dir = path.join(HISTORY_DIR, period);
    /** @type {Array<{ id: string; generatedAt: string; groupCount: number }>} */
    const runs = [];
    if (fs.existsSync(dir)) {
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith(".json")) continue;
        const data = readJsonFile(path.join(dir, name));
        if (!data) continue;
        runs.push({
          id: name.replace(/\.json$/, ""),
          generatedAt: String(data.generatedAt ?? ""),
          groupCount: Number(data.groupCount) || (Array.isArray(data.groups) ? data.groups.length : 0),
        });
      }
      runs.sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)));
    }
    res.json({ ok: true, period, runs });
  });

  app.get("/api/local/kolvip-backfill/results", requireLocalRequest, (req, res) => {
    const period = normalizeKolvipBackfillPeriod(req.query.period);
    const runId = String(req.query.runId ?? req.query.run ?? "").trim();
    const file = runId ? historyFilePath(period, runId) : cachePathForPeriod(period);
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
    res.json({
      ok: true,
      cached: true,
      file,
      runId: runId || null,
      ...data,
      groups: Array.isArray(data.groups) ? data.groups : [],
    });
  });

  app.get("/api/local/kolvip-backfill/status", requireLocalRequest, (_req, res) => {
    const state = readRunningState();
    res.json({
      ok: true,
      periods: KOLVIP_BACKFILL_PERIODS,
      ...state,
      rebacktest: rebacktestJob,
      cacheDir: CACHE_DIR,
    });
  });

  app.post("/api/local/kolvip-backfill/rebacktest", requireLocalRequest, (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const period = normalizeKolvipBackfillPeriod(body.period ?? req.query.period);
    const runId = String(body.runId ?? req.query.runId ?? "").trim();
    let file = cachePathForPeriod(period);
    if (runId) file = historyFilePath(period, runId);
    if (!fs.existsSync(file)) {
      return res.status(404).json({ ok: false, error: "尚无回溯缓存，请先完成一次拉取/解析" });
    }
    if (rebacktestJob?.running) {
      return res.status(409).json({
        ok: false,
        error: "批量盈亏回溯进行中，请等待完成",
        rebacktest: rebacktestJob,
      });
    }
    const maxPer = Math.min(
      200,
      Math.max(1, Number(process.env.KOLVIP_BACKFILL_MAX_BACKTEST_SIGNALS) || 120),
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
      message: "巨鲸批量盈亏已在后台执行（限速），可刷新或轮询状态",
    });
    void (async () => {
      /** @type {{ groupIndex: number; groupTotal: number; groupName: string } | undefined} */
      let lastProgress;
      try {
        const data = await enrichDiscordBackfillFile(file, {
          maxBacktestsPerGroup: maxPer,
          skipBacktestCache,
          backtestCacheRoot: path.join(CACHE_DIR, "backtest"),
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
        log.warn(`巨鲸 batch 盈亏失败: ${msg}`);
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

  app.post("/api/local/kolvip-backfill/stop", requireLocalRequest, (_req, res) => {
    if (!jobState.promise) {
      return res.json({ ok: true, stopped: false, message: "当前没有进行中的回溯" });
    }
    jobState.abort = true;
    res.json({ ok: true, stopped: true, message: "已请求停止（当前频道处理完后结束）" });
  });

  app.post("/api/local/kolvip-backfill/run", requireLocalRequest, async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const period = normalizeKolvipBackfillPeriod(body.period ?? req.query.period);
    if (readRunningState().running) {
      return res.status(409).json({ ok: false, error: "回溯任务进行中，请先停止或等待完成" });
    }
    if (!deps.signalCards) {
      return res.status(500).json({ ok: false, error: "signalCards 未注入，无法建卡" });
    }

    let groups = await loadKolvipManualBackfillGroups();
    const channelIds = Array.isArray(body.channelIds)
      ? body.channelIds.map((x) => String(x).trim()).filter(Boolean)
      : Array.isArray(body.kolvipChannelIds)
        ? body.kolvipChannelIds.map((x) => String(x).trim()).filter(Boolean)
        : [];
    if (channelIds.length) {
      groups = groups.filter((g) => channelIds.includes(String(g.channelId)));
    }
    if (!groups.length) {
      return res.status(400).json({ ok: false, error: "没有可回溯的频道（检查配置与勾选）" });
    }

    const startedAt = new Date().toISOString();
    const outFile = cachePathForPeriod(period);
    jobState.abort = false;

    const runningMeta = {
      period,
      startedAt,
      outFile,
      channelIds: groups.map((g) => g.channelId),
    };
    fs.writeFileSync(RUNNING_FILE, JSON.stringify(runningMeta, null, 2), "utf8");

    res.json({
      ok: true,
      started: true,
      period,
      channelCount: groups.length,
      hint: "轮询 GET /api/local/kolvip-backfill/status 或 results；本阶段只拉取/建卡，不算盈亏",
    });

    jobState.promise = (async () => {
      /** @type {Record<string, unknown>} */
      let payload = { ok: false, error: "aborted" };
      try {
        payload = await runKolvipManualBackfillScan({
          store: deps.store,
          signalCards: deps.signalCards,
          groups,
          period,
          shouldAbort: () => jobState.abort,
          onProgress: (patch) => {
            try {
              fs.writeFileSync(
                RUNNING_FILE,
                JSON.stringify(
                  { ...runningMeta, progress: patch, updatedAt: new Date().toISOString() },
                  null,
                  2,
                ),
                "utf8",
              );
            } catch {
              /* ignore */
            }
            if (jobState.abort) throw new Error("用户停止");
          },
        });
        const runId = String(payload.generatedAt ?? "").replace(/[:.]/g, "-") || `run-${Date.now()}`;
        const histDir = path.join(HISTORY_DIR, period);
        fs.mkdirSync(histDir, { recursive: true });
        fs.writeFileSync(outFile, JSON.stringify(payload, null, 2), "utf8");
        fs.writeFileSync(historyFilePath(period, runId), JSON.stringify(payload, null, 2), "utf8");
        fs.writeFileSync(
          LAST_RUN_FILE,
          JSON.stringify(
            {
              ok: true,
              exitCode: 0,
              period,
              startedAt,
              finishedAt: new Date().toISOString(),
              outFile,
              outFileExists: true,
            },
            null,
            2,
          ),
          "utf8",
        );
        log.info(`巨鲸手动回溯完成 period=${period} channels=${groups.length}`);
      } catch (e) {
        const msg = String(/** @type {Error} */ (e).message ?? e);
        fs.writeFileSync(
          LAST_RUN_FILE,
          JSON.stringify(
            {
              ok: false,
              exitCode: 1,
              period,
              startedAt,
              finishedAt: new Date().toISOString(),
              failHint: jobState.abort ? "用户已停止" : msg,
              stderrTail: msg,
            },
            null,
            2,
          ),
          "utf8",
        );
        log.warn(`巨鲸手动回溯失败: ${msg}`);
      } finally {
        jobState.promise = null;
        jobState.abort = false;
        try {
          if (fs.existsSync(RUNNING_FILE)) fs.unlinkSync(RUNNING_FILE);
        } catch {
          /* ignore */
        }
      }
    })();
  });
}
