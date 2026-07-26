/**
 * Discord 信号卡片 REST API。
 */
import { SIGNAL_STYLE_META, getSignalChannelConfig, getSignalChannelIds } from "./discord-signal-config.js";
import { getEvalLeverageConfig } from "./card-eval-leverage.js";
import { config } from "./config.js";
import { signalCardToClient } from "./discord-signal-card-service.js";
import {
  formatManualRawContent,
  normalizeExecution,
  normalizePriceList,
} from "./discord-signal-execution.js";
import { buildCardFieldsFromExecution, extractSymbolFromPayload } from "./card-fields.js";
import { detectAssetClass, resolveVerifyMode } from "./card-verify-policy.js";
import { signalTextHash } from "./discord-signal-dedup.js";
import { stampCardFieldsUid, stampCardsByStyle } from "./card-uid.js";
import { extractSignalCardRowId } from "./store.js";

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

/** @param {ReturnType<typeof signalCardToClient>[]} cards */
function summarizeCards(cards) {
  /** @type {Record<string, number>} */
  const byOutcome = {
    total: cards.length,
    pending: 0,
    take_profit: 0,
    stop_loss: 0,
    manual_close: 0,
    cancelled: 0,
  };
  for (const c of cards) {
    const o = String(c.execution?.outcome ?? "pending");
    if (o in byOutcome && o !== "total") byOutcome[o]++;
    else byOutcome.pending++;
  }
  return byOutcome;
}

/**
 * @param {import("express").Express} app
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./discord-signal-card-service.js").createDiscordSignalCardService>} signalService
 * @param {(channel: string, payload: Record<string, unknown>) => void} [broadcast]
 */
export function registerDiscordSignalRoutes(app, store, signalService, broadcast) {
  app.get("/api/discord/signal-config", (_req, res) => {
    /** @type {Record<string, unknown>} */
    const channels = {};
    for (const id of getSignalChannelIds()) {
      channels[id] = getSignalChannelConfig(id);
    }
    res.json({
      ok: true,
      styles: SIGNAL_STYLE_META,
      channelIds: [...getSignalChannelIds()],
      channels,
      evalLeverage: getEvalLeverageConfig(),
      cardNotifications: {
        desktop: config.cardToastDesktop,
        position: config.cardToastPosition,
      },
    });
  });

  app.get("/api/discord/signal-cards", async (req, res) => {
    try {
      const channelId = String(req.query.channel_id ?? req.query.channelId ?? "").trim();
      const status = String(req.query.status ?? "").trim();
      const limit = Number(req.query.limit) || 50;
      const { fromMs, toMs } = parseRangeMs(req);
      const rows = await store.listSignalCards({ channelId, status, limit, fromMs, toMs });
      res.json({
        ok: true,
        channelId,
        fromMs,
        toMs,
        cards: rows.map((r) => signalCardToClient(r)),
        channelConfig: channelId ? getSignalChannelConfig(channelId) : null,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.get("/api/discord/signal-overview", async (req, res) => {
    try {
      const { fromMs, toMs } = parseRangeMs(req);
      /** @type {Array<Record<string, unknown>>} */
      const channels = [];
      for (const channelId of getSignalChannelIds()) {
        const cfg = getSignalChannelConfig(channelId);
        const rows = await store.listSignalCards({ channelId, fromMs, toMs, limit: 500 });
        const cards = rows.map((r) => signalCardToClient(r));
        channels.push({
          channelId,
          name: cfg?.name ?? channelId,
          parser: cfg?.parser ?? "",
          stats: summarizeCards(cards),
          recent: cards.slice(0, 8),
        });
      }
      res.json({ ok: true, fromMs, toMs, channels });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.get("/api/discord/signal-history", async (req, res) => {
    try {
      const channelId = String(req.query.channel_id ?? req.query.channelId ?? "").trim();
      if (!channelId) {
        res.status(400).json({ ok: false, error: "channelId required" });
        return;
      }
      const { fromMs, toMs } = parseRangeMs(req);
      const limit = Number(req.query.limit) || 200;
      const rows = await store.listSignalCards({ channelId, fromMs, toMs, limit });
      res.json({
        ok: true,
        channelId,
        fromMs,
        toMs,
        channelConfig: getSignalChannelConfig(channelId),
        cards: rows.map((r) => signalCardToClient(r)),
        stats: summarizeCards(rows.map((r) => signalCardToClient(r))),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.patch("/api/discord/signal-cards/:id", async (req, res) => {
    try {
      const id = Number(req.params.id);
      if (!Number.isFinite(id) || id <= 0) {
        res.status(400).json({ ok: false, error: "invalid id" });
        return;
      }
      const status = req.body?.status != null ? String(req.body.status) : undefined;
      const expiresAt =
        req.body?.expiresAt !== undefined
          ? req.body.expiresAt
            ? String(req.body.expiresAt)
            : null
          : undefined;
      const cardsByStyle =
        req.body?.cardsByStyle && typeof req.body.cardsByStyle === "object"
          ? req.body.cardsByStyle
          : undefined;
      const note = req.body?.note !== undefined ? (req.body.note ? String(req.body.note) : null) : undefined;
      let executionJson =
        req.body?.execution !== undefined
          ? req.body.execution
          : req.body?.executionJson !== undefined
            ? req.body.executionJson
            : undefined;
      if (executionJson !== undefined) {
        executionJson = normalizeExecution(executionJson, null);
      }

      /** @type {Record<string, unknown>} */
      const patch = { status, expiresAt, cardsByStyle, note, executionJson };

      const row = await store.updateSignalCard(id, patch);
      if (!row) {
        res.status(404).json({ ok: false, error: "not found" });
        return;
      }
      res.json({ ok: true, card: signalCardToClient(row) });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.post("/api/discord/signal-cards", async (req, res) => {
    try {
      const channelId = String(req.body?.channelId ?? req.body?.channel_id ?? "").trim();
      const guildId = String(req.body?.guildId ?? req.body?.guild_id ?? "").trim();
      if (!channelId) {
        res.status(400).json({ ok: false, error: "channelId required" });
        return;
      }
      const chCfg = getSignalChannelConfig(channelId);
      if (!chCfg) {
        res.status(400).json({ ok: false, error: "not a signal channel" });
        return;
      }

      const execution = normalizeExecution(req.body?.execution ?? req.body, null);
      if (!execution.symbol) {
        res.status(400).json({ ok: false, error: "symbol required" });
        return;
      }
      if (req.body?.entryPrice != null && !req.body?.execution?.planned?.entryPrice) {
        execution.planned.entryPrice = String(req.body.entryPrice);
      }
      if (req.body?.takeProfitPrices != null && !req.body?.execution?.planned) {
        execution.planned.takeProfitPrices = normalizePriceList(req.body.takeProfitPrices);
      }
      if (req.body?.stopLossPrice != null && !req.body?.execution?.planned?.stopLossPrice) {
        execution.planned.stopLossPrice = String(req.body.stopLossPrice);
      }
      if (req.body?.direction != null && !execution.direction) {
        execution.direction = String(req.body.direction);
      }
      if (req.body?.outcome != null && !req.body?.execution?.outcome) {
        execution.outcome = String(req.body.outcome);
      }

      const rawContent = formatManualRawContent(execution);
      const messageId = `manual-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
      const textHash = signalTextHash(rawContent);
      const parsedJson = {
        manual: true,
        symbol: execution.symbol,
        direction: execution.direction,
        entry: execution.planned.entryPrice,
        targets: execution.planned.takeProfitPrices,
        stopLoss: execution.planned.stopLossPrice,
        assetClass: req.body?.assetClass,
        verifyMode: req.body?.verifyMode,
      };

      const assetClass = detectAssetClass(
        extractSymbolFromPayload(parsedJson, execution),
        parsedJson,
        execution,
        rawContent
      );
      const verifyMode = resolveVerifyMode(assetClass, req.body?.verifyMode);

      const row = await store.insertSignalCard({
        messageId,
        channelId,
        guildId,
        sourceTextHash: textHash,
        rawContent,
        parsedJson,
        cardsByStyle: { manual: rawContent },
        executionJson: execution,
        source: "manual",
        status: "active",
        note: req.body?.note ? String(req.body.note) : null,
        sourceType: "manual",
        sourceRef: channelId,
        symbol: extractSymbolFromPayload(parsedJson, execution),
        cardFieldsJson: buildCardFieldsFromExecution(execution, parsedJson, rawContent, {
          sourceType: "manual",
          sourceRef: channelId,
        }),
        signalAt: new Date().toISOString(),
        verifyMode,
        assetClass,
      });
      const cardId = extractSignalCardRowId(row?.id ?? row?.ID);
      let stamped = row;
      if (cardId) {
        stamped =
          (await store.updateSignalCard(cardId, {
            cardsByStyle: stampCardsByStyle({ manual: rawContent }, cardId),
            cardFieldsJson: stampCardFieldsUid(
              buildCardFieldsFromExecution(execution, parsedJson, rawContent, {
                sourceType: "manual",
                sourceRef: channelId,
              }),
              cardId
            ),
          })) ?? row;
      }
      const card = signalCardToClient(stamped);
      if (typeof signalService.pushExternalCard === "function") {
        await signalService.pushExternalCard({
          text: String(card.cardsByStyle?.manual ?? rawContent),
          card,
          message: {
            channelId,
            guildId,
            content: rawContent,
            timestamp: new Date().toISOString(),
          },
          channelName: chCfg?.name ?? "",
          channelId,
          guildId,
          event: "created",
          parsed: parsedJson,
          execution,
        });
      } else if (typeof signalService.pushExternal === "function") {
        await signalService.pushExternal(String(card.cardsByStyle?.manual ?? rawContent), {
          cardId: Number(card.id),
          uid: String(card.uid ?? ""),
          channelId,
          channelName: chCfg?.name,
        });
      }
      broadcast?.("meta", { kind: "signal_card_created", card });
      res.json({ ok: true, card });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.post("/api/discord/signal-cards/:id/telegram", async (req, res) => {
    try {
      const id = Number(req.params.id);
      const styleId = String(req.body?.styleId ?? "").trim();
      const rows = await store.listSignalCards({ limit: 500 });
      const row = rows.find((r) => Number(r.id) === id);
      if (!row) {
        res.status(404).json({ ok: false, error: "not found" });
        return;
      }
      const card = signalCardToClient(row);
      const chCfg = getSignalChannelConfig(card.channelId);
      const text =
        (styleId && card.cardsByStyle[styleId]) ||
        card.cardsByStyle[chCfg?.telegramStyle ?? ""] ||
        Object.values(card.cardsByStyle)[0] ||
        card.rawContent;
      const result = await signalService.telegram.send(text, {
        channelId: card.channelId,
        channelName: chCfg?.name,
        cardId: id,
      });
      if (result.skipped) {
        res.json({ ok: false, skipped: result.skipped });
        return;
      }
      await store.markSignalCardTelegramSent(id);
      res.json({ ok: true });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });
}
