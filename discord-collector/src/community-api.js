/**
 * 社区 API：会员 / 广场 / 签到 / 打赏 / 聊天室。
 */
import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import express from "express";
import multer from "multer";
import { config } from "./config.js";
import { createCommunityService } from "./community-service.js";

const IMAGE_EXTS = new Set([".jpg", ".jpeg", ".png", ".gif", ".webp"]);
const VIDEO_EXTS = new Set([".mp4", ".webm"]);
const IMAGE_MIME = new Set(["image/jpeg", "image/png", "image/gif", "image/webp"]);
const VIDEO_MIME = new Set(["video/mp4", "video/webm"]);

function ensureUploadRoot() {
  const root = config.communityChatUploadDir;
  fs.mkdirSync(root, { recursive: true });
  return root;
}

/**
 * @param {import("express").Express} app
 * @param {ReturnType<typeof import("./store.js").openStore> extends Promise<infer S> ? S : never} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {(channel: string, payload: Record<string, unknown>) => void} [broadcast]
 */
export function registerCommunityRoutes(app, store, log, broadcast) {
  const community = createCommunityService(store, log, broadcast);
  const uploadRoot = ensureUploadRoot();

  const storage = multer.diskStorage({
    destination(_req, _file, cb) {
      const now = new Date();
      const dir = path.join(
        uploadRoot,
        String(now.getFullYear()),
        String(now.getMonth() + 1).padStart(2, "0")
      );
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename(_req, file, cb) {
      const ext = path.extname(file.originalname || "").toLowerCase() || ".bin";
      cb(null, `${randomUUID()}${ext}`);
    },
  });

  const upload = multer({
    storage,
    limits: {
      fileSize: Math.max(config.communityChatImageMaxBytes, config.communityChatVideoMaxBytes),
      files: 1,
    },
    fileFilter(_req, file, cb) {
      const ext = path.extname(file.originalname || "").toLowerCase();
      const mime = String(file.mimetype || "").toLowerCase();
      const okImage = IMAGE_EXTS.has(ext) || IMAGE_MIME.has(mime);
      const okVideo = VIDEO_EXTS.has(ext) || VIDEO_MIME.has(mime);
      if (!okImage && !okVideo) {
        const err = /** @type {Error & { code?: string }} */ (new Error("仅支持图片 jpeg/png/gif/webp 或短视频 mp4/webm"));
        err.code = "BAD_REQUEST";
        cb(err);
        return;
      }
      cb(null, true);
    },
  });

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
    if (code === "BAD_REQUEST" || code === "CONFLICT" || code === "INSUFFICIENT" || code === "LIMIT_FILE_SIZE") {
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

  app.patch("/api/community/me/avatar", async (req, res) => {
    try {
      res.json({ ok: true, ...(await community.setAvatar(tokenOf(req), req.body ?? {})) });
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.get("/api/community/avatar-packs", async (_req, res) => {
    try {
      res.json({ ok: true, ...(await community.listAvatarPacks()) });
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

  app.get("/api/community/chat/messages", async (req, res) => {
    try {
      res.json({
        ok: true,
        ...(await community.listChatMessages({
          limit: Number(req.query.limit) || 50,
          beforeId: req.query.before ? Number(req.query.before) : undefined,
        })),
      });
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.post("/api/community/chat/messages", async (req, res) => {
    try {
      res.json({ ok: true, ...(await community.sendChatMessage(tokenOf(req), req.body ?? {})) });
    } catch (e) {
      handleErr(res, e);
    }
  });

  app.post("/api/community/chat/media", (req, res) => {
    upload.single("file")(req, res, async (err) => {
      if (err) {
        const e = /** @type {Error & { code?: string }} */ (err);
        if (e.code === "LIMIT_FILE_SIZE") {
          e.message = "文件过大（图片≤5MB，短视频≤20MB）";
          e.code = "BAD_REQUEST";
        }
        handleErr(res, e);
        return;
      }
      try {
        // 鉴权放在文件落地后，失败则删文件
        await community.me(tokenOf(req));
        const file = req.file;
        if (!file) {
          const e = /** @type {Error & { code?: string }} */ (new Error("缺少文件 field=file"));
          e.code = "BAD_REQUEST";
          throw e;
        }
        const ext = path.extname(file.filename).toLowerCase();
        const mime = String(file.mimetype || "").toLowerCase();
        const isImage = IMAGE_EXTS.has(ext) || IMAGE_MIME.has(mime);
        const isVideo = VIDEO_EXTS.has(ext) || VIDEO_MIME.has(mime);
        const max = isVideo ? config.communityChatVideoMaxBytes : config.communityChatImageMaxBytes;
        if (file.size > max) {
          fs.unlink(file.path, () => {});
          const e = /** @type {Error & { code?: string }} */ (
            new Error(isVideo ? "短视频不得超过 20MB" : "图片不得超过 5MB")
          );
          e.code = "BAD_REQUEST";
          throw e;
        }
        const rel = path.relative(uploadRoot, file.path).split(path.sep).join("/");
        if (rel.startsWith("..") || path.isAbsolute(rel)) {
          fs.unlink(file.path, () => {});
          const e = /** @type {Error & { code?: string }} */ (new Error("非法存储路径"));
          e.code = "BAD_REQUEST";
          throw e;
        }
        const mediaUrl = `/api/community/chat/media/file/${rel}`;
        res.json({
          ok: true,
          mediaUrl,
          type: isVideo ? "video" : "image",
          size: file.size,
          mime: file.mimetype,
        });
      } catch (e) {
        if (req.file?.path) fs.unlink(req.file.path, () => {});
        handleErr(res, e);
      }
    });
  });

  // 媒体文件静态访问（路径已限制在 uploadRoot 下）
  app.use(
    "/api/community/chat/media/file",
    (req, _res, next) => {
      // 禁止路径穿越
      if (String(req.path).includes("..")) {
        next(Object.assign(new Error("非法路径"), { code: "BAD_REQUEST" }));
        return;
      }
      next();
    },
    express.static(uploadRoot, { fallthrough: false, index: false })
  );
}
