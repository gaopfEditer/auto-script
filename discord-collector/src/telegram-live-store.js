/**
 * Telegram 实时消息本地 SQLite（不依赖 MySQL；切 tab / 重启仍可拉）。
 */
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createLogger } from "./logger.js";

const log = createLogger("telegram-live-store");

/** @typedef {{
 *   id: string,
 *   chatId: string,
 *   chatName: string,
 *   avatarUrl: string,
 *   sender: string,
 *   text: string,
 *   messageId: number,
 *   at: string,
 *   receivedAt: number,
 *   pinned: boolean,
 *   pinNote: string,
 *   pinOrder: number,
 *   updatedAt: number,
 *   imageUrls: string[],
 * }} TelegramLiveRow */

/** @param {unknown} raw */
function parseImageUrls(raw) {
  if (Array.isArray(raw)) {
    return raw.map((u) => String(u || "").trim()).filter(Boolean).slice(0, 12);
  }
  const s = String(raw ?? "").trim();
  if (!s) return [];
  try {
    const j = JSON.parse(s);
    if (Array.isArray(j)) {
      return j.map((u) => String(u || "").trim()).filter(Boolean).slice(0, 12);
    }
  } catch {
    /* ignore */
  }
  return s
    .split(/[\n,|]/)
    .map((u) => u.trim())
    .filter(Boolean)
    .slice(0, 12);
}

/** @param {import("node:sqlite").DatabaseSync} db */
function ensureSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS telegram_live_messages (
      id TEXT PRIMARY KEY,
      chat_id TEXT NOT NULL,
      chat_name TEXT NOT NULL DEFAULT '',
      avatar_url TEXT NOT NULL DEFAULT '',
      sender TEXT NOT NULL DEFAULT '',
      text TEXT NOT NULL DEFAULT '',
      message_id INTEGER NOT NULL DEFAULT 0,
      at_iso TEXT NOT NULL,
      received_at_ms INTEGER NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      pin_note TEXT NOT NULL DEFAULT '',
      pin_order INTEGER NOT NULL DEFAULT 0,
      updated_at_ms INTEGER NOT NULL,
      image_urls TEXT NOT NULL DEFAULT ''
    );
    CREATE INDEX IF NOT EXISTS idx_tg_live_chat_at
      ON telegram_live_messages(chat_id, at_iso);
    CREATE INDEX IF NOT EXISTS idx_tg_live_received
      ON telegram_live_messages(received_at_ms DESC);
    CREATE INDEX IF NOT EXISTS idx_tg_live_pinned
      ON telegram_live_messages(pinned, pin_order DESC, updated_at_ms DESC);
  `);
  try {
    db.exec(
      `ALTER TABLE telegram_live_messages ADD COLUMN image_urls TEXT NOT NULL DEFAULT ''`,
    );
  } catch {
    /* already exists */
  }
}

/** @param {Record<string, unknown>} row */
function mapRow(row) {
  return {
    id: String(row.id ?? ""),
    chatId: String(row.chat_id ?? ""),
    chatName: String(row.chat_name ?? ""),
    avatarUrl: String(row.avatar_url ?? ""),
    sender: String(row.sender ?? ""),
    text: String(row.text ?? ""),
    messageId: Number(row.message_id) || 0,
    at: String(row.at_iso ?? ""),
    receivedAt: Number(row.received_at_ms) || 0,
    pinned: Number(row.pinned) === 1,
    pinNote: String(row.pin_note ?? ""),
    pinOrder: Number(row.pin_order) || 0,
    updatedAt: Number(row.updated_at_ms) || 0,
    imageUrls: parseImageUrls(row.image_urls),
  };
}

/**
 * @param {string} dbPath
 */
export function openTelegramLiveStore(dbPath) {
  const dir = path.dirname(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  const db = new DatabaseSync(dbPath);
  ensureSchema(db);
  log.info(`Telegram live SQLite: ${dbPath}`);

  return {
    /** @param {Omit<TelegramLiveRow, "pinned" | "pinNote" | "pinOrder" | "updatedAt"> & Partial<Pick<TelegramLiveRow, "pinned" | "pinNote" | "pinOrder">>} msg */
    upsertMessage(msg) {
      const now = Date.now();
      const id = String(msg.id || "").trim();
      if (!id) return null;
      const existing = db
        .prepare(`SELECT pinned, pin_note, pin_order FROM telegram_live_messages WHERE id = ?`)
        .get(id);
      const pinned =
        msg.pinned != null
          ? msg.pinned
            ? 1
            : 0
          : existing
            ? Number(/** @type {any} */ (existing).pinned) || 0
            : 0;
      const pinNote =
        msg.pinNote != null
          ? String(msg.pinNote)
          : existing
            ? String(/** @type {any} */ (existing).pin_note || "")
            : "";
      const pinOrder =
        msg.pinOrder != null
          ? Number(msg.pinOrder) || 0
          : existing
            ? Number(/** @type {any} */ (existing).pin_order) || 0
            : 0;

      db.prepare(
        `INSERT INTO telegram_live_messages (
          id, chat_id, chat_name, avatar_url, sender, text, message_id,
          at_iso, received_at_ms, pinned, pin_note, pin_order, updated_at_ms, image_urls
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          chat_id = excluded.chat_id,
          chat_name = excluded.chat_name,
          avatar_url = excluded.avatar_url,
          sender = excluded.sender,
          text = excluded.text,
          message_id = excluded.message_id,
          at_iso = excluded.at_iso,
          received_at_ms = excluded.received_at_ms,
          pinned = excluded.pinned,
          pin_note = excluded.pin_note,
          pin_order = excluded.pin_order,
          updated_at_ms = excluded.updated_at_ms,
          image_urls = excluded.image_urls`,
      ).run(
        id,
        String(msg.chatId || ""),
        String(msg.chatName || ""),
        String(msg.avatarUrl || ""),
        String(msg.sender || ""),
        String(msg.text || ""),
        Number(msg.messageId) || 0,
        String(msg.at || new Date().toISOString()),
        Number(msg.receivedAt) || now,
        pinned,
        pinNote,
        pinOrder,
        now,
        JSON.stringify(parseImageUrls(msg.imageUrls)),
      );
      return this.getById(id);
    },

    /** @param {string} id */
    getById(id) {
      const row = db.prepare(`SELECT * FROM telegram_live_messages WHERE id = ?`).get(String(id));
      return row ? mapRow(/** @type {any} */ (row)) : null;
    },

    /**
     * @param {{ chatId?: string, limit?: number, sinceMs?: number, pinnedOnly?: boolean }} [opts]
     */
    listMessages(opts = {}) {
      const limit = Math.min(2000, Math.max(1, Number(opts.limit) || 300));
      const chatId = String(opts.chatId || "").trim();
      const sinceMs = Number(opts.sinceMs) || 0;
      const pinnedOnly = Boolean(opts.pinnedOnly);
      /** @type {unknown[]} */
      const params = [];
      let sql = `SELECT * FROM telegram_live_messages WHERE 1=1`;
      if (chatId) {
        sql += ` AND (chat_id = ? OR chat_id = ?)`;
        params.push(chatId, String(Number(chatId)));
      }
      if (sinceMs > 0) {
        sql += ` AND received_at_ms >= ?`;
        params.push(sinceMs);
      }
      if (pinnedOnly) {
        sql += ` AND pinned = 1`;
      }
      sql += pinnedOnly
        ? ` ORDER BY pin_order DESC, updated_at_ms DESC LIMIT ?`
        : ` ORDER BY received_at_ms DESC LIMIT ?`;
      params.push(limit);
      const rows = db.prepare(sql).all(...params);
      return rows.map((r) => mapRow(/** @type {any} */ (r)));
    },

    listPinned(limit = 100) {
      return this.listMessages({ pinnedOnly: true, limit });
    },

    /**
     * @param {string} id
     * @param {{ pinned: boolean, pinNote?: string, pinOrder?: number }} patch
     */
    setPinned(id, patch) {
      const cur = this.getById(id);
      if (!cur) return null;
      const now = Date.now();
      const pinned = patch.pinned ? 1 : 0;
      const pinNote = patch.pinNote != null ? String(patch.pinNote) : cur.pinNote;
      const pinOrder =
        patch.pinOrder != null
          ? Number(patch.pinOrder) || 0
          : patch.pinned
            ? now
            : 0;
      db.prepare(
        `UPDATE telegram_live_messages
         SET pinned = ?, pin_note = ?, pin_order = ?, updated_at_ms = ?
         WHERE id = ?`,
      ).run(pinned, pinNote, pinOrder, now, String(id));
      return this.getById(id);
    },

    /**
     * 编辑置顶备注，以及可选覆盖展示正文（不改原始 sender/at）。
     * @param {string} id
     * @param {{ pinNote?: string, text?: string }} patch
     */
    updatePinned(id, patch) {
      const cur = this.getById(id);
      if (!cur) return null;
      if (!cur.pinned) return null;
      const now = Date.now();
      const pinNote = patch.pinNote != null ? String(patch.pinNote) : cur.pinNote;
      const text = patch.text != null ? String(patch.text) : cur.text;
      db.prepare(
        `UPDATE telegram_live_messages
         SET pin_note = ?, text = ?, updated_at_ms = ?
         WHERE id = ?`,
      ).run(pinNote, text, now, String(id));
      return this.getById(id);
    },

    /** @param {number} [keepMax] */
    prune(keepMax = 5000) {
      const n = Number(keepMax) || 5000;
      db.prepare(
        `DELETE FROM telegram_live_messages
         WHERE id NOT IN (
           SELECT id FROM telegram_live_messages
           ORDER BY
             CASE WHEN pinned = 1 THEN 1 ELSE 0 END DESC,
             received_at_ms DESC
           LIMIT ?
         )`,
      ).run(n);
    },

    clearUnpinned() {
      db.prepare(`DELETE FROM telegram_live_messages WHERE pinned = 0`).run();
    },

    count() {
      const row = db.prepare(`SELECT COUNT(*) AS c FROM telegram_live_messages`).get();
      return Number(/** @type {any} */ (row)?.c) || 0;
    },

    close() {
      try {
        db.close();
      } catch {
        /* ignore */
      }
    },
  };
}
