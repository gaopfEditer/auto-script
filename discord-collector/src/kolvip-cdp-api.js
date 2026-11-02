/**
 * 巨鲸 kolvip HTTP：状态、胜率摘要、回溯试点。
 */
import { config } from "./config.js";
import { buildKolvipEvalSummary } from "./kolvip-cdp-eval.js";
import { getKolvipChannelMappings } from "./kolvip-cdp-config.js";
import { requireLocalRequest } from "./local-request.js";

/**
 * @param {import("express").Express} app
 * @param {ReturnType<typeof import("./kolvip-cdp-service.js").createKolvipCdpService>} kolvipCdp
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./kolvip-cdp-backfill.js").createKolvipBackfillService>} backfill
 */
export function registerKolvipCdpRoutes(app, kolvipCdp, store, backfill) {
  app.get("/api/kolvip/status", async (_req, res) => {
    try {
      res.json(await kolvipCdp.status());
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });

  app.post("/api/kolvip/fetch", requireLocalRequest, async (_req, res) => {
    try {
      res.json(await kolvipCdp.runOnce());
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });

  app.get("/api/kolvip/mappings", (_req, res) => {
    res.json({ ok: true, channels: getKolvipChannelMappings() });
  });

  app.get("/api/kolvip/eval-summary", async (req, res) => {
    try {
      const days = Math.min(90, Math.max(1, Number(req.query.days) || 7));
      const toMs = Date.now();
      const fromMs = toMs - days * 86400000;
      const summary = await buildKolvipEvalSummary(store, { fromMs, toMs });
      res.json({ ok: true, days, ...summary });
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });

  app.get("/api/kolvip/backfill/status", async (_req, res) => {
    try {
      res.json(await backfill.status());
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });

  app.post("/api/kolvip/backfill/start", requireLocalRequest, async (req, res) => {
    try {
      const kid = String(req.body?.kolvipChannelId ?? req.query?.kolvipChannelId ?? "").trim();
      if (!kid) {
        res.status(400).json({ ok: false, error: "缺少 kolvipChannelId（试点如 16）" });
        return;
      }
      if (!config.kolvipBackfillEnabled) {
        res.status(400).json({
          ok: false,
          error: "KOLVIP_BACKFILL_ENABLED=0，请先在 .env 开启回溯骨架",
        });
        return;
      }
      res.json({ ok: true, ...(await backfill.startPilot(kid)) });
    } catch (e) {
      res.status(400).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });

  app.post("/api/kolvip/backfill/pause", requireLocalRequest, async (_req, res) => {
    try {
      res.json({ ok: true, ...(await backfill.pauseAll()) });
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });
}
