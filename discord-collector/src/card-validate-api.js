/**
 * 卡片列表验证 API：长时间扫描经 WebSocket 推送进度与结果。
 */
import { randomUUID } from "node:crypto";
import {
  parseArchiveRangeMs,
  parseArchiveSourceTypesList,
  requireOpenApiKey,
  resolveArchiveBodySourceTypes,
  resolveArchiveListSourceTypes,
} from "./card-archive-api.js";
import {
  buildMockValidateCards,
  buildMockValidateCardsFromSignals,
  buildMockValidateItem,
  buildMockValidateSample,
} from "./card-validate-mock.js";
import { BACKTEST_WINDOW_DAYS, parseBacktestSignals } from "./card-validate-signals.js";
import { createLogger } from "./logger.js";
import { requireLocalRequest } from "./local-request.js";

const log = createLogger("card-validate");

const JOB_TTL_MS = 60 * 60 * 1000;
const MAX_JOBS = 20;
const MOCK_CARD_DELAY_MS = 350;

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
  const mockCount = Math.min(20, Math.max(1, Number(merged.mockCount ?? merged.count) || 8));
  const signals = parseBacktestSignals(merged);
  return {
    fromMs,
    toMs,
    sourceTypes,
    channelId,
    symbol,
    status,
    limit,
    cardIds,
    mock: true,
    mockCount,
    signals,
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
      `回测验证开始 jobId=${payload.jobId} 卡片数=${payload.total ?? 0}${payload.mock ? " (mock)" : ""}`
    );
  } else if (kind === "card_validate_done") {
    const n = Array.isArray(payload.items)
      ? payload.items.length
      : Number(payload.processed ?? payload.total) || 0;
    const errN = Array.isArray(payload.errors) ? payload.errors.length : 0;
    log.info(`回测验证完成 jobId=${payload.jobId} 卡片数=${n} 错误=${errN}`);
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
   * @param {string} jobId
   * @param {Record<string, unknown>} filters
   */
  async function runMockJob(jobId, filters) {
    const job = jobs.get(jobId);
    if (!job || job.status !== "running") return;

    const mockCount = Number(filters.mockCount) || 8;
    const cards = filters.signals?.length
      ? buildMockValidateCardsFromSignals(filters.signals)
      : buildMockValidateCards(mockCount);
    job.total = cards.length;
    job.mock = true;
    job.cards = cards.map((c) => ({
      id: c.id,
      symbol: c.symbol,
      channelId: c.channelId,
      channelName: c.channelName,
    }));
    emit(broadcast, {
      kind: "card_validate_started",
      jobId,
      total: cards.length,
      mock: true,
      filters: job.filters,
    });

    /** @type {Record<string, unknown>[]} */
    const items = [];
    /** @type {Array<{ cardId: number, error: string }>} */
    const errors = [];

    for (let i = 0; i < cards.length; i++) {
      const card = cards[i];
      const symbol = String(card.symbol ?? "").trim() || "—";
      job.processed = i;
      job.current = { index: i + 1, total: cards.length, cardId: card.id, symbol };
      emit(broadcast, {
        kind: "card_validate_progress",
        jobId,
        index: i + 1,
        total: cards.length,
        cardId: card.id,
        symbol,
        channelId: card.channelId,
        channelName: card.channelName,
        mock: true,
      });

      const item = buildMockValidateItem(card, i);
      if (item.error) errors.push({ cardId: Number(card.id), error: String(item.error) });
      else items.push(item);
      job.items = items;
      job.errors = errors;
      emit(broadcast, {
        kind: "card_validate_item",
        jobId,
        index: i + 1,
        total: cards.length,
        mock: true,
        item,
      });

      if (i + 1 < cards.length) {
        await new Promise((r) => setTimeout(r, MOCK_CARD_DELAY_MS));
      }
    }

    job.status = "done";
    job.processed = cards.length;
    job.finishedAt = Date.now();
    job.items = items;
    job.errors = errors;
    job.current = null;
    emit(broadcast, {
      kind: "card_validate_done",
      jobId,
      total: cards.length,
      processed: cards.length,
      mock: true,
      items,
      errors,
      filters: job.filters,
    });
  }

  /**
   * @param {Record<string, unknown>} filters
   */
  async function runJob(jobId, filters) {
    // 当前阶段：一律 mock 回测，不读 MySQL / 不拉 K 线（见 docs/cards-api.md）
    await runMockJob(jobId, filters);
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
      const job = runner.startJob(filters);
      res.status(202).json({
        ok: true,
        jobId: job.id,
        status: job.status,
        mode: "backtest",
        mock: true,
        readOnly: true,
        windowDays: BACKTEST_WINDOW_DAYS,
        note: "当前返回模拟回测结果；真实 K 线回测尚未启用",
        signalCount: filters.signals.length || filters.mockCount,
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
    res.json(buildMockValidateSample());
  }

  app.get("/api/cards/validate/mock/sample", requireLocalRequest, sampleHandler);
  app.get("/api/v1/cards/validate/mock/sample", openAuth, sampleHandler);
  app.post("/api/cards/validate", requireLocalRequest, startHandler);
  app.get("/api/cards/validate/:jobId", requireLocalRequest, statusHandler);
  app.post("/api/v1/cards/validate", openAuth, startHandler);
  app.get("/api/v1/cards/validate/:jobId", openAuth, statusHandler);
}
