/**
 * 统一卡片归档 API（内部 /api/cards + 对外开放 /api/v1/cards）。
 */
import {
  archiveCardToClient,
  createCardArchiveService,
  resolveCardChannelName,
} from "./card-archive-service.js";
import { detectAssetClass } from "./card-verify-policy.js";
import { normalizeExecution } from "./discord-signal-execution.js";
import { config } from "./config.js";

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

  /** 内部：YouTube 归档 */
  app.post("/api/cards/from-youtube", async (req, res) => {
    try {
      const card = await archiveService.archiveFromYoutube(req.body ?? {});
      res.json({ ok: true, card });
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
      const execution = normalizeExecution(body.execution ?? body, body.parsedJson);
      const assetClass = detectAssetClass(
        body.symbol ?? execution.symbol,
        body.parsedJson,
        execution,
        body.rawContent
      );
      const card = await archiveService.archiveCard({
        messageId: body.messageId,
        channelId: body.channelId ?? "api",
        guildId: body.guildId,
        sourceType: body.sourceType ?? "api",
        sourceRef: body.sourceRef ?? body.externalId,
        rawContent: body.rawContent ?? body.description,
        parsedJson: body.parsedJson,
        cardsByStyle: body.cardsByStyle,
        execution,
        cardFields: body.cardFields ?? body.embed,
        symbol: body.symbol ?? execution.symbol,
        note: body.note,
        signalAt: body.signalAt,
        verifyMode: body.verifyMode,
        assetClass: body.assetClass ?? assetClass,
      });
      res.status(201).json({ ok: true, card });
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
