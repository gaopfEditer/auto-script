/**
 * Telegram 实时消息：按 channel_profiles.json 展示群消息。
 * Python listen.py 经 POST /api/telegram/live/ingest 写入 SQLite + WS。
 * 切 tab / 重启后仍可从库拉取；支持置顶与编辑置顶备注。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { requireLocalRequest } from "./local-request.js";
import { createLogger } from "./logger.js";
import { openTelegramLiveStore } from "./telegram-live-store.js";

const log = createLogger("telegram-live");
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TELEGRAM_DIR = path.resolve(__dirname, "..", "..", "telegram");
const PROFILES_FILE = path.join(TELEGRAM_DIR, "channel_profiles.json");

const store = openTelegramLiveStore(config.telegramLiveSqlitePath);

/**
 * @typedef {{
 *   id: string,
 *   chatId: string,
 *   chatName: string,
 *   avatarUrl: string,
 *   sender: string,
 *   text: string,
 *   messageId: number,
 *   at: string,
 *   receivedAt: number,
 *   pinned?: boolean,
 *   pinNote?: string,
 *   pinOrder?: number,
 *   updatedAt?: number,
 *   imageUrls?: string[],
 * }} LiveMessage
 */

/** @param {string} avatarRel */
function avatarToUrl(avatarRel) {
  const s = String(avatarRel || "").trim();
  if (!s) return "";
  if (/^https?:\/\//i.test(s) || s.startsWith("data:")) return s;
  const base = path.basename(s.replace(/\\/g, "/"));
  if (!base) return "";
  return `/telegram-avatars/${encodeURIComponent(base)}`;
}

/** @param {unknown} raw */
function normalizeImageUrls(raw) {
  if (Array.isArray(raw)) {
    return raw
      .map((u) => String(u || "").trim())
      .filter((u) => u && (u.startsWith("/") || /^https?:\/\//i.test(u) || u.startsWith("data:")))
      .slice(0, 12);
  }
  if (typeof raw === "string" && raw.trim()) {
    try {
      return normalizeImageUrls(JSON.parse(raw));
    } catch {
      return normalizeImageUrls(raw.split(/[\n,|]/));
    }
  }
  return [];
}

export function readChannelProfiles() {
  /** @type {Array<{ chatId: string, name: string, avatar: string, avatarUrl: string }>} */
  const channels = [];
  try {
    if (!fs.existsSync(PROFILES_FILE)) {
      return { channels, file: PROFILES_FILE, ok: false, error: "channel_profiles.json 不存在" };
    }
    const raw = JSON.parse(fs.readFileSync(PROFILES_FILE, "utf8"));
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
      return { channels, file: PROFILES_FILE, ok: false, error: "profiles 格式无效" };
    }
    for (const [chatId, meta] of Object.entries(raw)) {
      const id = String(chatId || "").trim();
      if (!id) continue;
      const m = meta && typeof meta === "object" ? /** @type {Record<string, unknown>} */ (meta) : {};
      const name = String(m.name ?? id).trim() || id;
      const avatar = String(m.avatar ?? "").trim();
      channels.push({
        chatId: id,
        name,
        avatar,
        avatarUrl: avatarToUrl(avatar),
      });
    }
    return { channels, file: PROFILES_FILE, ok: true };
  } catch (e) {
    log.warn(`读 channel_profiles 失败: ${/** @type {Error} */ (e).message}`);
    return {
      channels,
      file: PROFILES_FILE,
      ok: false,
      error: String(/** @type {Error} */ (e).message ?? e),
    };
  }
}

/** @param {Partial<LiveMessage> & { chatId: string, text?: string }} raw */
function normalizeIngest(raw) {
  const chatId = String(raw.chatId ?? "").trim();
  if (!chatId) return null;
  const text = String(raw.text ?? "").trim();
  const messageId = Number(raw.messageId) || 0;
  const at = String(raw.at || new Date().toISOString());
  const id =
    String(raw.id || "").trim() ||
    `${chatId}:${messageId || Date.now()}:${Math.random().toString(36).slice(2, 8)}`;
  const profiles = readChannelProfiles().channels;
  const hit = profiles.find((c) => c.chatId === chatId || c.chatId === String(Number(chatId)));
  return {
    id,
    chatId,
    chatName: String(raw.chatName || hit?.name || chatId),
    avatarUrl: String(raw.avatarUrl || hit?.avatarUrl || ""),
    sender: String(raw.sender || "").trim() || "—",
    text,
    messageId,
    at,
    receivedAt: Date.now(),
    imageUrls: normalizeImageUrls(
      /** @type {any} */ (raw).imageUrls ?? /** @type {any} */ (raw).image_urls,
    ),
  };
}

/**
 * @param {import("express").Express} app
 * @param {(channel: string, payload: Record<string, unknown>) => void} broadcast
 */
export function registerTelegramLiveRoutes(app, broadcast) {
  app.get("/api/telegram/live/channels", (_req, res) => {
    const { channels, file, ok, error } = readChannelProfiles();
    res.json({
      ok: true,
      channels,
      file,
      profilesOk: ok,
      error: error || undefined,
      messageCount: store.count(),
      dbPath: config.telegramLiveSqlitePath,
    });
  });

  app.get("/api/telegram/live/messages", (req, res) => {
    const chatId = String(req.query.chatId ?? "").trim();
    const limit = Math.min(2000, Math.max(1, Number(req.query.limit) || 300));
    const sinceMs = Number(req.query.sinceMs) || 0;
    const rows = store.listMessages({
      chatId: chatId || undefined,
      limit,
      sinceMs: sinceMs || undefined,
    });
    res.json({
      ok: true,
      messages: rows,
      total: store.count(),
      pinnedCount: store.listPinned(500).length,
    });
  });

  app.get("/api/telegram/live/pins", (_req, res) => {
    res.json({ ok: true, pins: store.listPinned(200) });
  });

  app.post("/api/telegram/live/ingest", requireLocalRequest, (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const batch = Array.isArray(body.messages)
        ? body.messages
        : body.message
          ? [body.message]
          : [body];
      /** @type {LiveMessage[]} */
      const accepted = [];
      const allowed = new Set(readChannelProfiles().channels.map((c) => c.chatId));
      for (const c of [...allowed]) {
        const n = Number(c);
        if (Number.isFinite(n)) allowed.add(String(n));
      }

      for (const raw of batch) {
        if (!raw || typeof raw !== "object") continue;
        const msg = normalizeIngest(/** @type {any} */ (raw));
        if (!msg) continue;
        const saved = store.upsertMessage(msg);
        if (!saved) continue;
        accepted.push(saved);
        broadcast("telegram_live", { kind: "telegram_message", message: saved });
      }
      if (accepted.length) {
        try {
          store.prune(8000);
        } catch (e) {
          log.debug(`prune: ${/** @type {Error} */ (e).message}`);
        }
      }

      res.json({ ok: true, accepted: accepted.length });
    } catch (e) {
      log.warn(`ingest 失败: ${/** @type {Error} */ (e).message}`);
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  /** 置顶 / 取消置顶 */
  app.post("/api/telegram/live/pin", requireLocalRequest, (req, res) => {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const id = String(body.id ?? "").trim();
      if (!id) {
        res.status(400).json({ ok: false, error: "id required" });
        return;
      }
      const pinned = body.pinned !== false && body.pinned !== 0 && body.pinned !== "0";
      const pinNote = body.pinNote != null ? String(body.pinNote) : undefined;
      const row = store.setPinned(id, { pinned, pinNote });
      if (!row) {
        res.status(404).json({ ok: false, error: "message not found" });
        return;
      }
      broadcast("telegram_live", { kind: "telegram_pin", message: row });
      res.json({ ok: true, message: row });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  /** 编辑置顶：备注 / 正文 */
  app.patch("/api/telegram/live/pins/:id", requireLocalRequest, (req, res) => {
    try {
      const id = String(req.params.id || "").trim();
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const row = store.updatePinned(id, {
        pinNote: body.pinNote != null ? String(body.pinNote) : undefined,
        text: body.text != null ? String(body.text) : undefined,
      });
      if (!row) {
        res.status(404).json({ ok: false, error: "pinned message not found" });
        return;
      }
      broadcast("telegram_live", { kind: "telegram_pin", message: row });
      res.json({ ok: true, message: row });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.post("/api/telegram/live/clear", requireLocalRequest, (_req, res) => {
    store.clearUnpinned();
    broadcast("telegram_live", { kind: "telegram_cleared" });
    res.json({ ok: true, keptPinned: store.listPinned(500).length });
  });
}
