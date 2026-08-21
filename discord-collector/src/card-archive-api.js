/**
 * 统一卡片归档 API（内部 /api/cards + 对外开放 /api/v1/cards）。
 */
import {
  archiveCardToClient,
  createCardArchiveService,
  resolveCardChannelName,
} from "./card-archive-service.js";
import { normalizeExecution } from "./discord-signal-execution.js";
import { detectAssetClass } from "./card-verify-policy.js";
import { config } from "./config.js";

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
  const prevParsed =
    b.parsedJson && typeof b.parsedJson === "object" && !Array.isArray(b.parsedJson)
      ? /** @type {Record<string, unknown>} */ (b.parsedJson)
      : {};

  return {
    messageId: b.messageId,
    channelId,
    guildId: b.guildId,
    sourceType: b.sourceType ?? "api",
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
  };
}

/** @param {import("express").Request} req */
function parseRangeMs(req) {
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
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
function requireOpenApiKey(req, res, next) {
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
 */
export function registerCardArchiveRoutes(app, store, archiveService) {
  async function listHandler(req, res) {
    try {
      const { fromMs, toMs } = parseRangeMs(req);
      const sourceType = String(req.query.source ?? req.query.source_type ?? req.query.sourceType ?? "").trim();
      const symbol = String(req.query.symbol ?? req.query.coin ?? "").trim();
      const status = String(req.query.status ?? "").trim();
      const limit = Number(req.query.limit) || 100;
      const channelId = String(req.query.channel_id ?? req.query.channelId ?? "").trim();

      const rows = await store.listSignalCards({
        channelId,
        status,
        limit,
        fromMs,
        toMs,
        sourceType,
        symbol,
      });

      const cards = rows.map((r) => archiveCardToClient(r));
      res.json({
        ok: true,
        fromMs,
        toMs,
        filters: { sourceType, symbol, status, channelId },
        total: cards.length,
        cards,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  }

  app.get("/api/cards", listHandler);

  app.get("/api/cards/sources", (_req, res) => {
    res.json({
      ok: true,
      sources: ["discord", "youtube", "api", "manual"],
    });
  });

  app.get("/api/cards/channels", async (req, res) => {
    try {
      const { fromMs, toMs } = parseRangeMs(req);
      const sourceType = String(req.query.source ?? req.query.source_type ?? req.query.sourceType ?? "").trim();
      const symbol = String(req.query.symbol ?? req.query.coin ?? "").trim();
      const status = String(req.query.status ?? "").trim();
      const rows = await store.listSignalCardChannels({
        status,
        fromMs,
        toMs,
        sourceType,
        symbol,
      });
      const channels = rows.map((r) => ({
        channelId: String(r.channel_id ?? ""),
        channelName: resolveCardChannelName(r.channel_id, r.channel_name),
        count: Number(r.cnt ?? 0),
      }));
      res.json({ ok: true, fromMs, toMs, channels });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.get("/api/cards/:id", async (req, res) => {
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
      const isShort = /空|short|sell/i.test(String(ex.direction ?? body.side ?? ""));
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
            buyPrice: isShort ? String(settlement) : String(entry),
            sellPrice: isShort ? String(entry) : String(settlement),
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
      res.json({ ok: true, card: updated ? archiveCardToClient(updated) : null });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  /** 内部：YouTube 归档 */
  app.post("/api/cards/from-youtube", async (req, res) => {
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

  app.get("/api/v1/cards/:id", requireOpenApiKey, async (req, res) => {
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
  });

  app.post("/api/v1/cards", requireOpenApiKey, async (req, res) => {
    try {
      const body = req.body ?? {};
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
      });
      res.status(201).json({
        ok: true,
        card,
        channelMessage: card?.channelMessage ?? null,
      });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.post("/api/v1/cards/from-youtube", requireOpenApiKey, async (req, res) => {
    try {
      const card = await archiveService.archiveFromYoutube(req.body ?? {});
      res.status(201).json({ ok: true, card });
    } catch (e) {
      res.status(400).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });
}
