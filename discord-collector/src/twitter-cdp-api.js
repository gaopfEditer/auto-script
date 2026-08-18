/**
 * 本地 CDP 抓取 X/Twitter 列表 → Telegram。
 */
/**
 * @param {import("express").Express} app
 * @param {ReturnType<typeof import("./twitter-cdp-service.js").createTwitterCdpService>} service
 */
export function registerTwitterCdpRoutes(app, service) {
  app.get("/api/twitter-cdp/status", async (_req, res) => {
    try {
      res.json(await service.status());
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });

  app.get("/api/twitter-cdp/config", (_req, res) => {
    res.json({ ok: true, config: service.getConfig() });
  });

  app.put("/api/twitter-cdp/config", async (req, res) => {
    try {
      const config = await service.updateConfig(req.body ?? {});
      res.json({ ok: true, config });
    } catch (e) {
      res.status(400).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });

  app.post("/api/twitter-cdp/probe", async (req, res) => {
    try {
      if (req.body?.port != null || req.body?.host) {
        await service.updateConfig({
          port: req.body.port,
          host: req.body.host,
        });
      }
      const cdp = await service.probe();
      res.json({ ok: cdp.ok, ...cdp });
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });

  app.post("/api/twitter-cdp/fetch", async (_req, res) => {
    try {
      const result = await service.runOnce({ force: true });
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });

  app.post("/api/twitter-cdp/seen/reset", async (req, res) => {
    try {
      const listId = String(req.body?.listId ?? req.query?.listId ?? "").trim();
      res.json(await service.resetSeen(listId));
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });
}
