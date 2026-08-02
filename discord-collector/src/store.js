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

/** @param {unknown} raw */
export function extractSignalCardRowId(raw) {
  if (raw == null) return 0;
  const n = typeof raw === "bigint" ? Number(raw) : Number(raw);
  return Number.isFinite(n) && n > 0 ? Math.trunc(n) : 0;
}

/** @param {Record<string, unknown>} row */
function normalizeSignalCardRow(row) {
  if (!row) return row;
  const id = extractSignalCardRowId(row.id ?? row.ID);
  return id ? { ...row, id } : row;
}

const SIGNAL_CARD_JOIN = `
  LEFT JOIN discord_channels dc ON dc.channel_id = sc.channel_id
  LEFT JOIN discord_messages dm ON dm.message_id = sc.message_id`;

const SIGNAL_CARD_SELECT = `sc.*, dc.name AS channel_name, dm.created_at_ms AS message_created_at_ms`;

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
    "ADD COLUMN source_type VARCHAR(32) NOT NULL DEFAULT 'discord' AFTER source",
    "ADD COLUMN source_ref VARCHAR(128) NULL AFTER source_type",
    "ADD COLUMN symbol VARCHAR(32) NULL AFTER source_ref",
    "ADD COLUMN card_fields_json JSON NULL AFTER cards_by_style",
    "ADD COLUMN verify_3h_json JSON NULL AFTER card_fields_json",
    "ADD COLUMN verify_1m_json JSON NULL AFTER verify_3h_json",
    "ADD COLUMN proximity_json JSON NULL AFTER verify_1m_json",
    "ADD COLUMN signal_at DATETIME(3) NULL AFTER proximity_json",
    "ADD COLUMN verify_mode VARCHAR(8) NOT NULL DEFAULT '3h' AFTER signal_at",
    "ADD COLUMN asset_class VARCHAR(16) NOT NULL DEFAULT 'crypto' AFTER verify_mode",
    "ADD COLUMN backtest_json JSON NULL AFTER asset_class",
  ]) {
    try {
      await pool.query(`ALTER TABLE discord_signal_cards ${col}`);
    } catch {
      /* 列已存在 */
    }
  }

  for (const idx of [
    "ADD KEY idx_signal_symbol_time (symbol, created_at)",
    "ADD KEY idx_signal_source_time (source_type, created_at)",
  ]) {
    try {
      await pool.query(`ALTER TABLE discord_signal_cards ${idx}`);
    } catch {
      /* 索引已存在 */
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

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_members (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      token CHAR(48) NOT NULL,
      handle VARCHAR(32) NOT NULL,
      display_name VARCHAR(64) NOT NULL,
      avatar_url VARCHAR(512) NOT NULL DEFAULT '',
      bio VARCHAR(255) NOT NULL DEFAULT '',
      points INT NOT NULL DEFAULT 0,
      tip_balance INT NOT NULL DEFAULT 0,
      checkin_streak INT NOT NULL DEFAULT 0,
      last_checkin_day CHAR(10) NULL,
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uk_community_token (token),
      UNIQUE KEY uk_community_handle (handle),
      KEY idx_community_points (points DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_posts (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      member_id BIGINT NOT NULL,
      content TEXT NOT NULL,
      like_count INT NOT NULL DEFAULT 0,
      comment_count INT NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL,
      KEY idx_community_posts_time (id DESC),
      KEY idx_community_posts_member (member_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_comments (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      post_id BIGINT NOT NULL,
      member_id BIGINT NOT NULL,
      content TEXT NOT NULL,
      created_at DATETIME(3) NOT NULL,
      KEY idx_community_comments_post (post_id, id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_likes (
      post_id BIGINT NOT NULL,
      member_id BIGINT NOT NULL,
      created_at DATETIME(3) NOT NULL,
      PRIMARY KEY (post_id, member_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_checkins (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      member_id BIGINT NOT NULL,
      day CHAR(10) NOT NULL,
      points_earned INT NOT NULL DEFAULT 0,
      streak INT NOT NULL DEFAULT 1,
      created_at DATETIME(3) NOT NULL,
      UNIQUE KEY uk_community_checkin (member_id, day),
      KEY idx_community_checkin_day (day)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS community_tips (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      from_member_id BIGINT NOT NULL,
      to_member_id BIGINT NOT NULL,
      amount INT NOT NULL,
      message VARCHAR(255) NOT NULL DEFAULT '',
      zone VARCHAR(32) NOT NULL DEFAULT 'plaza',
      created_at DATETIME(3) NOT NULL,
      KEY idx_community_tips_time (id DESC)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  log.info(
    "表 frames / discord_* / community_* 就绪"
  );

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
    if (!valid.length) return { inserted: 0, duplicate: 0, insertedRows: [] };

    const ids = valid.map((r) => String(r.messageId));
    /** @type {Set<string>} */
    let existing = new Set();
    if (ids.length) {
      const [existingRows] = await pool.query(
        `SELECT message_id FROM discord_messages WHERE message_id IN (?)`,
        [ids]
      );
      existing = new Set(existingRows.map((r) => String(r.message_id)));
    }
    const insertedRows = valid.filter((r) => !existing.has(String(r.messageId)));

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

    await pool.query(insertMsgSql, [tuples]);

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

    return {
      inserted: insertedRows.length,
      duplicate: valid.length - insertedRows.length,
      insertedRows,
    };
  }

  /**
   * @param {string[]} messageIds
   * @returns {Promise<Set<string>>}
   */
  async function findExistingDiscordMessageIds(messageIds) {
    const ids = messageIds.map((id) => String(id ?? "").trim()).filter(Boolean);
    if (!ids.length) return new Set();
    const [rows] = await pool.query(
      `SELECT message_id FROM discord_messages WHERE message_id IN (?)`,
      [ids]
    );
    return new Set(rows.map((r) => String(r.message_id)));
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
    const [primary] = await pool.query(`
      SELECT g.guild_id, g.name, g.icon_hash, g.icon_url, g.updated_at,
             (SELECT COUNT(*) FROM discord_channels c WHERE c.guild_id = g.guild_id) AS channel_count
      FROM discord_guilds g
      WHERE g.guild_id NOT IN (SELECT channel_id FROM discord_channels)
    `);
    const seen = new Set(primary.map((r) => String(r.guild_id)));
    const [inferred] = await pool.query(`
      SELECT ig.guild_id,
             COALESCE(NULLIF(g.name, ''), NULLIF(ig.guild_name, ''), CONCAT('Server ', RIGHT(ig.guild_id, 6))) AS name,
             g.icon_hash,
             g.icon_url,
             COALESCE(g.updated_at, NOW(3)) AS updated_at,
             (SELECT COUNT(*) FROM discord_channels c WHERE c.guild_id = ig.guild_id) AS channel_count
      FROM (
        SELECT guild_id, NULL AS guild_name FROM discord_channels WHERE guild_id != ''
        UNION
        SELECT guild_id,
          SUBSTRING_INDEX(GROUP_CONCAT(guild_name ORDER BY created_at_ms DESC SEPARATOR '\\\\0'), '\\\\0', 1) AS guild_name
        FROM discord_messages WHERE guild_id != '' GROUP BY guild_id
      ) AS ig
      LEFT JOIN discord_guilds g ON g.guild_id = ig.guild_id
      WHERE ig.guild_id NOT IN (SELECT channel_id FROM discord_channels)
    `);
    /** @type {typeof primary} */
    const merged = [...primary];
    for (const row of inferred) {
      const gid = String(row.guild_id ?? "");
      if (!gid || seen.has(gid)) continue;
      merged.push(row);
      seen.add(gid);
    }
    merged.sort((a, b) => String(a.name ?? "").localeCompare(String(b.name ?? ""), "zh-CN"));
    return merged;
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
   *   sourceType?: string;
   *   sourceRef?: string | null;
   *   symbol?: string | null;
   *   cardFieldsJson?: unknown;
   *   signalAt?: string | null;
   *   verifyMode?: string;
   *   assetClass?: string;
   * }} row
   */
  async function insertSignalCard(row) {
    const now = isoToMysqlDatetime3(new Date().toISOString());
    const messageId = String(row.messageId ?? "").trim();
    if (!messageId) throw new Error("insertSignalCard: messageId 为空");
    const [result] = await pool.execute(
      `INSERT INTO discord_signal_cards (
         message_id, channel_id, guild_id, source_text_hash, raw_content,
         parsed_json, cards_by_style, card_fields_json, status, expires_at, note, execution_json, source,
         source_type, source_ref, symbol, signal_at, verify_mode, asset_class,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         channel_id = VALUES(channel_id),
         source_text_hash = VALUES(source_text_hash),
         raw_content = VALUES(raw_content),
         parsed_json = VALUES(parsed_json),
         cards_by_style = VALUES(cards_by_style),
         card_fields_json = COALESCE(VALUES(card_fields_json), card_fields_json),
         note = COALESCE(VALUES(note), note),
         execution_json = COALESCE(VALUES(execution_json), execution_json),
         source_type = COALESCE(VALUES(source_type), source_type),
         source_ref = COALESCE(VALUES(source_ref), source_ref),
         symbol = COALESCE(VALUES(symbol), symbol),
         signal_at = COALESCE(VALUES(signal_at), signal_at),
         verify_mode = COALESCE(VALUES(verify_mode), verify_mode),
         asset_class = COALESCE(VALUES(asset_class), asset_class),
         updated_at = VALUES(updated_at)`,
      [
        messageId,
        row.channelId,
        row.guildId ?? "",
        row.sourceTextHash,
        row.rawContent,
        serializeRawJsonColumnForMysql(row.parsedJson),
        JSON.stringify(row.cardsByStyle ?? {}),
        serializeRawJsonColumnForMysql(row.cardFieldsJson),
        row.status ?? "active",
        row.expiresAt ? isoToMysqlDatetime3(row.expiresAt) : null,
        row.note ?? null,
        serializeRawJsonColumnForMysql(row.executionJson),
        row.source ?? "auto",
        row.sourceType ?? "discord",
        row.sourceRef ?? null,
        row.symbol ? String(row.symbol).toUpperCase() : null,
        row.signalAt ? isoToMysqlDatetime3(row.signalAt) : now,
        row.verifyMode ?? "3h",
        row.assetClass ?? "crypto",
        now,
        now,
      ]
    );
    const header = /** @type {import("mysql2").ResultSetHeader} */ (result);
    const insertId = extractSignalCardRowId(header.insertId);
    if (insertId) {
      const [rows] = await pool.query(`SELECT * FROM discord_signal_cards WHERE id = ? LIMIT 1`, [insertId]);
      if (rows[0]) return normalizeSignalCardRow(rows[0]);
    }
    const [rows] = await pool.query(
      `SELECT * FROM discord_signal_cards WHERE message_id = ? LIMIT 1`,
      [messageId]
    );
    if (rows[0]) return normalizeSignalCardRow(rows[0]);
    if (row.channelId && row.sourceTextHash) {
      const [byHash] = await pool.query(
        `SELECT * FROM discord_signal_cards WHERE channel_id = ? AND source_text_hash = ? ORDER BY id DESC LIMIT 1`,
        [row.channelId, row.sourceTextHash]
      );
      if (byHash[0]) return normalizeSignalCardRow(byHash[0]);
    }
    throw new Error(`insertSignalCard: 写入后未找到记录 message_id=${messageId}`);
  }

  /** @param {string} targetChannelId */
  async function migrateCoinActionPasteCards(targetChannelId) {
    const ch = String(targetChannelId ?? "").trim();
    if (!ch) return 0;
    const now = isoToMysqlDatetime3(new Date().toISOString());
    const [result] = await pool.execute(
      `UPDATE discord_signal_cards
       SET channel_id = ?, updated_at = ?
       WHERE message_id LIKE 'yt-paste-%'
         AND channel_id != ?`,
      [ch, now, ch]
    );
    return Number(/** @type {import("mysql2").ResultSetHeader} */ (result).affectedRows) || 0;
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
   * @param {{ channelId?: string, status?: string, fromMs?: number, toMs?: number, sourceType?: string, symbol?: string, includeChannelId?: boolean }} filters
   * @returns {{ where: string[], params: unknown[] }}
   */
  function buildSignalCardFilters(filters) {
    const ch = String(filters.channelId ?? "").trim();
    const status = String(filters.status ?? "").trim();
    const sourceType = String(filters.sourceType ?? "").trim();
    const symbol = String(filters.symbol ?? "").trim().toUpperCase();
    const fromMs = Number(filters.fromMs);
    const toMs = Number(filters.toMs);
    const includeChannelId = filters.includeChannelId !== false;
    /** @type {unknown[]} */
    const params = [];
    const where = [];
    if (includeChannelId && ch) {
      where.push("sc.channel_id = ?");
      params.push(ch);
    }
    if (status) {
      where.push("sc.status = ?");
      params.push(status);
    }
    if (sourceType) {
      where.push("sc.source_type = ?");
      params.push(sourceType);
    }
    if (symbol) {
      const sym = symbol.endsWith("USDT") ? symbol : `${symbol}USDT`;
      where.push("(sc.symbol = ? OR sc.symbol = ? OR sc.symbol LIKE ?)");
      params.push(sym, symbol.replace(/USDT$/, ""), `${symbol.replace(/USDT$/, "")}%`);
    }
    if (Number.isFinite(fromMs) && fromMs > 0) {
      where.push("sc.created_at >= ?");
      params.push(isoToMysqlDatetime3(new Date(fromMs).toISOString()));
    }
    if (Number.isFinite(toMs) && toMs > 0) {
      where.push("sc.created_at <= ?");
      params.push(isoToMysqlDatetime3(new Date(toMs).toISOString()));
    }
    return { where, params };
  }

  async function getRecentSignalCardBySymbolChannel({ symbol, channelId, withinMs = 600_000 }) {
    const sym = String(symbol ?? "").trim().toUpperCase();
    const ch = String(channelId ?? "").trim();
    if (!sym || !ch) return null;
    const ms = Number(withinMs);
    const fromMs = Number.isFinite(ms) && ms > 0 ? Date.now() - ms : Date.now() - 600_000;
    const { where, params } = buildSignalCardFilters({
      channelId: ch,
      symbol: sym,
      fromMs,
    });
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await pool.query(
      `SELECT ${SIGNAL_CARD_SELECT}
       FROM discord_signal_cards sc
       ${SIGNAL_CARD_JOIN}
       ${whereSql} ORDER BY sc.id DESC LIMIT 1`,
      params
    );
    return rows[0] ? normalizeSignalCardRow(rows[0]) : null;
  }

  /** @param {{ channelId: string, withinMs?: number }} opts */
  async function getRecentSignalCardByChannel({ channelId, withinMs = 1_800_000 }) {
    const ch = String(channelId ?? "").trim();
    if (!ch) return null;
    const ms = Number(withinMs);
    const fromMs = Number.isFinite(ms) && ms > 0 ? Date.now() - ms : Date.now() - 1_800_000;
    const { where, params } = buildSignalCardFilters({ channelId: ch, fromMs });
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await pool.query(
      `SELECT ${SIGNAL_CARD_SELECT}
       FROM discord_signal_cards sc
       ${SIGNAL_CARD_JOIN}
       ${whereSql} ORDER BY sc.id DESC LIMIT 1`,
      params
    );
    return rows[0] ? normalizeSignalCardRow(rows[0]) : null;
  }

  /**
   * @param {{ channelId?: string, status?: string, limit?: number, fromMs?: number, toMs?: number, sourceType?: string, symbol?: string }} [filters]
   */
  async function listSignalCards(filters = {}) {
    const lim = Math.min(500, Math.max(1, Number(filters.limit) || 50));
    const { where, params } = buildSignalCardFilters(filters);
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await pool.query(
      `SELECT ${SIGNAL_CARD_SELECT}
       FROM discord_signal_cards sc
       ${SIGNAL_CARD_JOIN}
       ${whereSql}
       ORDER BY COALESCE(sc.signal_at, sc.created_at) DESC, sc.id DESC
       LIMIT ${lim}`,
      params
    );
    return rows;
  }

  /**
   * 归档页频道筛选项（按卡片数量降序）。
   * @param {{ status?: string, fromMs?: number, toMs?: number, sourceType?: string, symbol?: string }} [filters]
   */
  async function listSignalCardChannels(filters = {}) {
    const { where, params } = buildSignalCardFilters({ ...filters, includeChannelId: false });
    where.push("sc.channel_id != ''");
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";
    const [rows] = await pool.query(
      `SELECT sc.channel_id, COUNT(*) AS cnt, MAX(dc.name) AS channel_name
       FROM discord_signal_cards sc
       LEFT JOIN discord_channels dc ON dc.channel_id = sc.channel_id
       ${whereSql}
       GROUP BY sc.channel_id
       ORDER BY cnt DESC, sc.channel_id ASC`,
      params
    );
    return rows;
  }

  /** @param {number} id */
  async function getSignalCardById(id) {
    const [rows] = await pool.query(
      `SELECT ${SIGNAL_CARD_SELECT}
       FROM discord_signal_cards sc
       ${SIGNAL_CARD_JOIN}
       WHERE sc.id = ?
       LIMIT 1`,
      [id]
    );
    return normalizeSignalCardRow(rows[0] ?? null);
  }

  /** @param {string} messageId */
  async function getSignalCardByMessageId(messageId) {
    const mid = String(messageId ?? "").trim();
    if (!mid) return null;
    const [rows] = await pool.query(
      `SELECT ${SIGNAL_CARD_SELECT}
       FROM discord_signal_cards sc
       ${SIGNAL_CARD_JOIN}
       WHERE sc.message_id = ? LIMIT 1`,
      [mid]
    );
    return normalizeSignalCardRow(rows[0] ?? null);
  }

  /**
   * 待价格校验的卡片（每张仅一种周期：默认 3h 加密 / 30d 股票）。
   * @param {{ limit?: number }} [opts]
   */
  async function listCardsForBacktest(opts = {}) {
    const lim = Math.min(200, Math.max(1, Number(opts.limit) || 80));
    const [rows] = await pool.query(
      `SELECT ${SIGNAL_CARD_SELECT}
       FROM discord_signal_cards sc
       ${SIGNAL_CARD_JOIN}
       WHERE sc.status = 'active'
         AND sc.symbol IS NOT NULL AND sc.symbol != ''
         AND sc.backtest_json IS NULL
         AND (sc.asset_class = 'crypto' OR sc.asset_class IS NULL OR sc.asset_class = '')
         AND (
           (
             UPPER(REPLACE(REPLACE(REPLACE(sc.symbol, 'USDT', ''), 'USDC', ''), 'BUSD', '')) IN ('BTC', 'ETH')
             AND COALESCE(sc.signal_at, sc.created_at) <= DATE_SUB(?, INTERVAL 8 HOUR)
           )
           OR (
             UPPER(REPLACE(REPLACE(REPLACE(sc.symbol, 'USDT', ''), 'USDC', ''), 'BUSD', '')) NOT IN ('BTC', 'ETH')
             AND COALESCE(sc.signal_at, sc.created_at) <= DATE_SUB(?, INTERVAL 3 HOUR)
           )
         )
       ORDER BY sc.id ASC
       LIMIT ${lim}`,
      [isoToMysqlDatetime3(new Date().toISOString()), isoToMysqlDatetime3(new Date().toISOString())]
    );
    return rows;
  }

  async function listCardsForVerification(opts = {}) {
    const lim = Math.min(200, Math.max(1, Number(opts.limit) || 80));
    const hours = Number(process.env.CARD_VERIFY_DEFAULT_HOURS ?? 3) || 3;
    const cryptoDays = Number(process.env.CARD_VERIFY_CRYPTO_WINDOW_DAYS ?? 1) || 1;
    const stockDays = Number(process.env.CARD_VERIFY_STOCK_WINDOW_DAYS ?? 30) || 30;
    const now = isoToMysqlDatetime3(new Date().toISOString());
    const [rows] = await pool.query(
      `SELECT ${SIGNAL_CARD_SELECT}
       FROM discord_signal_cards sc
       ${SIGNAL_CARD_JOIN}
       WHERE sc.status = 'active'
         AND sc.symbol IS NOT NULL AND sc.symbol != ''
         AND (
           (
             sc.verify_mode = '3h'
             AND sc.verify_3h_json IS NULL
             AND COALESCE(sc.signal_at, sc.created_at) <= DATE_SUB(?, INTERVAL ${hours} HOUR)
           )
           OR (
             (sc.verify_mode = '1d' OR sc.verify_mode IS NULL OR sc.verify_mode = '')
             AND sc.verify_3h_json IS NULL
             AND COALESCE(sc.signal_at, sc.created_at) <= DATE_SUB(?, INTERVAL ${cryptoDays} DAY)
           )
           OR (
             sc.verify_mode = '30d'
             AND sc.verify_1m_json IS NULL
             AND COALESCE(sc.signal_at, sc.created_at) <= DATE_SUB(?, INTERVAL ${stockDays} DAY)
           )
         )
       ORDER BY sc.id ASC
       LIMIT ${lim}`,
      [now, now, now]
    );
    return rows;
  }

  /**
   * 有效且未完结的卡片（接近价位监控）。
   * @param {{ limit?: number }} [opts]
   */
  async function listActiveCardsForProximity(opts = {}) {
    const lim = Math.min(500, Math.max(1, Number(opts.limit) || 200));
    const [rows] = await pool.query(
      `SELECT ${SIGNAL_CARD_SELECT}
       FROM discord_signal_cards sc
       ${SIGNAL_CARD_JOIN}
       WHERE sc.status = 'active'
         AND sc.symbol IS NOT NULL AND sc.symbol != ''
         AND (
           sc.execution_json IS NULL
           OR JSON_UNQUOTE(JSON_EXTRACT(sc.execution_json, '$.outcome')) IS NULL
           OR JSON_UNQUOTE(JSON_EXTRACT(sc.execution_json, '$.outcome')) = 'pending'
         )
       ORDER BY sc.id DESC
       LIMIT ${lim}`
    );
    return rows;
  }

  /**
   * @param {number} id
   * @param {{ status?: string, expiresAt?: string | null, cardsByStyle?: Record<string, string>, note?: string | null, channelId?: string, executionJson?: unknown, parsedJson?: unknown, verify3hJson?: unknown, verify1mJson?: unknown, proximityJson?: unknown, cardFieldsJson?: unknown, backtestJson?: unknown }} patch
   */
  async function updateSignalCard(id, patch) {
    const now = isoToMysqlDatetime3(new Date().toISOString());
    /** @type {string[]} */
    const sets = ["updated_at = ?"];
    /** @type {unknown[]} */
    const params = [now];
    if (patch.channelId != null) {
      sets.push("channel_id = ?");
      params.push(String(patch.channelId).trim());
    }
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
    if (patch.rawContent != null) {
      sets.push("raw_content = ?");
      params.push(String(patch.rawContent));
    }
    if (patch.symbol != null) {
      sets.push("symbol = ?");
      params.push(String(patch.symbol).trim() || null);
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
    if (patch.verify3hJson !== undefined) {
      sets.push("verify_3h_json = ?");
      params.push(serializeRawJsonColumnForMysql(patch.verify3hJson));
    }
    if (patch.verify1mJson !== undefined) {
      sets.push("verify_1m_json = ?");
      params.push(serializeRawJsonColumnForMysql(patch.verify1mJson));
    }
    if (patch.proximityJson !== undefined) {
      sets.push("proximity_json = ?");
      params.push(serializeRawJsonColumnForMysql(patch.proximityJson));
    }
    if (patch.cardFieldsJson !== undefined) {
      sets.push("card_fields_json = ?");
      params.push(serializeRawJsonColumnForMysql(patch.cardFieldsJson));
    }
    if (patch.backtestJson !== undefined) {
      sets.push("backtest_json = ?");
      params.push(serializeRawJsonColumnForMysql(patch.backtestJson));
    }
    params.push(id);
    await pool.execute(`UPDATE discord_signal_cards SET ${sets.join(", ")} WHERE id = ?`, params);
    const [rows] = await pool.query(`SELECT * FROM discord_signal_cards WHERE id = ? LIMIT 1`, [id]);
    return rows[0] ?? null;
  }

  // —— 社区 ——
  async function communityEnsureSchema() {
    /* 表已在 openStore 创建；保留钩子供 service 调用 */
  }

  async function communityGetMemberByToken(token) {
    const [rows] = await pool.query(`SELECT * FROM community_members WHERE token = ? LIMIT 1`, [
      String(token),
    ]);
    return rows[0] ?? null;
  }

  async function communityGetMemberByHandle(handle) {
    const [rows] = await pool.query(`SELECT * FROM community_members WHERE handle = ? LIMIT 1`, [
      String(handle).toLowerCase(),
    ]);
    return rows[0] ?? null;
  }

  async function communityGetMemberById(id) {
    const [rows] = await pool.query(`SELECT * FROM community_members WHERE id = ? LIMIT 1`, [id]);
    return rows[0] ?? null;
  }

  async function communityInsertMember(p) {
    const now = isoToMysqlDatetime3(new Date().toISOString());
    const [r] = await pool.execute(
      `INSERT INTO community_members (
        token, handle, display_name, avatar_url, bio, points, tip_balance,
        checkin_streak, last_checkin_day, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, ?)`,
      [
        p.token,
        p.handle,
        p.displayName,
        p.avatarUrl || "",
        p.bio || "",
        Number(p.points) || 0,
        Number(p.tipBalance) || 0,
        now,
        now,
      ]
    );
    return communityGetMemberById(/** @type {{ insertId: number }} */ (r).insertId);
  }

  async function communityUpdateMember(id, patch) {
    /** @type {string[]} */
    const sets = ["updated_at = ?"];
    /** @type {unknown[]} */
    const params = [isoToMysqlDatetime3(new Date().toISOString())];
    if (patch.displayName != null && String(patch.displayName).trim()) {
      sets.push("display_name = ?");
      params.push(String(patch.displayName).trim());
    }
    if (patch.avatarUrl != null) {
      sets.push("avatar_url = ?");
      params.push(String(patch.avatarUrl));
    }
    if (patch.bio != null) {
      sets.push("bio = ?");
      params.push(String(patch.bio));
    }
    params.push(id);
    await pool.execute(`UPDATE community_members SET ${sets.join(", ")} WHERE id = ?`, params);
    return communityGetMemberById(id);
  }

  async function communityAddPoints(id, delta, extra = {}) {
    const now = isoToMysqlDatetime3(new Date().toISOString());
    /** @type {string[]} */
    const sets = ["points = points + ?", "updated_at = ?"];
    /** @type {unknown[]} */
    const params = [Number(delta) || 0, now];
    if (extra.checkinStreak != null) {
      sets.push("checkin_streak = ?");
      params.push(Number(extra.checkinStreak) || 0);
    }
    if (extra.lastCheckinDay != null) {
      sets.push("last_checkin_day = ?");
      params.push(String(extra.lastCheckinDay));
    }
    params.push(id);
    await pool.execute(`UPDATE community_members SET ${sets.join(", ")} WHERE id = ?`, params);
    return communityGetMemberById(id);
  }

  async function communityListMembersByPoints(limit = 20) {
    const [rows] = await pool.query(
      `SELECT * FROM community_members ORDER BY points DESC, id ASC LIMIT ?`,
      [limit]
    );
    return rows;
  }

  async function communityInsertCheckin(p) {
    const now = isoToMysqlDatetime3(new Date().toISOString());
    await pool.execute(
      `INSERT INTO community_checkins (member_id, day, points_earned, streak, created_at)
       VALUES (?, ?, ?, ?, ?)`,
      [p.memberId, p.day, p.pointsEarned, p.streak, now]
    );
  }

  async function communityListCheckins(memberId, limit = 30) {
    const [rows] = await pool.query(
      `SELECT * FROM community_checkins WHERE member_id = ? ORDER BY day DESC LIMIT ?`,
      [memberId, limit]
    );
    return rows;
  }

  async function communityInsertPost(p) {
    const now = isoToMysqlDatetime3(new Date().toISOString());
    const [r] = await pool.execute(
      `INSERT INTO community_posts (member_id, content, like_count, comment_count, created_at)
       VALUES (?, ?, 0, 0, ?)`,
      [p.memberId, p.content, now]
    );
    return { id: /** @type {{ insertId: number }} */ (r).insertId };
  }

  async function communityGetPost(id) {
    const [rows] = await pool.query(`SELECT * FROM community_posts WHERE id = ? LIMIT 1`, [id]);
    return rows[0] ?? null;
  }

  async function communityListPosts(opts = {}) {
    const lim = Math.min(50, Math.max(1, Number(opts.limit) || 30));
    if (opts.beforeId) {
      const [rows] = await pool.query(
        `SELECT * FROM community_posts WHERE id < ? ORDER BY id DESC LIMIT ?`,
        [opts.beforeId, lim]
      );
      return rows;
    }
    const [rows] = await pool.query(`SELECT * FROM community_posts ORDER BY id DESC LIMIT ?`, [lim]);
    return rows;
  }

  async function communityInsertComment(p) {
    const now = isoToMysqlDatetime3(new Date().toISOString());
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `INSERT INTO community_comments (post_id, member_id, content, created_at) VALUES (?, ?, ?, ?)`,
        [p.postId, p.memberId, p.content, now]
      );
      await conn.execute(
        `UPDATE community_posts SET comment_count = comment_count + 1 WHERE id = ?`,
        [p.postId]
      );
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async function communityListComments(postId, limit = 50) {
    const [rows] = await pool.query(
      `SELECT * FROM community_comments WHERE post_id = ? ORDER BY id ASC LIMIT ?`,
      [postId, limit]
    );
    return rows;
  }

  async function communityHasLiked(postId, memberId) {
    const [rows] = await pool.query(
      `SELECT 1 FROM community_likes WHERE post_id = ? AND member_id = ? LIMIT 1`,
      [postId, memberId]
    );
    return rows.length > 0;
  }

  async function communityAddLike(postId, memberId) {
    const now = isoToMysqlDatetime3(new Date().toISOString());
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      await conn.execute(
        `INSERT IGNORE INTO community_likes (post_id, member_id, created_at) VALUES (?, ?, ?)`,
        [postId, memberId, now]
      );
      await conn.execute(`UPDATE community_posts SET like_count = like_count + 1 WHERE id = ?`, [
        postId,
      ]);
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async function communityRemoveLike(postId, memberId) {
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [r] = await conn.execute(
        `DELETE FROM community_likes WHERE post_id = ? AND member_id = ?`,
        [postId, memberId]
      );
      if (/** @type {{ affectedRows: number }} */ (r).affectedRows > 0) {
        await conn.execute(
          `UPDATE community_posts SET like_count = GREATEST(0, like_count - 1) WHERE id = ?`,
          [postId]
        );
      }
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async function communityTransferTip(p) {
    const now = isoToMysqlDatetime3(new Date().toISOString());
    const conn = await pool.getConnection();
    try {
      await conn.beginTransaction();
      const [fromRows] = await conn.query(
        `SELECT tip_balance FROM community_members WHERE id = ? FOR UPDATE`,
        [p.fromId]
      );
      const bal = Number(fromRows[0]?.tip_balance) || 0;
      if (bal < p.amount) {
        const err = new Error("打赏币不足");
        err.code = "INSUFFICIENT";
        throw err;
      }
      await conn.execute(
        `UPDATE community_members SET tip_balance = tip_balance - ?, updated_at = ? WHERE id = ?`,
        [p.amount, now, p.fromId]
      );
      await conn.execute(
        `UPDATE community_members SET tip_balance = tip_balance + ?, updated_at = ? WHERE id = ?`,
        [p.amount, now, p.toId]
      );
      await conn.execute(
        `INSERT INTO community_tips (from_member_id, to_member_id, amount, message, zone, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [p.fromId, p.toId, p.amount, p.message || "", p.zone || "plaza", now]
      );
      await conn.commit();
    } catch (e) {
      await conn.rollback();
      throw e;
    } finally {
      conn.release();
    }
  }

  async function communityListTips(limit = 40) {
    const [rows] = await pool.query(
      `SELECT * FROM community_tips ORDER BY id DESC LIMIT ?`,
      [Math.min(100, Math.max(1, limit))]
    );
    return rows;
  }

  async function communityLatestTip(fromId, toId) {
    const [rows] = await pool.query(
      `SELECT * FROM community_tips WHERE from_member_id = ? AND to_member_id = ?
       ORDER BY id DESC LIMIT 1`,
      [fromId, toId]
    );
    return rows[0] ?? null;
  }

  async function close() {
    await pool.end();
  }

  await purgeMisclassifiedGuilds().catch(() => {});

  return {
    offline: false,
    insertFrame,
    insertDiscordMessagesBatch,
    findExistingDiscordMessageIds,
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
    migrateCoinActionPasteCards,
    markSignalCardTelegramSent,
    listSignalCards,
    getRecentSignalCardBySymbolChannel,
    getRecentSignalCardByChannel,
    listSignalCardChannels,
    getSignalCardById,
    getSignalCardByMessageId,
    listCardsForVerification,
    listCardsForBacktest,
    listActiveCardsForProximity,
    updateSignalCard,
    communityEnsureSchema,
    communityGetMemberByToken,
    communityGetMemberByHandle,
    communityGetMemberById,
    communityInsertMember,
    communityUpdateMember,
    communityAddPoints,
    communityListMembersByPoints,
    communityInsertCheckin,
    communityListCheckins,
    communityInsertPost,
    communityGetPost,
    communityListPosts,
    communityInsertComment,
    communityListComments,
    communityHasLiked,
    communityAddLike,
    communityRemoveLike,
    communityTransferTip,
    communityListTips,
    communityLatestTip,
    close,
  };
}

/**
 * @param {MysqlConfig} cfg
 * @param {Error} err
 */
export function formatMysqlUnavailableHint(cfg, err) {
  const code = /** @type {NodeJS.ErrnoException} */ (err).code ?? "";
  const addr = `${cfg.host}:${cfg.port}`;
  return [
    `MySQL 不可用（${code || err.message}）— ${addr} 库=${cfg.database}`,
    "collect:ui 将以「无数据库」模式继续运行：",
    "  · 可用：静态 UI、/archives、/debug、WebSocket 实时推送",
    "  · 不可用：消息/帧入库、Show 历史、信号卡片持久化、社区",
    "请启动 MySQL，或检查 .env 中 MYSQL_HOST / MYSQL_PORT / MYSQL_DATABASE",
  ].join("\n");
}

/** @returns {ReturnType<typeof openStore> extends Promise<infer S> ? S : never} */
export function createOfflineStore() {
  return {
    offline: true,
    insertFrame: async () => {},
    insertDiscordMessagesBatch: async () => ({ inserted: 0, duplicate: 0, insertedRows: [] }),
    findExistingDiscordMessageIds: async () => new Set(),
    upsertDiscordGuildsBatch: async () => 0,
    upsertDiscordChannelsBatch: async () => 0,
    purgeMisclassifiedGuilds: async () => {},
    getChannelMeta: async () => null,
    listDiscordGuilds: async () => [],
    listDiscordChannelsByGuild: async () => [],
    listRecentFrames: async () => [],
    listRecentMessages: async () => [],
    listChannelTextCaches: async () => [],
    upsertChannelTextCache: async () => {},
    listChannelMessageDedupCaches: async () => [],
    upsertChannelMessageDedupCache: async () => {},
    insertSignalCard: async () => null,
    migrateCoinActionPasteCards: async () => 0,
    markSignalCardTelegramSent: async () => {},
    listSignalCards: async () => [],
    getRecentSignalCardBySymbolChannel: async () => null,
    getRecentSignalCardByChannel: async () => null,
    listSignalCardChannels: async () => [],
    getSignalCardById: async () => null,
    getSignalCardByMessageId: async () => null,
    listCardsForVerification: async () => [],
    listCardsForBacktest: async () => [],
    listActiveCardsForProximity: async () => [],
    updateSignalCard: async () => null,
    communityEnsureSchema: async () => {},
    communityGetMemberByToken: async () => null,
    communityGetMemberByHandle: async () => null,
    communityGetMemberById: async () => null,
    communityInsertMember: async () => null,
    communityUpdateMember: async () => null,
    communityAddPoints: async () => null,
    communityListMembersByPoints: async () => [],
    communityInsertCheckin: async () => {},
    communityListCheckins: async () => [],
    communityInsertPost: async () => ({ id: 0 }),
    communityGetPost: async () => null,
    communityListPosts: async () => [],
    communityInsertComment: async () => {},
    communityListComments: async () => [],
    communityHasLiked: async () => false,
    communityAddLike: async () => {},
    communityRemoveLike: async () => {},
    communityTransferTip: async () => {},
    communityListTips: async () => [],
    communityLatestTip: async () => null,
    close: async () => {},
  };
}

/**
 * collect:ui 用：MySQL 失败时不抛错，返回离线 store。
 * @param {MysqlConfig} cfg
 * @param {Logger} log
 */
export async function tryOpenStore(cfg, log) {
  try {
    const store = await openStore(cfg, log);
    return { store, offline: false, error: null, hint: null };
  } catch (e) {
    const err = /** @type {Error} */ (e);
    const hint = formatMysqlUnavailableHint(cfg, err);
    for (const line of hint.split("\n")) log.error(line);
    return { store: createOfflineStore(), offline: true, error: err.message, hint };
  }
}
