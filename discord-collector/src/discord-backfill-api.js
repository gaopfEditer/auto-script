/**
 * Local：Discord 频道回溯（discord_backfill_groups.json + CDP 上滚 + 信号回测）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  DISCORD_BACKFILL_PERIODS,
  normalizeDiscordBackfillPeriod,
  runDiscordBackfillScan,
} from "./discord-backfill-engine.js";
import { enrichDiscordBackfillFile } from "./discord-backfill-enrich.js";
import { ensureDiscordBackfillGroupsCards } from "./discord-backfill-hydrate.js";
import { getSignalChannelConfig } from "./discord-signal-config.js";
import { DISCORD_GROUPS_FILE, loadDiscordGroupsFromFile } from "./discord-groups-file.js";
import { requireLocalRequest } from "./local-request.js";
import { createLogger } from "./logger.js";

const log = createLogger("discord-backfill");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.join(__dirname, "..", "data");
/** @deprecated 见 discord_groups.json → backfillChannels */
const LEGACY_BACKFILL_CONFIG = path.join(DATA_DIR, "discord_backfill_groups.json");
const CACHE_DIR = path.join(DATA_DIR, ".discord_backfill_cache");
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
 * @param {Array<{ channelId: string, name?: string, guildId?: string, enabled?: boolean, note?: string }>} entries
 */
function mergeBackfillConfig(entries) {
  /** @type {Array<Record<string, unknown>>} */
  const groups = [];
  for (const g of entries) {
    if (!g || typeof g !== "object") continue;
    const channelId = String(g.channelId ?? "").trim();
    if (!channelId) continue;
    if (g.enabled === false) continue;
    const sig = getSignalChannelConfig(channelId);
    groups.push({
      channelId,
      guildId: String(g.guildId ?? "").trim(),
      name: String(g.name ?? sig?.name ?? channelId),
      note: String(g.note ?? ""),
      parser: sig?.parser ?? "generic",
    });
  }
  return groups;
}

function loadBackfillChannelEntries() {
  const loaded = loadDiscordGroupsFromFile();
  return { entries: loaded.backfillChannels, configFile: loaded.filePath };
}

/**
 * @param {string} period
 */
function cachePathForPeriod(period) {
  return path.join(CACHE_DIR, `${normalizeDiscordBackfillPeriod(period)}.latest.json`);
}

/**
 * @param {string} period
 * @param {string} runId
 */
function historyFilePath(period, runId) {
  const safe = String(runId).replace(/[^\w.-]/g, "_");
  return path.join(HISTORY_DIR, normalizeDiscordBackfillPeriod(period), `${safe}.json`);
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
 *   getScrollImpl: () => ((guildId: string, channelId: string, trace?: object) => Promise<{ ok?: boolean; error?: string }>) | null;
 *   getNavigateImpl?: () => ((guildId: string, channelId: string) => Promise<{ ok?: boolean; error?: string }>) | null;
 * }} deps
 */
export function registerDiscordBackfillRoutes(app, deps) {
  fs.mkdirSync(CACHE_DIR, { recursive: true });
  fs.mkdirSync(HISTORY_DIR, { recursive: true });

  app.get("/api/local/discord-backfill/config", requireLocalRequest, (_req, res) => {
    const { entries, configFile } = loadBackfillChannelEntries();
    if (!entries.length && !fs.existsSync(configFile) && !fs.existsSync(LEGACY_BACKFILL_CONFIG)) {
      return res.status(404).json({
        ok: false,
        error: `未找到 ${DISCORD_GROUPS_FILE}，可从 discord_groups.example.json 复制`,
      });
    }
    const groups = mergeBackfillConfig(entries);
    res.json({
      ok: true,
      groups,
      configFile,
      groupsFile: configFile,
      periods: DISCORD_BACKFILL_PERIODS,
    });
  });

  app.get("/api/local/discord-backfill/history", requireLocalRequest, (req, res) => {
    const period = normalizeDiscordBackfillPeriod(req.query.period);
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

  app.get("/api/local/discord-backfill/results", requireLocalRequest, async (req, res) => {
    const period = normalizeDiscordBackfillPeriod(req.query.period);
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
    let groups = Array.isArray(data.groups) ? data.groups : [];
    try {
      groups = await ensureDiscordBackfillGroupsCards(deps.store, groups, {
        fromMs: Number(data.fromMs) || 0,
        toMs: Number(data.toMs) || 0,
      });
      const changed = JSON.stringify(groups) !== JSON.stringify(data.groups);
      if (changed && !runId && file) {
        const nextPayload = { ...data, groups, cardsHydratedAt: new Date().toISOString() };
        fs.writeFileSync(file, JSON.stringify(nextPayload, null, 2), "utf8");
      }
    } catch (e) {
      log.warn(`Discord 回溯卡片时间补全失败: ${String(/** @type {Error} */ (e).message ?? e)}`);
    }
    res.json({
      ok: true,
      cached: true,
      file,
      runId: runId || null,
      ...data,
      groups,
    });
  });

  app.get("/api/local/discord-backfill/status", requireLocalRequest, (_req, res) => {
    const state = readRunningState();
    const scrollReady = typeof deps.getScrollImpl() === "function";
    res.json({
      ok: true,
      periods: DISCORD_BACKFILL_PERIODS,
      cdpScrollReady: scrollReady,
      ...state,
      rebacktest: rebacktestJob,
      cacheDir: CACHE_DIR,
      configFile: DISCORD_GROUPS_FILE,
      groupsFile: loadDiscordGroupsFromFile().filePath,
    });
  });

  app.post("/api/local/discord-backfill/rebacktest", requireLocalRequest, (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const period = normalizeDiscordBackfillPeriod(body.period ?? req.query.period);
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
      Math.max(1, Number(process.env.DISCORD_BACKFILL_MAX_BACKTEST_SIGNALS) || 120),
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
      message: "Discord 批量盈亏已在后台执行，可刷新或轮询状态",
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
        log.warn(`Discord batch 盈亏失败: ${msg}`);
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

  app.post("/api/local/discord-backfill/stop", requireLocalRequest, (_req, res) => {
    if (!jobState.promise) {
      return res.json({ ok: true, stopped: false, message: "当前没有进行中的回溯" });
    }
    jobState.abort = true;
    res.json({ ok: true, stopped: true, message: "已请求停止（当前频道处理完后结束）" });
  });

  app.post("/api/local/discord-backfill/run", requireLocalRequest, async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const period = normalizeDiscordBackfillPeriod(body.period ?? req.query.period);
    if (readRunningState().running) {
      return res.status(409).json({ ok: false, error: "回溯任务进行中，请先停止或等待完成" });
    }
    const scrollFn = deps.getScrollImpl();
    if (typeof scrollFn !== "function") {
      return res.status(503).json({
        ok: false,
        error: "CDP 未就绪：请配置 CDP_CONNECT_URL 并保持 Chrome Discord 已登录",
      });
    }
    const { entries, configFile } = loadBackfillChannelEntries();
    if (!entries.length) {
      return res.status(500).json({
        ok: false,
        error: `请在 ${configFile} 的 backfillChannels 中配置回测频道`,
      });
    }
    let groups = mergeBackfillConfig(entries);
    const channelIds = Array.isArray(body.channelIds)
      ? body.channelIds.map((x) => String(x).trim()).filter(Boolean)
      : [];
    if (channelIds.length) {
      groups = groups.filter((g) => channelIds.includes(String(g.channelId)));
    }
    if (!groups.length) {
      return res.status(400).json({ ok: false, error: "没有可回溯的频道（检查配置与勾选）" });
    }

    const navigateFn = deps.getNavigateImpl?.() ?? undefined;
    const maxScrollPages = Math.min(
      80,
      Math.max(1, Number(process.env.DISCORD_BACKFILL_MAX_SCROLL_PAGES) || 32),
    );
    const inlineBacktest = Boolean(body.inlineBacktest);
    const maxBacktestsPerChannel = inlineBacktest
      ? Math.min(120, Math.max(0, Number(process.env.DISCORD_BACKFILL_MAX_BACKTEST_SIGNALS) || 40))
      : 0;
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
      hint: "轮询 GET /api/local/discord-backfill/status 或 results",
    });

    jobState.promise = (async () => {
      /** @type {Record<string, unknown>} */
      let payload = { ok: false, error: "aborted" };
      try {
        payload = await runDiscordBackfillScan({
          store: deps.store,
          scrollFn,
          navigateFn: typeof navigateFn === "function" ? navigateFn : undefined,
          groups,
          period,
          maxScrollPages,
          maxBacktestsPerChannel,
          onProgress: (patch) => {
            try {
              fs.writeFileSync(
                RUNNING_FILE,
                JSON.stringify({ ...runningMeta, progress: patch, updatedAt: new Date().toISOString() }, null, 2),
                "utf8",
              );
            } catch {
              /* ignore */
            }
            if (jobState.abort) throw new Error("用户停止");
          },
        });
        const runId = payload.generatedAt?.replace(/[:.]/g, "-") ?? `run-${Date.now()}`;
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
        log.info(`Discord 回溯完成 period=${period} channels=${groups.length}`);
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
        log.warn(`Discord 回溯失败: ${msg}`);
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
