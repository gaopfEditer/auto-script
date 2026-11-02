/**
 * 巨鲸 CDP 本地 API：概览（胜率 + 回溯状态）。
 */
import { requireLocalRequest } from "./local-request.js";
import { buildKolvipChannelEvalOverview } from "./kolvip-cdp-overview.js";

/**
 * @param {import("express").Express} app
 * @param {{
 *   kolvipCdp: ReturnType<typeof import("./kolvip-cdp-service.js").createKolvipCdpService>,
 *   kolvipBackfill: ReturnType<typeof import("./kolvip-cdp-backfill.js").createKolvipBackfillService>,
 *   store: ReturnType<typeof import("./store.js").openStore>,
 * }} deps
 */
export function registerKolvipCdpRoutes(app, deps) {
  const { kolvipCdp, kolvipBackfill, store } = deps;

  app.get("/api/local/kolvip-cdp/overview", requireLocalRequest, async (req, res) => {
    try {
      const days = Number(req.query.days) || 30;
      const [live, backfill, evalOverview] = await Promise.all([
        kolvipCdp.status(),
        kolvipBackfill.getPublicState(),
        buildKolvipChannelEvalOverview(store, { days }),
      ]);

      const liveByCh = new Map(
        (live.lastRun?.channels ?? []).map((c) => [String(c.kolvipChannelId), c])
      );
      const backfillCh =
        backfill.channels && typeof backfill.channels === "object" ? backfill.channels : {};

      const channels = evalOverview.channels.map((row) => {
        const kid = row.kolvipChannelId;
        const bf = backfillCh[kid] && typeof backfillCh[kid] === "object" ? backfillCh[kid] : {};
        const liveRow = liveByCh.get(kid);
        let uiStatus = row.sampleStatus;
        if (liveRow?.error) uiStatus = "live_failed";
        else if (backfill.running && bf.status === "running") uiStatus = "backfill_running";
        else if (live.running) uiStatus = "live_running";
        else if (bf.status === "failed") uiStatus = "backfill_failed";
        else if (bf.status === "pending" || bf.status === "cooldown") uiStatus = "backfill_pending";
        return {
          ...row,
          uiStatus,
          live: liveRow ?? null,
          backfill: bf,
        };
      });

      res.json({
        ok: true,
        live,
        backfill,
        eval: { ...evalOverview, channels },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });

  app.get("/api/local/kolvip-cdp/status", requireLocalRequest, async (_req, res) => {
    try {
      const live = await kolvipCdp.status();
      res.json({ ok: true, ...live });
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });

  app.post("/api/local/kolvip-cdp/backfill/pause", requireLocalRequest, async (_req, res) => {
    await kolvipBackfill.pause();
    res.json({ ok: true });
  });

  app.post("/api/local/kolvip-cdp/backfill/resume", requireLocalRequest, async (_req, res) => {
    await kolvipBackfill.resume();
    res.json({ ok: true });
  });

  app.post("/api/local/kolvip-cdp/backfill/step", requireLocalRequest, async (_req, res) => {
    const r = await kolvipBackfill.runPhaseStep();
    res.json({ ok: true, ...r });
  });
}
