/**
 * 卡片列表验证 API：真实 K 线回测，经 WebSocket 推送进度与结果。
 */
import { randomUUID } from "node:crypto";
import {
  parseArchiveRangeMs,
  parseArchiveSourceTypesList,
  requireOpenApiKey,
  resolveArchiveBodySourceTypes,
  resolveArchiveListSourceTypes,
} from "./card-archive-api.js";
import { buildMockValidateSample } from "./card-validate-mock.js";
import { BACKTEST_WINDOW_DAYS, parseBacktestSignals } from "./card-validate-signals.js";
import { backtestSignalReal } from "./card-validate-engine.js";
import { runBatchLiquidation } from "./card-liquidation-engine.js";
import { createLogger } from "./logger.js";
import { requireLocalRequest } from "./local-request.js";

const log = createLogger("card-validate");

const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_JOBS = 20;
const REAL_CARD_DELAY_MS = 400;

/** @type {Map<string, Record<string, unknown>>} */
const jobs = new Map();

function pruneJobs() {
  const now = Date.now();
  for (const [id, job] of jobs) {
    const finishedAt = Number(job.finishedAt) || 0;
    const startedAt = Number(job.startedAt) || 0;
    const staleAt = finishedAt || startedAt;
    if (staleAt && now - staleAt > JOB_TTL_MS) jobs.delete(id);
  }
  while (jobs.size > MAX_JOBS) {
    const first = jobs.keys().next().value;
    if (!first) break;
    jobs.delete(first);
  }
}

/**
 * @param {import("express").Request | { query?: Record<string, unknown>, body?: Record<string, unknown> }} req
 */
function resolveValidateFilters(req) {
  const body = req.body && typeof req.body === "object" ? req.body : {};
  const query = req.query && typeof req.query === "object" ? req.query : {};
  const merged = { ...query, ...body };
  const rangeReq = { query: merged };
  const { fromMs, toMs } = parseArchiveRangeMs(rangeReq);
  const sourceTypes = parseArchiveSourceTypesList(merged.sources).length
    ? parseArchiveSourceTypesList(merged.sources)
    : resolveArchiveBodySourceTypes(merged).length
      ? resolveArchiveBodySourceTypes(merged)
      : resolveArchiveListSourceTypes({ query: merged });
  const channelId = String(merged.channelId ?? merged.channel_id ?? "").trim();
  const symbol = String(merged.symbol ?? merged.coin ?? "").trim();
  const status = String(merged.status ?? "").trim();
  const limit = Math.min(500, Math.max(1, Number(merged.limit) || 200));
  const cardIds = Array.isArray(merged.cardIds)
    ? merged.cardIds.map((id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0)
    : [];
  const signals = parseBacktestSignals(merged);
  const persistRaw = String(merged.persist ?? "").toLowerCase();
  const persist =
    merged.persist === true ||
    merged.persist === 1 ||
    ["1", "true", "yes", "on"].includes(persistRaw);
  const windowDays = Number(merged.windowDays ?? merged.window_days) || BACKTEST_WINDOW_DAYS;
  return {
    fromMs,
    toMs,
    sourceTypes,
    channelId,
    symbol,
    status,
    limit,
    cardIds,
    mock: false,
    signals,
    persist,
    windowDays,
  };
}

/**
 * @param {(channel: string, payload: Record<string, unknown>) => void} [broadcast]
 */
function emit(broadcast, payload) {
  if (!broadcast) return;
  const kind = String(payload.kind ?? "");
  if (kind === "card_validate_started") {
    log.info(
      `回测验证开始 jobId=${payload.jobId} 条数=${payload.total ?? 0} mock=${Boolean(payload.mock)}`
    );
  } else if (kind === "card_validate_done") {
    const n = Array.isArray(payload.items)
      ? payload.items.length
      : Number(payload.processed ?? payload.total) || 0;
    const errN = Array.isArray(payload.errors) ? payload.errors.length : 0;
    log.info(`回测验证完成 jobId=${payload.jobId} 条数=${n} 错误=${errN}`);
  }
  broadcast("meta", payload);
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./card-archive-list-cache.js").createCardArchiveListCache>} listCache
 * @param {(channel: string, payload: Record<string, unknown>) => void} [broadcast]
 */
export function createCardValidateRunner(store, listCache, broadcast) {
  /**
   * 客户端传入 signals：真实 K 线窗口回测。
   * @param {string} jobId
   * @param {Record<string, unknown>} filters
   */
  async function runSignalsJob(jobId, filters) {
    const job = jobs.get(jobId);
    if (!job || job.status !== "running") return;

    const signals = Array.isArray(filters.signals) ? filters.signals : [];
    job.total = signals.length;
    job.mock = false;
    emit(broadcast, {
      kind: "card_validate_started",
      jobId,
      total: signals.length,
      mock: false,
      persist: Boolean(filters.persist),
      filters: job.filters,
    });

    /** @type {Record<string, unknown>[]} */
    const items = [];
    /** @type {Array<{ cardId?: number, signalId?: string, error: string }>} */
    const errors = [];

    for (let i = 0; i < signals.length; i++) {
      const sig = /** @type {import("./card-validate-signals.js").BacktestSignalInput} */ (signals[i]);
      const symbol = String(sig.symbol ?? "").trim() || "—";
      job.processed = i;
      job.current = { index: i + 1, total: signals.length, signalId: sig.id, symbol };
      emit(broadcast, {
        kind: "card_validate_progress",
        jobId,
        index: i + 1,
        total: signals.length,
        signalId: sig.id,
        symbol,
        mock: false,
      });

      try {
        const item = await backtestSignalReal(sig, {
          windowDays: Number(filters.windowDays) || BACKTEST_WINDOW_DAYS,
        });
        if (item.error) {
          errors.push({ signalId: String(sig.id), error: String(item.error) });
        } else {
          items.push(item);
        }
        job.items = items;
        job.errors = errors;
        emit(broadcast, {
          kind: "card_validate_item",
          jobId,
          index: i + 1,
          total: signals.length,
          mock: false,
          item,
        });
      } catch (e) {
        const msg = String(/** @type {Error} */ (e).message ?? e);
        const errItem = { signalId: sig.id, symbol, error: msg, mock: false };
        errors.push({ signalId: String(sig.id), error: msg });
        emit(broadcast, {
          kind: "card_validate_item",
          jobId,
          index: i + 1,
          total: signals.length,
          mock: false,
          item: errItem,
        });
      }

      if (i + 1 < signals.length) {
        await new Promise((r) => setTimeout(r, REAL_CARD_DELAY_MS));
      }
    }

    job.status = "done";
    job.processed = signals.length;
    job.finishedAt = Date.now();
    job.items = items;
    job.errors = errors;
    job.current = null;
    emit(broadcast, {
      kind: "card_validate_done",
      jobId,
      total: signals.length,
      processed: signals.length,
      mock: false,
      items,
      errors,
      filters: job.filters,
    });
  }

  /**
   * 库内卡片：真实清算并写回 MySQL。
   * @param {string} jobId
   * @param {Record<string, unknown>} filters
   */
  async function runDbCardsJob(jobId, filters) {
    const job = jobs.get(jobId);
    if (!job || job.status !== "running") return;

    job.mock = false;
    const liquidationLog = createLogger("card-liquidate");
    /** @param {number} id */
    async function onCardUpdated(id) {
      const row = await store.getSignalCardById(id);
      if (row) listCache?.onRowChanged?.(row);
    }

    emit(broadcast, {
      kind: "card_validate_started",
      jobId,
      total: 0,
      mock: false,
      persist: true,
      mode: "liquidation",
      filters: job.filters,
    });

    const result = await runBatchLiquidation(
      store,
      liquidationLog,
      {
        fromMs: Number(filters.fromMs),
        toMs: Number(filters.toMs),
        channelId: String(filters.channelId ?? ""),
        sourceTypes: Array.isArray(filters.sourceTypes) ? filters.sourceTypes : [],
        symbol: String(filters.symbol ?? ""),
        limit: Number(filters.limit) || 200,
        cardIds: Array.isArray(filters.cardIds) ? filters.cardIds : [],
      },
      { onCardUpdated }
    );

    const rawItems = Array.isArray(result.items) ? result.items : [];
    /** @type {Record<string, unknown>[]} */
    const items = rawItems.map((it) => ({ ...it, mock: false, mode: "liquidation" }));
    /** @type {Array<{ cardId?: number, error: string }>} */
    const errors = items
      .filter((it) => it.error)
      .map((it) => ({ cardId: Number(it.id) || undefined, error: String(it.error) }));

    job.total = items.length;
    job.processed = items.length;
    job.status = "done";
    job.finishedAt = Date.now();
    job.items = items;
    job.errors = errors;
    job.current = null;

    for (let i = 0; i < items.length; i++) {
      emit(broadcast, {
        kind: "card_validate_item",
        jobId,
        index: i + 1,
        total: items.length,
        mock: false,
        item: items[i],
      });
    }

    emit(broadcast, {
      kind: "card_validate_done",
      jobId,
      total: items.length,
      processed: Number(result.processed) || items.length,
      skipped: result.skipped,
      failed: result.failed,
      mock: false,
      persist: true,
      items,
      errors,
      filters: job.filters,
    });
  }

  /**
   * @param {string} jobId
   * @param {Record<string, unknown>} filters
   */
  async function runJob(jobId, filters) {
    const job = jobs.get(jobId);
    if (!job) return;
    try {
      const signals = Array.isArray(filters.signals) ? filters.signals : [];
      const cardIds = Array.isArray(filters.cardIds) ? filters.cardIds : [];
      const hasDbFilter =
        cardIds.length > 0 ||
        String(filters.channelId ?? "").trim() ||
        (Array.isArray(filters.sourceTypes) && filters.sourceTypes.length > 0);

      if (signals.length) {
        await runSignalsJob(jobId, filters);
        return;
      }
      if (hasDbFilter) {
        await runDbCardsJob(jobId, filters);
        return;
      }

      job.status = "done";
      job.error = "请传入 signals[]，或 cardIds / channelId / sources 指定库内卡片";
      job.finishedAt = Date.now();
      emit(broadcast, {
        kind: "card_validate_error",
        jobId,
        error: job.error,
      });
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message ?? e);
      job.status = "done";
      job.error = msg;
      job.finishedAt = Date.now();
      emit(broadcast, { kind: "card_validate_error", jobId, error: msg });
    }
  }

  /**
   * @param {Record<string, unknown>} filters
   */
  function startJob(filters) {
    pruneJobs();
    const jobId = randomUUID();
    const job = {
      id: jobId,
      status: "running",
      startedAt: Date.now(),
      finishedAt: null,
      total: 0,
      processed: 0,
      filters,
      current: null,
      items: [],
      errors: [],
      error: null,
      mock: false,
    };
    jobs.set(jobId, job);
    void runJob(jobId, filters);
    return job;
  }

  return { startJob };
}

/**
 * @param {import("express").Express} app
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./card-archive-list-cache.js").createCardArchiveListCache>} listCache
 * @param {(channel: string, payload: Record<string, unknown>) => void} [broadcast]
 * @param {{ requireOpenApiKey?: import("express").RequestHandler }} [deps]
 */
export function registerCardValidateRoutes(app, store, listCache, broadcast, deps = {}) {
  const openAuth = deps.requireOpenApiKey ?? requireOpenApiKey;
  const runner = createCardValidateRunner(store, listCache, broadcast);

  async function startHandler(req, res) {
    try {
      const filters = resolveValidateFilters(req);
      const hasSignals = filters.signals.length > 0;
      const hasDbFilter =
        filters.cardIds.length > 0 ||
        Boolean(filters.channelId) ||
        filters.sourceTypes.length > 0;
      if (!hasSignals && !hasDbFilter) {
        res.status(400).json({
          ok: false,
          error: "请传入 signals[]，或 cardIds / channelId / sources 指定库内卡片做真实回测",
          hint: "signals: [{ symbol, direction, signalAt, entry? }]；库内卡片会走清算并写回 MySQL",
        });
        return;
      }
      const job = runner.startJob(filters);
      res.status(202).json({
        ok: true,
        jobId: job.id,
        status: job.status,
        mode: "backtest",
        mock: false,
        readOnly: hasSignals && !filters.persist,
        persist: hasDbFilter || Boolean(filters.persist),
        windowDays: filters.windowDays || BACKTEST_WINDOW_DAYS,
        note: hasSignals
          ? "真实 Binance K 线回测（信号列表）；结果经 WS 推送"
          : "库内卡片真实清算并写回 MySQL",
        signalCount: filters.signals.length,
        filters,
        ws: {
          path: "/ws",
          channel: "meta",
          events: [
            "card_validate_started",
            "card_validate_progress",
            "card_validate_item",
            "card_validate_done",
            "card_validate_error",
          ],
        },
        poll: `/api/v1/cards/validate/${job.id}`,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  }

  function statusHandler(req, res) {
    const jobId = String(req.params.jobId ?? "").trim();
    const job = jobs.get(jobId);
    if (!job) {
      res.status(404).json({ ok: false, error: "job not found" });
      return;
    }
    res.json({
      ok: true,
      jobId: job.id,
      status: job.status,
      mock: false,
      startedAt: job.startedAt,
      finishedAt: job.finishedAt,
      total: job.total,
      processed: job.processed,
      current: job.current,
      filters: job.filters,
      items: job.items,
      errors: job.errors,
      error: job.error,
    });
  }

  function sampleHandler(_req, res) {
    res.json({
      ...buildMockValidateSample(),
      note: "此端点仅静态样例预览；正式回测请 POST /api/v1/cards/validate（真实 K 线）",
    });
  }

  app.get("/api/cards/validate/mock/sample", requireLocalRequest, sampleHandler);
  app.get("/api/v1/cards/validate/mock/sample", openAuth, sampleHandler);
  app.post("/api/cards/validate", requireLocalRequest, startHandler);
  app.get("/api/cards/validate/:jobId", requireLocalRequest, statusHandler);
  app.post("/api/v1/cards/validate", openAuth, startHandler);
  app.get("/api/v1/cards/validate/:jobId", openAuth, statusHandler);
}
