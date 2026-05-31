/**
 * Discord 信号卡片 REST API。
 */
import { SIGNAL_STYLE_META, getSignalChannelConfig, getSignalChannelIds } from "./discord-signal-config.js";
import { signalCardToClient } from "./discord-signal-card-service.js";

/**
 * @param {import("express").Express} app
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./discord-signal-card-service.js").createDiscordSignalCardService>} signalService
 */
export function registerDiscordSignalRoutes(app, store, signalService) {
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
    });
  });

  app.get("/api/discord/signal-cards", async (req, res) => {
    try {
      const channelId = String(req.query.channel_id ?? req.query.channelId ?? "").trim();
      const status = String(req.query.status ?? "").trim();
      const limit = Number(req.query.limit) || 50;
      const rows = await store.listSignalCards({ channelId, status, limit });
      res.json({
        ok: true,
        channelId,
        cards: rows.map((r) => signalCardToClient(r)),
        channelConfig: channelId ? getSignalChannelConfig(channelId) : null,
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

      const row = await store.updateSignalCard(id, { status, expiresAt, cardsByStyle });
      if (!row) {
        res.status(404).json({ ok: false, error: "not found" });
        return;
      }
      res.json({ ok: true, card: signalCardToClient(row) });
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
      const result = await signalService.telegram.send(text, { channelId: card.channelId, cardId: id });
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
