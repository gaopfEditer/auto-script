/**
 * 博主胜率本地 HTTP：只读 data/kolvip-sig，同步走 POST /sync。
 */
import { requireLocalRequest } from "./local-request.js";
import {
  loadKolvipSigBlogger,
  loadKolvipSigDetail,
  loadKolvipSigRank,
} from "./kolvip-sig-store.js";
import { kolvipSigLocalStatus, syncKolvipSigLocal } from "./kolvip-sig-sync.js";

const RANGE_OK = new Set(["7", "30", "all"]);

/**
 * @param {import("express").Express} app
 */
export function registerKolvipSigRoutes(app) {
  app.get("/api/kolvip/sig/meta", async (_req, res) => {
    try {
      res.json(await kolvipSigLocalStatus());
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });

  app.get("/api/kolvip/sig/rank", async (req, res) => {
    try {
      const range = String(req.query.range ?? "30").trim();
      if (!RANGE_OK.has(range)) {
        res.status(400).json({ ok: false, error: "range 须为 7 | 30 | all" });
        return;
      }
      const data = await loadKolvipSigRank(range);
      if (!data) {
        res.status(404).json({
          ok: false,
          error: "本地尚无该窗口数据，请先 POST /api/kolvip/sig/sync",
        });
        return;
      }
      res.json({ ok: true, range, local: true, ...data });
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });

  app.get("/api/kolvip/sig/blogger", async (req, res) => {
    try {
      const name = String(req.query.name ?? "").trim();
      const range = String(req.query.range ?? "30").trim();
      if (!name) {
        res.status(400).json({ ok: false, error: "缺少 name" });
        return;
      }
      if (!RANGE_OK.has(range)) {
        res.status(400).json({ ok: false, error: "range 须为 7 | 30 | all" });
        return;
      }
      const data = await loadKolvipSigBlogger(name, range);
      if (!data) {
        res.status(404).json({
          ok: false,
          error: `本地尚无博主「${name}」窗口 ${range}，请先同步`,
        });
        return;
      }
      res.json({ ok: true, name, range, local: true, ...data });
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });

  app.get("/api/kolvip/sig/detail", async (req, res) => {
    try {
      const id = String(req.query.id ?? "").trim();
      if (!id) {
        res.status(400).json({ ok: false, error: "缺少 id" });
        return;
      }
      const data = await loadKolvipSigDetail(id);
      if (!data) {
        res.status(404).json({ ok: false, error: "本地无该单子详情（同步时 detailLimit=0 默认不拉）" });
        return;
      }
      res.json({ ok: true, id, local: true, ...data });
    } catch (e) {
      res.status(500).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });

  app.post("/api/kolvip/sig/sync", requireLocalRequest, async (req, res) => {
    try {
      const detailLimit = Math.min(50, Math.max(0, Number(req.body?.detailLimit) || 0));
      const bloggerDelayMs = Math.min(3000, Math.max(0, Number(req.body?.bloggerDelayMs) || 350));
      const result = await syncKolvipSigLocal({ bloggerDelayMs, detailLimit });
      res.json(result);
    } catch (e) {
      res.status(400).json({ ok: false, error: /** @type {Error} */ (e).message });
    }
  });
}