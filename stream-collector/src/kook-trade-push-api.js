/**
 * 前端可主动上报做单消息（与 ingest 路径共用去重与 Telegram 推送逻辑）。
 * @param {import("express").Express} app
 * @param {ReturnType<typeof import("./kook-trade-telegram-push.js").createKookTradeTelegramPush>} tradePush
 */
export function registerKookTradePushRoutes(app, tradePush) {
  app.post("/api/kook/trade-signal/notify", async (req, res) => {
    const body = req.body ?? {};
    try {
      const r = await tradePush.maybePush({
        messageId: String(body.messageId ?? body.message_id ?? "").trim(),
        guildId: String(body.guildId ?? body.guild_id ?? "").trim(),
        channelId: String(body.channelId ?? body.channel_id ?? "").trim(),
        authorId: String(body.authorId ?? body.author_id ?? "").trim(),
        authorNickname: body.authorNickname ?? body.author_nickname ?? null,
        authorUsername: body.authorUsername ?? body.author_username ?? null,
        createAtMs: Number(body.createAtMs ?? body.create_at_ms) || 0,
        content: String(body.content ?? ""),
        source: String(body.source ?? "frontend_notify"),
      });
      res.json({ ok: true, ...r });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.get("/api/kook/trade-signal/config", (_req, res) => {
    res.json({
      ok: true,
      enabled: tradePush.enabled,
      guildIds: tradePush.guildIds,
      chatId: tradePush.chatId ? String(tradePush.chatId) : "",
    });
  });
}
