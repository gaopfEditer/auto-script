/**
 * Kook 消息 REST：`POST` 批量入库（去重）、`GET` 按频道查询。
 * @param {import("express").Express} app
 * @param {{ listKookChannelMessages: (channelId: string, limit?: number) => Promise<unknown[]> }} store
 * @param {{ onClientBatch: (rows: unknown[]) => Promise<{ inserted: number, duplicate: number }> }} kookIngest
 */
export function registerKookMessageRoutes(app, store, kookIngest) {
  app.post("/api/kook/messages", async (req, res) => {
    const messages = Array.isArray(req.body?.messages) ? req.body.messages : [];
    if (!messages.length) {
      res.json({ ok: true, inserted: 0, duplicate: 0 });
      return;
    }
    try {
      const r = await kookIngest.onClientBatch(messages);
      res.json({ ok: true, inserted: r.inserted, duplicate: r.duplicate });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.get("/api/kook/messages", async (req, res) => {
    const channelId = String(req.query.channelId ?? req.query.channel_id ?? "").trim();
    const limit = Math.min(1000, Math.max(1, Number(req.query.limit) || 200));
    if (!channelId) {
      res.status(400).json({ ok: false, error: "缺少 channelId" });
      return;
    }
    try {
      const rows = await store.listKookChannelMessages(channelId, limit);
      res.json({ ok: true, channelId, rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });
}
