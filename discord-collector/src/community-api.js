/**
 * 社区 API：会员 / 广场 / 签到 / 打赏。
 */
import { createCommunityService } from "./community-service.js";

/**
 * @param {import("express").Express} app
 * @param {ReturnType<typeof import("./store.js").openStore> extends Promise<infer S> ? S : never} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 */
export function registerCommunityRoutes(app, store, log) {
  const community = createCommunityService(store, log);

  /** @param {import("express").Request} req */
  function tokenOf(req) {
    const h = String(req.headers["x-community-token"] ?? "").trim();
    if (h) return h;
    const auth = String(req.headers.authorization ?? "");
    const m = auth.match(/^Bearer\s+(.+)$/i);
    return m ? m[1].trim() : "";
  }

  /**
   * @param {import("express").Response} res
   * @param {unknown} e
   */
  function handleErr(res, e) {
    const err = /** @type {Error & { code?: string }} */ (e);
    const code = err.code || "";
    if (code === "COMMUNITY_OFFLINE") {
      res.status(503).json({ ok: false, error: "社区需 MySQL；请启动数据库后重启 collect:ui" });
      return;
    }
    if (code === "UNAUTHORIZED") {
      res.status(401).json({ ok: false, error: err.message });
      return;
    }
    if (code === "BAD_REQUEST" || code === "CONFLICT" || code === "INSUFFICIENT") {
      res.status(400).json({ ok: false, error: err.message });
      return;
    }
    if (code === "NOT_FOUND") {
      res.status(404).json({ ok: false, error: err.message });
      return;
    }
    log.warn(`community api: ${err.message}`);
    res.status(500).json({ ok: false, error: err.message || "internal" });
  }

  app.get("/api/community/overview", async (req, res) => {
    try {
      const data = await community.overview(tokenOf(req));
      res.json({ ok: true, ...data });
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.get("/api/community/titles", async (_req, res) => {
    try {
      res.json({ ok: true, ...(await community.listTitles()) });
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.get("/api/community/leaderboard", async (req, res) => {
    try {
      const limit = Number(req.query.limit) || 20;
      res.json({ ok: true, ...(await community.leaderboard(limit)) });
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.post("/api/community/register", async (req, res) => {
    try {
      const data = await community.register(req.body ?? {});
      res.json({ ok: true, ...data });
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.get("/api/community/me", async (req, res) => {
    try {
      res.json({ ok: true, ...(await community.me(tokenOf(req))) });
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.patch("/api/community/me", async (req, res) => {
    try {
      res.json({ ok: true, ...(await community.updateProfile(tokenOf(req), req.body ?? {})) });
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.post("/api/community/checkin", async (req, res) => {
    try {
      res.json({ ok: true, ...(await community.checkin(tokenOf(req))) });
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.get("/api/community/checkin/history", async (req, res) => {
    try {
      const limit = Number(req.query.limit) || 30;
      res.json({ ok: true, ...(await community.checkinHistory(tokenOf(req), limit)) });
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.get("/api/community/posts", async (req, res) => {
    try {
      res.json({
        ok: true,
        ...(await community.listPosts(tokenOf(req), {
          limit: Number(req.query.limit) || 30,
          beforeId: req.query.beforeId ? Number(req.query.beforeId) : undefined,
        })),
      });
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.post("/api/community/posts", async (req, res) => {
    try {
      res.json({ ok: true, ...(await community.createPost(tokenOf(req), req.body ?? {})) });
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.post("/api/community/posts/:id/comments", async (req, res) => {
    try {
      const id = Number(req.params.id);
      res.json({ ok: true, ...(await community.addComment(tokenOf(req), id, req.body ?? {})) });
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.post("/api/community/posts/:id/like", async (req, res) => {
    try {
      const id = Number(req.params.id);
      res.json({ ok: true, ...(await community.toggleLike(tokenOf(req), id)) });
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.get("/api/community/tips", async (req, res) => {
    try {
      res.json({
        ok: true,
        ...(await community.listTips({ limit: Number(req.query.limit) || 40 })),
      });
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.post("/api/community/tips", async (req, res) => {
    try {
      res.json({ ok: true, ...(await community.tip(tokenOf(req), req.body ?? {})) });
    } catch (e) {
      handleErr(res, e);
    }
  });
}
