/**
 * 统一卡片归档 API（内部 /api/cards + 对外开放 /api/v1/cards）。
 */
import {
  archiveCardToClient,
  createCardArchiveService,
  resolveCardChannelName,
  normalizeCardSourceType,
} from "./card-archive-service.js";
import { normalizeExecution } from "./discord-signal-execution.js";
import { detectAssetClass } from "./card-verify-policy.js";
import { isShortDirection } from "./card-direction.js";
import { config } from "./config.js";
import { createLogger } from "./logger.js";
import { runBatchLiquidation, runBatchClearLiquidation } from "./card-liquidation-engine.js";
import { signalCardToClient } from "./discord-signal-card-service.js";
import { createCardArchiveListCache } from "./card-archive-list-cache.js";
import { requireLocalRequest } from "./local-request.js";

/**
 * 卡片正文：优先 body / content / 原文 / 正文，兼容 rawContent / description。
 * @param {Record<string, unknown>} body
 */
export function pickCardBodyText(body) {
  if (!body || typeof body !== "object") return "";
  const v =
    body.body ??
    body.content ??
    body["原文"] ??
    body["正文"] ??
    body.rawContent ??
    body.description ??
    "";
  return String(v ?? "").trim();
}

/** 开放 API 误把回测请求打到建卡端点时的识别（只读历史 + WS 返回，不 INSERT）。 */
export function looksLikeCardValidateRequest(body) {
  const b = body && typeof body === "object" ? body : {};
  const mockRaw = String(b.mock ?? "").toLowerCase();
  if (["1", "true", "yes", "on"].includes(mockRaw) || b.mock === true) return true;
  if (Array.isArray(b.signals) && b.signals.length > 0) return true;
  if (Array.isArray(b.items) && b.items.length > 0 && (b.items[0]?.symbol || b.items[0]?.coin)) return true;
  if (Array.isArray(b.coins) && b.coins.length > 0) return true;

  const hasCreatePayload =
    b.messageId != null ||
    pickCardBodyText(b).length > 0 ||
    (b.symbol && (b.entry != null || b.targets != null || b.takeProfits != null || b.stopLoss != null));

  if (hasCreatePayload) return false;

  return (
    b.days != null ||
    b.from != null ||
    b.to != null ||
    b.sources != null ||
    b.mockCount != null ||
    (b.limit != null && (b.channelId != null || b.symbol != null || b.sources != null))
  );
}

export const CARD_VALIDATE_MISROUTE_HINT = {
  error:
    "此请求属于历史卡片回测（只读），不会创建新卡片。请改用 POST /api/v1/cards/validate",
  hint: "POST /api/v1/cards/validate，Body 传 signals: [{ symbol, direction, signalAt, entry? }]，再连 ws://127.0.0.1:3851/ws 收 card_validate_* 事件",
  correctEndpoint: "/api/v1/cards/validate",
  ws: { path: "/ws", channel: "meta", events: ["card_validate_started", "card_validate_item", "card_validate_done"] },
};

/**
 * 规范化图片列表。
 * @param {unknown} raw
 * @returns {string[]}
 */
function normalizeImageList(raw) {
  if (Array.isArray(raw)) {
    return raw.map((x) => String(x ?? "").trim()).filter(Boolean).slice(0, 20);
  }
  const s = String(raw ?? "").trim();
  return s ? [s] : [];
}

/**
 * 开放建卡：把调用方主字段收成 archiveCard 入参。
 * @param {Record<string, unknown>} body
 */
export function normalizeOpenCardInput(body) {
  const b = body && typeof body === "object" ? body : {};
  const channelId = String(b.channelId ?? b.channel_id ?? "api").trim() || "api";
  const channelName = String(b.channelName ?? b.channel_name ?? "").trim();
  const channelAvatar = String(
    b.channelAvatar ?? b.channel_avatar ?? b.avatar ?? ""
  ).trim();
  const images = normalizeImageList(b.images ?? b.image ?? b.pics);
  const rawContent = pickCardBodyText(b);
  const note = String(b.note ?? b["备注"] ?? "").trim();
  const signalAt = b.signalAt ?? b.time ?? b.createdAt ?? b["时间"] ?? null;
  const authorKey = String(b.authorKey ?? b.author_key ?? b.sender ?? b.authorId ?? b.author_id ?? "").trim();
  const sender = String(b.sender ?? "").trim();
  const prevParsed =
    b.parsedJson && typeof b.parsedJson === "object" && !Array.isArray(b.parsedJson)
      ? /** @type {Record<string, unknown>} */ (b.parsedJson)
      : {};

  return {
    messageId: b.messageId,
    channelId,
    guildId: b.guildId,
    sourceType: normalizeCardSourceType(b.source ?? b.sourceType ?? "api"),
    sourceRef: b.sourceRef ?? b.externalId,
    rawContent,
    channelName: channelName || undefined,
    channelAvatar: channelAvatar || undefined,
    images,
    parsedJson: {
      ...prevParsed,
      ...(channelName ? { channelName } : {}),
      ...(channelAvatar ? { channelAvatar } : {}),
      ...(images.length ? { images } : {}),
      ...(authorKey ? { authorKey } : {}),
      ...(sender ? { sender } : {}),
    },
    cardsByStyle: b.cardsByStyle,
    cardFields: b.cardFields ?? b.embed,
    symbol: b.symbol,
    note: note || undefined,
    signalAt: signalAt != null ? String(signalAt) : undefined,
    verifyMode: b.verifyMode,
    assetClass: b.assetClass,
    injectChannelMessage:
      b.injectChannelMessage ?? b.inject_message ?? b.postToChannel,
    direction: b.direction,
    entry: b.entry,
    targets: b.targets ?? b.takeProfits,
    stopLoss: b.stopLoss,
    mergeWindowMs: Number(b.mergeWindowMs ?? b.merge_window_ms) || undefined,
  };
}

/** @param {import("express").Request} req */
/** @param {import("express").Request | { query?: Record<string, unknown> }} req */
export function parseArchiveRangeMs(req) {
  const toRaw = req.query.to ?? req.query.to_ms;
  const fromRaw = req.query.from ?? req.query.from_ms;
  const days = Number(req.query.days);
  let toMs = toRaw ? new Date(String(toRaw)).getTime() : Date.now();
  if (!Number.isFinite(toMs)) toMs = Date.now();
  let fromMs = fromRaw ? new Date(String(fromRaw)).getTime() : NaN;
  if (!Number.isFinite(fromMs) && Number.isFinite(days) && days > 0) {
    fromMs = toMs - days * 86400000;
  }
  if (!Number.isFinite(fromMs)) fromMs = toMs - 30 * 86400000;
  return { fromMs, toMs };
}

/**
 * @param {Record<string, unknown>} body
 */
function parseLiquidateRangeMs(body) {
  const toRaw = body.to ?? body.toMs;
  const fromRaw = body.from ?? body.fromMs;
  const days = Number(body.days);
  let toMs = toRaw ? new Date(String(toRaw)).getTime() : Date.now();
  if (!Number.isFinite(toMs)) toMs = Date.now();
  let fromMs = fromRaw ? new Date(String(fromRaw)).getTime() : NaN;
  if (!Number.isFinite(fromMs) && Number.isFinite(days) && days > 0) {
    fromMs = toMs - days * 86400000;
  }
  if (!Number.isFinite(fromMs)) {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    fromMs = start.getTime();
  }
  return { fromMs, toMs };
}

/**
 * @param {unknown} raw
 * @returns {string[]}
 */
export function parseArchiveSourceTypesList(raw) {
  /** @type {string[]} */
  const out = [];
  const add = (v) => {
    const s = String(v ?? "").trim().toLowerCase();
    if (s) out.push(s);
  };
  if (Array.isArray(raw)) {
    for (const x of raw) add(x);
  } else {
    const s = String(raw ?? "").trim();
    if (s) {
      for (const part of s.split(/[,;\s]+/)) add(part);
    }
  }
  return [...new Set(out)];
}

/**
 * @param {import("express").Request} req
 */
export function resolveArchiveListSourceTypes(req) {
  const fromSources = parseArchiveSourceTypesList(req.query.sources);
  if (fromSources.length) return fromSources;
  const single = String(
    req.query.source ?? req.query.source_type ?? req.query.sourceType ?? ""
  ).trim().toLowerCase();
  return single ? [single] : [];
}

/**
 * @param {Record<string, unknown>} body
 */
export function resolveArchiveBodySourceTypes(body) {
  const fromSources = parseArchiveSourceTypesList(body.sources);
  if (fromSources.length) return fromSources;
  const single = String(body.source ?? body.sourceType ?? body.source_type ?? "").trim().toLowerCase();
  return single ? [single] : [];
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
export function requireOpenApiKey(req, res, next) {
  const configured = config.cardsApiKey;
  if (!configured) {
    res.status(503).json({ ok: false, error: "CARDS_API_KEY 未配置，开放 API 已禁用" });
    return;
  }
  const header =
    String(req.headers["x-cards-api-key"] ?? "").trim() ||
    String(req.headers.authorization ?? "").replace(/^Bearer\s+/i, "").trim();
  if (header !== configured) {
    res.status(401).json({ ok: false, error: "invalid API key" });
    return;
  }
  next();
}

/**
 * @param {import("express").Express} app
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof createCardArchiveService>} archiveService
 * @param {(channel: string, payload: Record<string, unknown>) => void} [broadcast]
 */
export function registerCardArchiveRoutes(app, store, archiveService, broadcast) {
  const liquidationLog = createLogger("card-liquidate");
  const listCache = createCardArchiveListCache(store, createLogger("card-list-cache"));

  /** @param {number} id */
  async function notifySignalCardUpdated(id) {
    const row = await store.getSignalCardById(id);
    if (row) listCache.onRowChanged(row);
    if (!broadcast) return;
    if (!row) return;
    broadcast("meta", { kind: "signal_card_updated", card: signalCardToClient(row) });
  }

  const liquidationHooks = { onCardUpdated: notifySignalCardUpdated };

  async function listHandler(req, res) {
    try {
      const { fromMs, toMs } = parseArchiveRangeMs(req);
      const sourceTypes = resolveArchiveListSourceTypes(req);
      const symbol = String(req.query.symbol ?? req.query.coin ?? "").trim();
      const status = String(req.query.status ?? "").trim();
      const limit = Number(req.query.limit) || 200;
      const channelId = String(req.query.channel_id ?? req.query.channelId ?? "").trim();
      const sinceId = Number(req.query.sinceId ?? req.query.since_id ?? 0);
      const force = ["1", "true", "yes", "on"].includes(
        String(req.query.refresh ?? req.query.force ?? "").toLowerCase()
      );

      const result = await listCache.list(
        { channelId, status, limit, fromMs, toMs, sourceTypes, symbol },
        { sinceId: Number.isFinite(sinceId) && sinceId > 0 ? sinceId : undefined, force }
      );
      const safe =
        result && typeof result === "object"
          ? result
          : { cards: [], maxId: 0, total: 0, incremental: false, cached: false };

      res.json({
        ok: true,
        fromMs,
        toMs,
        filters: { sourceTypes, symbol, status, channelId },
        total: safe.total ?? safe.cards?.length ?? 0,
        maxId: safe.maxId ?? 0,
        cached: Boolean(safe.cached),
        incremental: Boolean(safe.incremental),
        cards: safe.cards ?? [],
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  }

  async function channelsHandler(req, res) {
    try {
      const { fromMs, toMs } = parseArchiveRangeMs(req);
      const sourceTypes = resolveArchiveListSourceTypes(req);
      const symbol = String(req.query.symbol ?? req.query.coin ?? "").trim();
      const status = String(req.query.status ?? "").trim();
      const force = ["1", "true", "yes", "on"].includes(
        String(req.query.refresh ?? req.query.force ?? "").toLowerCase()
      );
      const result = await listCache.listChannels(
        { status, fromMs, toMs, sourceTypes, symbol },
        { force }
      );
      const safe =
        result && typeof result === "object"
          ? result
          : { channels: [], cached: false };
      const channels = (safe.channels ?? []).map((c) => ({
        channelId: c.channelId,
        channelName: resolveCardChannelName(c.channelId, c.channelName),
        count: c.count,
      }));
      res.json({
        ok: true,
        fromMs,
        toMs,
        filters: { sourceTypes, symbol, status },
        channels,
        cached: Boolean(safe.cached),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  }

  function sourcesHandler(_req, res) {
    res.json({
      ok: true,
      sources: ["discord", "youtube", "telegram", "x", "api", "manual"],
    });
  }

  async function getCardByIdHandler(req, res) {
    try {
      const id = Number(req.params.id);
      const row = await store.getSignalCardById(id);
      if (!row) {
        res.status(404).json({ ok: false, error: "not found" });
        return;
      }
      res.json({ ok: true, card: archiveCardToClient(row) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  }

  async function liquidateHandler(req, res) {
    try {
      const body = req.body ?? {};
      const { fromMs, toMs } = parseLiquidateRangeMs(body);
      const channelId = String(body.channelId ?? body.channel_id ?? "").trim();
      const sourceTypes = resolveArchiveBodySourceTypes(body);
      const symbol = String(body.symbol ?? "").trim();
      const limit = Number(body.limit) || 300;
      const cardIds = Array.isArray(body.cardIds)
        ? body.cardIds.map((/** @type {unknown} */ id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0)
        : undefined;
      const result = await runBatchLiquidation(store, liquidationLog, {
        fromMs,
        toMs,
        channelId: channelId || undefined,
        sourceTypes: sourceTypes.length ? sourceTypes : undefined,
        symbol: symbol || undefined,
        limit,
        cardIds,
      }, liquidationHooks);
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  }

  app.get("/api/cards", listHandler);
  app.get("/api/cards/sources", sourcesHandler);
  app.get("/api/cards/channels", channelsHandler);
  app.get("/api/cards/:id", getCardByIdHandler);

  app.delete("/api/cards/:id", requireLocalRequest, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await archiveService.deleteCard(id);
      listCache.removeFromBuckets(id);
      res.json({ ok: true, ...result });
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message ?? e);
      const status = msg === "not found" ? 404 : msg.includes("不可删除") ? 403 : 400;
      res.status(status).json({ ok: false, error: msg });
    }
  });

  app.post("/api/cards/batch-delete", requireLocalRequest, async (req, res) => {
    try {
      const body = req.body ?? {};
      const cardIds = Array.isArray(body.cardIds)
        ? body.cardIds.map((/** @type {unknown} */ id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0)
        : [];
      if (!cardIds.length) {
        res.status(400).json({ ok: false, error: "cardIds required" });
        return;
      }
      const result = await archiveService.deleteCards(cardIds);
      for (const id of cardIds) listCache.removeFromBuckets(id);
      res.json({ ok: true, ...result });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  /**
   * oi_mornitor / 外部系统回写：自动评价结算（TP1/2/3 或 SL）
   * body: { card_id|uid|id, outcome, best_tp, settlement_price, entry_price, ... }
   */
  app.post("/api/cards/settlement", async (req, res) => {
    try {
      const body = req.body ?? {};
      const rawId = String(body.card_id ?? body.uid ?? body.id ?? "").trim();
      let id = Number(body.id);
      if (!Number.isFinite(id) || id <= 0) {
        const m = rawId.match(/(\d+)\s*$/);
        id = m ? Number(m[1]) : 0;
      }
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ ok: false, error: "card_id required" });
        return;
      }
      const row = await store.getSignalCardById(id);
      if (!row) {
        res.status(404).json({ ok: false, error: "not found" });
        return;
      }
      const card = archiveCardToClient(row);
      const ex = normalizeExecution(card.execution);
      const outcome = String(body.outcome ?? "").trim() || "pending";
      const settlement = Number(body.settlement_price ?? body.settlementPrice);
      const entry = Number(body.entry_price ?? body.entryPrice ?? ex.planned?.entryPrice);
      const bestTp = body.best_tp ?? body.bestTp ?? null;
      const isShort = isShortDirection(ex.direction ?? body.side);
      const isProgress = body.progress === true || outcome === "pending";

      /** @type {Record<string, unknown>} */
      const patch = {
        backtestJson: {
          ...(card.backtest && typeof card.backtest === "object" ? card.backtest : {}),
          mode: isProgress ? "oi_progress" : "oi_settlement",
          outcome: isProgress ? (ex.outcome || "pending") : outcome,
          bestTp,
          settlementPrice: Number.isFinite(settlement) ? settlement : null,
          entry: Number.isFinite(entry) ? entry : null,
          source: body.source ?? "oi_mornitor",
          exitCode: body.exit_code ?? body.exitCode ?? null,
          progress: isProgress,
          settledAt: new Date().toISOString(),
        },
      };

      if (isProgress) {
        // 分批/TP1 进度：更新 autoEval，不完结 outcome
        patch.executionJson = {
          ...ex,
          outcome: ex.outcome && ex.outcome !== "pending" ? ex.outcome : "pending",
          autoEval: {
            ...(ex.autoEval && typeof ex.autoEval === "object" ? ex.autoEval : {}),
            bestTp,
            settlementPrice: Number.isFinite(settlement) ? settlement : null,
            progress: true,
            exitCode: body.exit_code ?? body.exitCode ?? null,
            at: new Date().toISOString(),
            source: body.source ?? "oi_mornitor",
          },
        };
      } else if (
        (outcome === "take_profit" || outcome === "stop_loss") &&
        Number.isFinite(settlement) &&
        settlement > 0 &&
        Number.isFinite(entry) &&
        entry > 0
      ) {
        patch.executionJson = {
          ...ex,
          outcome,
          actual: {
            ...ex.actual,
            buyPrice: String(entry),
            sellPrice: String(settlement),
            takeProfitPrices: ex.actual?.takeProfitPrices ?? [],
            stopLossPrice: ex.actual?.stopLossPrice ?? "",
          },
          autoEval: {
            bestTp,
            settlementPrice: settlement,
            at: new Date().toISOString(),
            source: body.source ?? "oi_mornitor",
          },
        };
      }

      await store.updateSignalCard(id, patch);
      const updated = await store.getSignalCardById(id);
      if (updated) listCache.onRowChanged(updated);
      res.json({ ok: true, card: updated ? archiveCardToClient(updated) : null });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  /** 内部：YouTube 归档 */
  app.post("/api/cards/from-youtube", requireLocalRequest, async (req, res) => {
    try {
      const card = await archiveService.archiveFromYoutube(req.body ?? {});
      res.json({ ok: true, card });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  /** YouTube paste coin-action 入场价位监听（±3% / 1h，逻辑同卡片接近推送） */
  app.post("/api/youtube-fetch/coin-actions/watch", async (req, res) => {
    try {
      const body = req.body ?? {};
      const result = await archiveService.registerCoinActionWatches({
        sourceRef: String(body.sourceRef ?? body.sourceFile ?? ""),
        title: body.title,
        rawContent: pickCardBodyText(body) || body.rawContent || body.content,
        coinActions: body.coinActions,
        bandPct: body.bandPct,
      });
      const cards = Array.isArray(result) ? result : result.cards ?? [];
      const registered = Array.isArray(result) ? cards.length : Number(result.registered ?? cards.length);
      const skipped = Array.isArray(result) ? 0 : Number(result.skipped ?? 0);
      res.json({
        ok: true,
        registered,
        skipped,
        skippedItems: Array.isArray(result) ? [] : result.skippedItems ?? [],
        cards,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  /** 对外开放 v1 */
  app.get("/api/v1/cards", requireOpenApiKey, listHandler);
  app.get("/api/v1/cards/sources", requireOpenApiKey, sourcesHandler);
  app.get("/api/v1/cards/channels", requireOpenApiKey, channelsHandler);
  app.post("/api/v1/cards/liquidate", requireOpenApiKey, liquidateHandler);
  app.get("/api/v1/cards/:id", requireOpenApiKey, getCardByIdHandler);

  app.delete("/api/v1/cards/:id", requireOpenApiKey, async (req, res) => {
    try {
      const id = Number(req.params.id);
      const result = await archiveService.deleteCard(id);
      res.json({ ok: true, ...result });
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message ?? e);
      const status = msg === "not found" ? 404 : msg.includes("不可删除") ? 403 : 400;
      res.status(status).json({ ok: false, error: msg });
    }
  });

  app.post("/api/v1/cards", requireOpenApiKey, async (req, res) => {
    try {
      const body = req.body ?? {};
      if (looksLikeCardValidateRequest(body)) {
        return res.status(400).json({ ok: false, ...CARD_VALIDATE_MISROUTE_HINT });
      }
      if (store?.offline) {
        return res.status(503).json({
          ok: false,
          error: "MySQL 未连接，无法创建卡片（collect:ui 离线模式）",
          hint: "建卡需 MySQL。若目的是历史数据回测，请改用 POST /api/v1/cards/validate（联调可加 mock: true）",
          correctEndpoint: "/api/v1/cards/validate",
        });
      }
      const input = normalizeOpenCardInput(body);
      const execution = normalizeExecution(
        {
          symbol: input.symbol,
          direction: input.direction,
          entry: input.entry,
          targets: input.targets,
          takeProfits: input.targets,
          stopLoss: input.stopLoss,
          ...(body.execution && typeof body.execution === "object" ? body.execution : {}),
        },
        input.parsedJson
      );
      const assetClass = detectAssetClass(
        input.symbol ?? execution.symbol,
        input.parsedJson,
        execution,
        input.rawContent
      );
      const card = await archiveService.archiveCard({
        messageId: input.messageId,
        channelId: input.channelId,
        guildId: input.guildId,
        sourceType: input.sourceType,
        sourceRef: input.sourceRef,
        rawContent: input.rawContent,
        parsedJson: input.parsedJson,
        cardsByStyle: input.cardsByStyle,
        execution,
        cardFields: input.cardFields,
        symbol: input.symbol ?? execution.symbol,
        note: input.note,
        signalAt: input.signalAt,
        verifyMode: input.verifyMode,
        assetClass: input.assetClass ?? assetClass,
        injectChannelMessage: input.injectChannelMessage,
        channelName: input.channelName,
        channelAvatar: input.channelAvatar,
        images: input.images,
        mergeWindowMs: input.mergeWindowMs,
      });
      listCache.onClientCardChanged(card);
      res.status(201).json({
        ok: true,
        card,
        channelMessage: card?.channelMessage ?? null,
      });
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message ?? e);
      const body = req.body ?? {};
      if (looksLikeCardValidateRequest(body) || /insertSignalCard|离线模式|无法持久化/.test(msg)) {
        return res.status(400).json({ ok: false, error: msg, ...CARD_VALIDATE_MISROUTE_HINT });
      }
      res.status(400).json({ ok: false, error: msg });
    }
  });

  app.post("/api/v1/cards/from-youtube", requireOpenApiKey, async (req, res) => {
    try {
      const card = await archiveService.archiveFromYoutube(req.body ?? {});
      listCache.onClientCardChanged(card);
      res.status(201).json({ ok: true, card });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.post("/api/cards/liquidate", requireLocalRequest, liquidateHandler);

  app.post("/api/cards/clear-liquidation", requireLocalRequest, async (req, res) => {
    try {
      const body = req.body ?? {};
      const cardIds = Array.isArray(body.cardIds)
        ? body.cardIds.map((/** @type {unknown} */ id) => Number(id)).filter((n) => Number.isFinite(n) && n > 0)
        : [];
      const result = await runBatchClearLiquidation(store, liquidationLog, { cardIds }, liquidationHooks);
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  return { listCache };
}
