import { createHash } from "node:crypto";
import mysql from "mysql2/promise";

import { bufferToPlainPayloadText } from "./collect-ws-decode.js";
import { serializeRawJsonColumnForMysql } from "./mysql-json.js";

/**
 * @typedef {{ host: string; port: number; user: string; password: string; database: string }} MysqlConfig
 * @typedef {ReturnType<import("./logger.js").createLogger>} Logger
 */

/** @param {string} iso */
function isoToMysqlDatetime3(iso) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso.slice(0, 23).replace("T", " ");
  return d.toISOString().slice(0, 23).replace("T", " ");
}

/** @param {Buffer} buf */
export function hashBuffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}

/**
 * @param {MysqlConfig} cfg
 * @param {Logger} log
 */
export async function openStore(cfg, log) {
  log.info(`连接 MySQL ${cfg.host}:${cfg.port} 库=${cfg.database} …`);

  const pool = mysql.createPool({
    host: cfg.host,
    port: cfg.port,
    user: cfg.user,
    password: cfg.password,
    database: cfg.database,
    waitForConnections: true,
    connectionLimit: 10,
    enableKeepAlive: true,
    charset: "utf8mb4",
  });

  await pool.query(`
    CREATE TABLE IF NOT EXISTS frames (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      received_at DATETIME(3) NOT NULL,
      payload_hash CHAR(64) NOT NULL,
      opcode INT NULL,
      request_id VARCHAR(255) NULL,
      raw_payload LONGTEXT NULL,
      parsed_json JSON NULL,
      parse_error TEXT NULL,
      UNIQUE KEY uk_payload_hash (payload_hash),
      KEY idx_frames_received (received_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_messages (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      message_id VARCHAR(32) NOT NULL,
      guild_id VARCHAR(32) NOT NULL DEFAULT '',
      guild_name VARCHAR(256) NULL,
      channel_id VARCHAR(32) NOT NULL DEFAULT '',
      channel_name VARCHAR(256) NULL,
      author_id VARCHAR(32) NOT NULL DEFAULT '',
      created_at_ms BIGINT NOT NULL DEFAULT 0,
      content TEXT NULL,
      author_username VARCHAR(128) NULL,
      author_global_name VARCHAR(128) NULL,
      event_type VARCHAR(32) NOT NULL DEFAULT 'MESSAGE_CREATE',
      source VARCHAR(32) NOT NULL DEFAULT 'gateway_ws',
      raw_json JSON NULL,
      received_at DATETIME(3) NOT NULL,
      UNIQUE KEY uk_discord_message_id (message_id),
      KEY idx_discord_guild (guild_id),
      KEY idx_discord_channel_time (channel_id, created_at_ms),
      KEY idx_discord_received (received_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  for (const col of [
    "ADD COLUMN guild_name VARCHAR(256) NULL AFTER guild_id",
    "ADD COLUMN channel_name VARCHAR(256) NULL AFTER channel_id",
    "ADD COLUMN author_avatar VARCHAR(512) NULL AFTER author_global_name",
  ]) {
    try {
      await pool.query(`ALTER TABLE discord_messages ${col}`);
    } catch {
      /* 列已存在 */
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_guilds (
      guild_id VARCHAR(32) NOT NULL PRIMARY KEY,
      name VARCHAR(256) NOT NULL DEFAULT '',
      icon_hash VARCHAR(128) NULL,
      icon_url VARCHAR(512) NULL,
      updated_at DATETIME(3) NOT NULL,
      KEY idx_discord_guilds_updated (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_channels (
      channel_id VARCHAR(32) NOT NULL PRIMARY KEY,
      guild_id VARCHAR(32) NOT NULL DEFAULT '',
      name VARCHAR(256) NOT NULL DEFAULT '',
      channel_type INT NOT NULL DEFAULT 0,
      last_message_preview VARCHAR(512) NULL,
      last_message_at_ms BIGINT NULL,
      updated_at DATETIME(3) NOT NULL,
      KEY idx_discord_channels_guild (guild_id),
      KEY idx_discord_channels_updated (updated_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_signal_cards (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      message_id VARCHAR(64) NOT NULL,
      channel_id VARCHAR(32) NOT NULL,
      guild_id VARCHAR(32) NOT NULL DEFAULT '',
      source_text_hash CHAR(64) NOT NULL,
      raw_content TEXT NOT NULL,
      parsed_json JSON NULL,
      cards_by_style JSON NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'active',
      expires_at DATETIME(3) NULL,
      telegram_sent_at DATETIME(3) NULL,
      note TEXT NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uk_signal_message_id (message_id),
      KEY idx_signal_channel_status (channel_id, status, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  for (const col of [
    "ADD COLUMN note TEXT NULL AFTER telegram_sent_at",
    "ADD COLUMN execution_json JSON NULL AFTER note",
    "ADD COLUMN source VARCHAR(16) NOT NULL DEFAULT 'auto' AFTER execution_json",
  ]) {
    try {
      await pool.query(`ALTER TABLE discord_signal_cards ${col}`);
    } catch {
      /* 列已存在 */
    }
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_channel_text_cache (
      channel_id VARCHAR(32) NOT NULL PRIMARY KEY,
      recent_texts JSON NOT NULL,
      updated_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS discord_channel_message_dedup (
      channel_id VARCHAR(32) NOT NULL PRIMARY KEY,
      recent_keys JSON NOT NULL,
      updated_at DATETIME(3) NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  log.info("表 frames / discord_messages / discord_guilds / discord_channels / discord_signal_cards 就绪");

  const insertFrameSql = `
    INSERT IGNORE INTO frames (received_at, payload_hash, opcode, request_id, raw_payload, parsed_json, parse_error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  const insertMsgSql = `
    INSERT IGNORE INTO discord_messages (
      message_id, guild_id, guild_name, channel_id, channel_name, author_id, created_at_ms,
      content, author_username, author_global_name, author_avatar, event_type, source, raw_json, received_at
    ) VALUES ?
  `;

  /**
   * @param {{ receivedAt: string, payloadHash: string, opcode: number|null, requestId: string|null, rawPayload: Buffer, parsedJson: string|null, parseError: string|null }} row
   */
  async function insertFrame(row) {
    let parsedValue = null;
    if (row.parsedJson) {
      try {
        parsedValue = JSON.parse(row.parsedJson);
      } catch {
        parsedValue = row.parsedJson;
      }
    }
    const rawText =
      row.rawPayload instanceof Buffer
        ? bufferToPlainPayloadText(row.rawPayload)
        : row.rawPayload != null
          ? String(row.rawPayload)
          : null;
    const [result] = await pool.execute(insertFrameSql, [
      isoToMysqlDatetime3(row.receivedAt),
      row.payloadHash,
      row.opcode ?? null,
      row.requestId,
      rawText,
      parsedValue,
      row.parseError,
    ]);
    const affected = /** @type {import("mysql2").ResultSetHeader} */ (result).affectedRows ?? 0;
    return { inserted: affected > 0, duplicate: affected === 0 };
  }

  /**
   * @param {Array<{
   *   messageId: string;
   *   guildId?: string;
   *   guildName?: string | null;
   *   channelId?: string;
   *   channelName?: string | null;
   *   authorId?: string;
   *   createdAtMs?: number;
   *   content?: string;
   *   authorUsername?: string | null;
   *   authorGlobalName?: string | null;
   *   authorAvatar?: string | null;
   *   eventType?: string;
   *   source?: string;
   *   rawJson?: unknown;
   *   receivedAt?: string;
   * }>} rows
   */
  async function insertDiscordMessagesBatch(rows) {
    const valid = rows.filter((r) => r?.messageId);
    if (!valid.length) return { inserted: 0, duplicate: 0 };

    const now = isoToMysqlDatetime3(new Date().toISOString());
    /** @type {unknown[][]} */
    const tuples = valid.map((r) => [
      r.messageId,
      r.guildId ?? "",
      r.guildName ?? null,
      r.channelId ?? "",
      r.channelName ?? null,
      r.authorId ?? "",
      Number(r.createdAtMs) || 0,
      r.content ?? "",
      r.authorUsername ?? null,
      r.authorGlobalName ?? null,
      r.authorAvatar ?? null,
      r.eventType ?? "MESSAGE_CREATE",
      r.source ?? "gateway_ws",
      serializeRawJsonColumnForMysql(r.rawJson),
      isoToMysqlDatetime3(r.receivedAt ?? new Date().toISOString()) || now,
    ]);

    const [result] = await pool.query(insertMsgSql, [tuples]);
    const affected = /** @type {import("mysql2").ResultSetHeader} */ (result).affectedRows ?? 0;
    const inserted = Math.min(affected, valid.length);

    for (const r of valid) {
      if (!r.channelId) continue;
      const preview = String(r.content ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
      const atMs = Number(r.createdAtMs) || 0;
      await pool.execute(
        `INSERT INTO discord_channels (channel_id, guild_id, name, channel_type, last_message_preview, last_message_at_ms, updated_at)
         VALUES (?, ?, ?, 0, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           guild_id = IF(VALUES(guild_id) != '', VALUES(guild_id), guild_id),
           name = IF(VALUES(name) != '', VALUES(name), name),
           last_message_preview = IF(
             VALUES(last_message_at_ms) >= COALESCE(last_message_at_ms, 0),
             VALUES(last_message_preview),
             last_message_preview
           ),
           last_message_at_ms = GREATEST(COALESCE(last_message_at_ms, 0), VALUES(last_message_at_ms)),
           updated_at = VALUES(updated_at)`,
        [
          r.channelId,
          r.guildId ?? "",
          r.channelName ?? "",
          preview || null,
          atMs,
          isoToMysqlDatetime3(r.receivedAt ?? new Date().toISOString()),
        ]
      ).catch(() => {});
    }

    return { inserted, duplicate: valid.length - inserted };
  }

  /**
   * @param {Array<{ guildId: string, name: string, icon?: string | null, iconUrl?: string }>} rows
   */
  async function upsertDiscordGuildsBatch(rows) {
    const valid = rows.filter((r) => r?.guildId);
    if (!valid.length) return 0;
    const now = isoToMysqlDatetime3(new Date().toISOString());
    let n = 0;
    for (const r of valid) {
      await pool.execute(
        `INSERT INTO discord_guilds (guild_id, name, icon_hash, icon_url, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           name = IF(VALUES(name) != '', VALUES(name), name),
           icon_hash = COALESCE(VALUES(icon_hash), icon_hash),
           icon_url = COALESCE(VALUES(icon_url), icon_url),
           updated_at = VALUES(updated_at)`,
        [r.guildId, r.name ?? "", r.icon ?? null, r.iconUrl ?? null, now]
      );
      n += 1;
    }
    return n;
  }

  /**
   * @param {Array<{ channelId: string, guildId: string, name: string, type?: number }>} rows
   */
  async function upsertDiscordChannelsBatch(rows) {
    const valid = rows.filter((r) => r?.channelId);
    if (!valid.length) return 0;
    const now = isoToMysqlDatetime3(new Date().toISOString());
    let n = 0;
    for (const r of valid) {
      await pool.execute(
        `INSERT INTO discord_channels (channel_id, guild_id, name, channel_type, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           guild_id = IF(VALUES(guild_id) != '', VALUES(guild_id), guild_id),
           name = IF(VALUES(name) != '', VALUES(name), name),
           channel_type = VALUES(channel_type),
           updated_at = VALUES(updated_at)`,
        [r.channelId, r.guildId ?? "", r.name ?? "", Number(r.type) || 0, now]
      );
      n += 1;
    }
    return n;
  }

  /** 清理误把 channel_id 写入 discord_guilds 的历史脏数据 */
  async function purgeMisclassifiedGuilds() {
    const [r] = await pool.execute(`
      DELETE FROM discord_guilds
      WHERE guild_id IN (
        SELECT channel_id FROM (
          SELECT channel_id FROM discord_channels
        ) AS misclassified
      )
    `);
    return Number(r?.affectedRows ?? 0);
  }

  /** @param {string} channelId */
  async function getChannelMeta(channelId) {
    const cid = String(channelId ?? "").trim();
    if (!cid) return null;
    const [rows] = await pool.query(
      `SELECT channel_id, guild_id, name FROM discord_channels WHERE channel_id = ? LIMIT 1`,
      [cid]
    );
    if (rows[0]) return rows[0];
    const [msgRows] = await pool.query(
      `SELECT channel_id, guild_id, channel_name AS name
       FROM discord_messages
       WHERE channel_id = ? AND guild_id != ''
       ORDER BY created_at_ms DESC
       LIMIT 1`,
      [cid]
    );
    return msgRows[0] ?? null;
  }

  async function listDiscordGuilds() {
    const [rows] = await pool.query(`
      SELECT g.guild_id, g.name, g.icon_hash, g.icon_url, g.updated_at,
             (SELECT COUNT(*) FROM discord_channels c WHERE c.guild_id = g.guild_id) AS channel_count
      FROM discord_guilds g
      WHERE g.guild_id NOT IN (SELECT channel_id FROM discord_channels)
      ORDER BY g.name ASC
    `);
    return rows;
  }

  async function listDiscordChannelsByGuild(guildId) {
    const gid = String(guildId ?? "").trim();
    if (!gid) return [];
    const [rows] = await pool.query(
      `SELECT channel_id, guild_id, name, channel_type, last_message_preview, last_message_at_ms, updated_at
       FROM discord_channels WHERE guild_id = ? ORDER BY name ASC`,
      [gid]
    );
    if (rows.length) return rows;

    const [fromMsgs] = await pool.query(
      `SELECT channel_id, guild_id,
              SUBSTRING_INDEX(GROUP_CONCAT(channel_name ORDER BY created_at_ms DESC SEPARATOR '\\0'), '\\0', 1) AS name,
              0 AS channel_type,
              SUBSTRING_INDEX(GROUP_CONCAT(LEFT(content, 120) ORDER BY created_at_ms DESC SEPARATOR '\\0'), '\\0', 1) AS last_message_preview,
              MAX(created_at_ms) AS last_message_at_ms,
              MAX(received_at) AS updated_at
       FROM discord_messages
       WHERE guild_id = ?
       GROUP BY channel_id, guild_id
       ORDER BY name ASC`,
      [gid]
    );
    return fromMsgs;
  }

  async function listRecentMessages(limit = 120, filters = {}, { includeRaw = true } = {}) {
    const lim = Math.min(500, Math.max(1, limit));
    const ch = String(filters.channelId ?? "").trim();
    const gid = String(filters.guildId ?? "").trim();
    const orderAsc = String(filters.order ?? "").toLowerCase() === "asc";
    const orderSql = orderAsc ? "ASC" : "DESC";
    const rawCol = includeRaw ? ", raw_json" : "";

    /** @type {unknown[]} */
    const params = [];
    const where = [];
    if (ch) {
      where.push("channel_id = ?");
      params.push(ch);
    }
    if (gid) {
      where.push("guild_id = ?");
      params.push(gid);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const [rows] = await pool.query(
      `SELECT message_id, guild_id, guild_name, channel_id, channel_name, author_id, created_at_ms, content,
              author_username, author_global_name, author_avatar, event_type, source, received_at${rawCol}
       FROM discord_messages ${whereSql}
       ORDER BY created_at_ms ${orderSql}
       LIMIT ${lim}`,
      params
    );
    return rows;
  }

  async function listRecentFrames(limit = 120) {
    const lim = Math.min(500, Math.max(1, limit));
    const [rows] = await pool.query(
      `SELECT id, received_at, payload_hash, opcode, request_id, parsed_json, parse_error
       FROM frames ORDER BY id DESC LIMIT ${lim}`
    );
    return rows;
  }

  async function listChannelTextCaches() {
    const [rows] = await pool.query(
      `SELECT channel_id, recent_texts, updated_at FROM discord_channel_text_cache`
    );
    return rows;
  }

  /**
   * @param {string} channelId
   * @param {string[]} texts
   */
  async function upsertChannelTextCache(channelId, texts) {
    const cid = String(channelId ?? "").trim();
    if (!cid) return;
    const now = isoToMysqlDatetime3(new Date().toISOString());
    await pool.execute(
      `INSERT INTO discord_channel_text_cache (channel_id, recent_texts, updated_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE recent_texts = VALUES(recent_texts), updated_at = VALUES(updated_at)`,
      [cid, JSON.stringify(texts.slice(0, 5)), now]
    );
  }

  async function listChannelMessageDedupCaches() {
    const [rows] = await pool.query(
      `SELECT channel_id, recent_keys, updated_at FROM discord_channel_message_dedup`
    );
    return rows;
  }

  /**
   * @param {string} channelId
   * @param {string[]} keys
   */
  async function upsertChannelMessageDedupCache(channelId, keys) {
    const cid = String(channelId ?? "").trim();
    if (!cid) return;
    const now = isoToMysqlDatetime3(new Date().toISOString());
    await pool.execute(
      `INSERT INTO discord_channel_message_dedup (channel_id, recent_keys, updated_at)
       VALUES (?, ?, ?)
       ON DUPLICATE KEY UPDATE recent_keys = VALUES(recent_keys), updated_at = VALUES(updated_at)`,
      [cid, JSON.stringify(keys.slice(0, 3)), now]
    );
  }

  /**
   * @param {{
   *   messageId: string;
   *   channelId: string;
   *   guildId?: string;
   *   sourceTextHash: string;
   *   rawContent: string;
   *   parsedJson?: unknown;
   *   cardsByStyle: Record<string, string>;
   *   status?: string;
   *   expiresAt?: string | null;
   *   executionJson?: unknown;
   *   source?: string;
   *   note?: string | null;
   * }} row
   */
  async function insertSignalCard(row) {
    const now = isoToMysqlDatetime3(new Date().toISOString());
    const [result] = await pool.execute(
      `INSERT INTO discord_signal_cards (
         message_id, channel_id, guild_id, source_text_hash, raw_content,
         parsed_json, cards_by_style, status, expires_at, note, execution_json, source,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         source_text_hash = VALUES(source_text_hash),
         raw_content = VALUES(raw_content),
         parsed_json = VALUES(parsed_json),
         cards_by_style = VALUES(cards_by_style),
         note = COALESCE(VALUES(note), note),
         execution_json = COALESCE(VALUES(execution_json), execution_json),
         updated_at = VALUES(updated_at)`,
      [
        row.messageId,
        row.channelId,
        row.guildId ?? "",
        row.sourceTextHash,
        row.rawContent,
        serializeRawJsonColumnForMysql(row.parsedJson),
        JSON.stringify(row.cardsByStyle ?? {}),
        row.status ?? "active",
        row.expiresAt ? isoToMysqlDatetime3(row.expiresAt) : null,
        row.note ?? null,
        serializeRawJsonColumnForMysql(row.executionJson),
        row.source ?? "auto",
        now,
        now,
      ]
    );
    const header = /** @type {import("mysql2").ResultSetHeader} */ (result);
    const id = Number(header.insertId) || 0;
    if (id) {
      const [rows] = await pool.query(`SELECT * FROM discord_signal_cards WHERE id = ? LIMIT 1`, [id]);
      return rows[0] ?? { id, ...row };
    }
    const [rows] = await pool.query(
      `SELECT * FROM discord_signal_cards WHERE message_id = ? LIMIT 1`,
      [row.messageId]
    );
    return rows[0];
  }

  /** @param {number} id */
  async function markSignalCardTelegramSent(id) {
    const now = isoToMysqlDatetime3(new Date().toISOString());
    await pool.execute(`UPDATE discord_signal_cards SET telegram_sent_at = ?, updated_at = ? WHERE id = ?`, [
      now,
      now,
      id,
    ]);
  }

  /**
   * @param {{ channelId?: string, status?: string, limit?: number, fromMs?: number, toMs?: number }} [filters]
   */
  async function listSignalCards(filters = {}) {
    const lim = Math.min(500, Math.max(1, Number(filters.limit) || 50));
    const ch = String(filters.channelId ?? "").trim();
    const status = String(filters.status ?? "").trim();
    const fromMs = Number(filters.fromMs);
    const toMs = Number(filters.toMs);
    /** @type {unknown[]} */
    const params = [];
    const where = [];
    if (ch) {
      where.push("channel_id = ?");
      params.push(ch);
    }
    if (status) {
      where.push("status = ?");
      params.push(status);
    }
    if (Number.isFinite(fromMs) && fromMs > 0) {
      where.push("created_at >= ?");
      params.push(isoToMysqlDatetime3(new Date(fromMs).toISOString()));
    }
    if (Number.isFinite(toMs) && toMs > 0) {
      where.push("created_at <= ?");
      params.push(isoToMysqlDatetime3(new Date(toMs).toISOString()));
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await pool.query(
      `SELECT * FROM discord_signal_cards ${whereSql} ORDER BY id DESC LIMIT ${lim}`,
      params
    );
    return rows;
  }

  /**
   * @param {number} id
   * @param {{ status?: string, expiresAt?: string | null, cardsByStyle?: Record<string, string>, note?: string | null, executionJson?: unknown, parsedJson?: unknown }} patch
   */
  async function updateSignalCard(id, patch) {
    const now = isoToMysqlDatetime3(new Date().toISOString());
    /** @type {string[]} */
    const sets = ["updated_at = ?"];
    /** @type {unknown[]} */
    const params = [now];
    if (patch.status != null) {
      sets.push("status = ?");
      params.push(patch.status);
    }
    if (patch.expiresAt !== undefined) {
      sets.push("expires_at = ?");
      params.push(patch.expiresAt ? isoToMysqlDatetime3(patch.expiresAt) : null);
    }
    if (patch.cardsByStyle != null) {
      sets.push("cards_by_style = ?");
      params.push(JSON.stringify(patch.cardsByStyle));
    }
    if (patch.note !== undefined) {
      sets.push("note = ?");
      params.push(patch.note ? String(patch.note) : null);
    }
    if (patch.executionJson !== undefined) {
      sets.push("execution_json = ?");
      params.push(serializeRawJsonColumnForMysql(patch.executionJson));
    }
    if (patch.parsedJson !== undefined) {
      sets.push("parsed_json = ?");
      params.push(serializeRawJsonColumnForMysql(patch.parsedJson));
    }
    params.push(id);
    await pool.execute(`UPDATE discord_signal_cards SET ${sets.join(", ")} WHERE id = ?`, params);
    const [rows] = await pool.query(`SELECT * FROM discord_signal_cards WHERE id = ? LIMIT 1`, [id]);
    return rows[0] ?? null;
  }

  async function close() {
    await pool.end();
  }

  await purgeMisclassifiedGuilds().catch(() => {});

  return {
    insertFrame,
    insertDiscordMessagesBatch,
    upsertDiscordGuildsBatch,
    upsertDiscordChannelsBatch,
    purgeMisclassifiedGuilds,
    getChannelMeta,
    listDiscordGuilds,
    listDiscordChannelsByGuild,
    listRecentFrames,
    listRecentMessages,
    listChannelTextCaches,
    upsertChannelTextCache,
    listChannelMessageDedupCaches,
    upsertChannelMessageDedupCache,
    insertSignalCard,
    markSignalCardTelegramSent,
    listSignalCards,
    updateSignalCard,
    close,
  };
}
