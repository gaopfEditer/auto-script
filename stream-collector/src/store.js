import { createHash } from "node:crypto";
import mysql from "mysql2/promise";

import { bufferToPlainPayloadText } from "./collect-ws-decode.js";

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
      raw_payload LONGTEXT NULL COMMENT 'WS 帧体明文（JSON 或 hex/utf8）',
      parsed_json JSON NULL,
      parse_error TEXT NULL,
      UNIQUE KEY uk_payload_hash (payload_hash),
      KEY idx_frames_received (received_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  log.info("表 frames 就绪（若不存在则已创建）");

  try {
    await pool.query(`
      ALTER TABLE frames
      MODIFY COLUMN raw_payload LONGTEXT NULL
      COMMENT 'WS 帧体明文（JSON 或 hex/utf8）'
    `);
    log.info("frames.raw_payload 已确认为 LONGTEXT 明文存储");
  } catch (e) {
    log.warn(`frames.raw_payload 列迁移: ${/** @type {Error} */ (e).message}`);
  }

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kook_messages (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      message_id VARCHAR(128) NOT NULL COMMENT 'Kook 消息 id（全局唯一）',
      guild_id VARCHAR(32) NOT NULL DEFAULT '' COMMENT '服务器/群组 id',
      channel_id VARCHAR(32) NOT NULL DEFAULT '' COMMENT '频道 id',
      author_id VARCHAR(32) NOT NULL DEFAULT '' COMMENT '发送者用户 id',
      create_at_ms BIGINT NOT NULL DEFAULT 0 COMMENT 'Kook create_at（毫秒时间戳）',
      content TEXT NULL COMMENT '正文',
      msg_type INT NULL COMMENT 'Kook 消息 type',
      author_username VARCHAR(128) NULL,
      author_nickname VARCHAR(128) NULL,
      source VARCHAR(32) NOT NULL DEFAULT 'rest' COMMENT 'rest|ws_desktop|frontend 等',
      raw_json JSON NULL COMMENT '原始片段（可选）',
      received_at DATETIME(3) NOT NULL COMMENT '本系统首次入库时间',
      UNIQUE KEY uk_kook_message_id (message_id),
      KEY idx_kook_guild (guild_id),
      KEY idx_kook_channel_time (channel_id, create_at_ms),
      KEY idx_kook_author (author_id),
      KEY idx_kook_received (received_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  log.info("表 kook_messages 就绪（若不存在则已创建）");

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kook_signal_marks (
      message_id VARCHAR(128) NOT NULL PRIMARY KEY COMMENT '关联 kook_messages.message_id',
      guild_id VARCHAR(32) NOT NULL DEFAULT '',
      channel_id VARCHAR(32) NOT NULL DEFAULT '',
      note TEXT NULL COMMENT '标记备注',
      marked_at DATETIME(3) NOT NULL,
      KEY idx_signal_mark_guild_time (guild_id, marked_at),
      KEY idx_signal_mark_channel (channel_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);

  await pool.query(`
    CREATE TABLE IF NOT EXISTS kook_signal_reviews (
      message_id VARCHAR(128) NOT NULL PRIMARY KEY COMMENT '关联 kook_messages.message_id',
      guild_id VARCHAR(32) NOT NULL DEFAULT '',
      channel_id VARCHAR(32) NOT NULL DEFAULT '',
      hit_take_profit TINYINT NULL COMMENT '1=止盈 0=未止盈 NULL=未评',
      hit_stop_loss TINYINT NULL COMMENT '1=止损 0=未止损 NULL=未评',
      entry_type VARCHAR(32) NULL COMMENT 'precise|near_miss|near_stop_loss|bad_entry_no_sl|none',
      entry_offset DECIMAL(20,8) NULL COMMENT '差一点入场时的插值/偏差',
      review_note TEXT NULL,
      reviewed_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      KEY idx_signal_review_guild_time (guild_id, reviewed_at),
      KEY idx_signal_review_channel (channel_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  log.info("表 kook_signal_marks / kook_signal_reviews 就绪");

  try {
    await pool.query(`
      ALTER TABLE kook_signal_reviews
      MODIFY COLUMN entry_type VARCHAR(32) NULL
      COMMENT 'precise|near_miss|near_stop_loss|bad_entry_no_sl|none'
    `);
  } catch (e) {
    log.warn(`kook_signal_reviews.entry_type 列迁移: ${/** @type {Error} */ (e).message}`);
  }

  const insertKookSql = `
    INSERT IGNORE INTO kook_messages (
      message_id, guild_id, channel_id, author_id, create_at_ms,
      content, msg_type, author_username, author_nickname, source, raw_json, received_at
    ) VALUES ?
  `;
  const insertFrameSql = `
    INSERT IGNORE INTO frames (received_at, payload_hash, opcode, request_id, raw_payload, parsed_json, parse_error)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `;

  /**
   * @param {{ receivedAt: string, payloadHash: string, opcode: number|null, requestId: string|null, rawPayload: Buffer, parsedJson: string|null, parseError: string|null }} row
   * @returns {Promise<{ inserted: boolean, duplicate: boolean }>}
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
    const inserted = affected > 0;
    const duplicate = affected === 0;
    log.debug(
      `${inserted ? "INSERT" : "IGNORE"} hash=${row.payloadHash.slice(0, 10)}… opcode=${row.opcode} bytes=${row.rawPayload?.length ?? 0} parseOk=${Boolean(row.parsedJson)}`
    );
    return { inserted, duplicate };
  }

  /**
   * 批量写入 Kook 频道消息；`message_id` 唯一，重复则 IGNORE。
   * @param {Array<{
   *   messageId: string;
   *   guildId?: string;
   *   channelId?: string;
   *   authorId?: string;
   *   createAtMs?: number;
   *   content?: string;
   *   msgType?: number | null;
   *   authorUsername?: string | null;
   *   authorNickname?: string | null;
   *   source?: string;
   *   rawJson?: unknown;
   *   receivedAt?: string;
   * }>} rows
   * @returns {Promise<{ inserted: number, duplicate: number }>}
   */
  async function insertKookMessagesBatch(rows) {
    const valid = rows.filter((r) => r?.messageId);
    if (!valid.length) return { inserted: 0, duplicate: 0 };

    /** @type {unknown[][]} */
    const tuples = valid.map((r) => {
      let rawVal = null;
      if (r.rawJson != null) {
        if (typeof r.rawJson === "string") {
          try {
            rawVal = JSON.parse(r.rawJson);
          } catch {
            rawVal = r.rawJson;
          }
        } else {
          rawVal = r.rawJson;
        }
      }
      return [
        r.messageId,
        r.guildId ?? "",
        r.channelId ?? "",
        r.authorId ?? "",
        Number(r.createAtMs) || 0,
        r.content ?? "",
        r.msgType ?? null,
        r.authorUsername ?? null,
        r.authorNickname ?? null,
        r.source ?? "rest",
        rawVal,
        isoToMysqlDatetime3(r.receivedAt ?? new Date().toISOString()),
      ];
    });

    const [result] = await pool.query(insertKookSql, [tuples]);
    const affected = /** @type {import("mysql2").ResultSetHeader} */ (result).affectedRows ?? 0;
    const inserted = affected;
    const duplicate = Math.max(0, valid.length - inserted);
    log.debug(
      `kook_messages batch size=${valid.length} inserted=${inserted} duplicate=${duplicate}`
    );
    return { inserted, duplicate };
  }

  /**
   * 按频道读取已入库消息（时间正序）。
   * @param {string} channelId
   * @param {number} [limit]
   */
  async function listKookChannelMessages(channelId, limit = 200) {
    const cid = String(channelId ?? "").trim();
    const n = Math.min(1000, Math.max(1, Number(limit) || 200));
    if (!cid) return [];
    const [rows] = await pool.query(
      `SELECT message_id, guild_id, channel_id, author_id, create_at_ms,
              content, msg_type, author_username, author_nickname, source,
              CAST(raw_json AS CHAR) AS raw_json, received_at
       FROM kook_messages
       WHERE channel_id = ?
       ORDER BY create_at_ms ASC, id ASC
       LIMIT ?`,
      [cid, n]
    );
    return /** @type {Record<string, unknown>[]} */ (rows);
  }

  /**
   * @param {{ messageId: string, guildId: string, channelId?: string, note?: string | null }} row
   */
  async function upsertSignalMark(row) {
    const messageId = String(row.messageId ?? "").trim();
    if (!messageId) throw new Error("messageId 为空");
    const now = isoToMysqlDatetime3(new Date().toISOString());
    await pool.execute(
      `INSERT INTO kook_signal_marks (message_id, guild_id, channel_id, note, marked_at)
       VALUES (?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         guild_id = VALUES(guild_id),
         channel_id = VALUES(channel_id),
         note = VALUES(note),
         marked_at = VALUES(marked_at)`,
      [messageId, row.guildId ?? "", row.channelId ?? "", row.note ?? null, now]
    );
  }

  /** @param {string} messageId */
  async function deleteSignalMark(messageId) {
    const id = String(messageId ?? "").trim();
    if (!id) return;
    await pool.execute(`DELETE FROM kook_signal_marks WHERE message_id = ?`, [id]);
    await pool.execute(`DELETE FROM kook_signal_reviews WHERE message_id = ?`, [id]);
  }

  /**
   * @param {{
   *   messageId: string;
   *   guildId: string;
   *   channelId?: string;
   *   hitTakeProfit?: number | null;
   *   hitStopLoss?: number | null;
   *   entryType?: string | null;
   *   entryOffset?: number | null;
   *   reviewNote?: string | null;
   * }} row
   */
  async function upsertSignalReview(row) {
    const messageId = String(row.messageId ?? "").trim();
    if (!messageId) throw new Error("messageId 为空");
    const now = isoToMysqlDatetime3(new Date().toISOString());
    await pool.execute(
      `INSERT INTO kook_signal_reviews (
         message_id, guild_id, channel_id,
         hit_take_profit, hit_stop_loss, entry_type, entry_offset,
         review_note, reviewed_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON DUPLICATE KEY UPDATE
         guild_id = VALUES(guild_id),
         channel_id = VALUES(channel_id),
         hit_take_profit = VALUES(hit_take_profit),
         hit_stop_loss = VALUES(hit_stop_loss),
         entry_type = VALUES(entry_type),
         entry_offset = VALUES(entry_offset),
         review_note = VALUES(review_note),
         updated_at = VALUES(updated_at)`,
      [
        messageId,
        row.guildId ?? "",
        row.channelId ?? "",
        row.hitTakeProfit ?? null,
        row.hitStopLoss ?? null,
        row.entryType ?? null,
        row.entryOffset ?? null,
        row.reviewNote ?? null,
        now,
        now,
      ]
    );
    const rows = await getSignalsWithReviewsByMessageIds([messageId]);
    return rows[0] ?? null;
  }

  /** @param {string[]} messageIds */
  async function getSignalsWithReviewsByMessageIds(messageIds) {
    const ids = messageIds.map((s) => String(s).trim()).filter(Boolean);
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(",");
    const [rows] = await pool.query(
      `SELECT
         m.message_id, m.guild_id, m.channel_id, m.note AS mark_note, m.marked_at,
         r.hit_take_profit, r.hit_stop_loss, r.entry_type, r.entry_offset,
         r.review_note, r.reviewed_at, r.updated_at AS review_updated_at,
         km.content, km.author_id, km.create_at_ms
       FROM kook_signal_marks m
       LEFT JOIN kook_signal_reviews r ON r.message_id = m.message_id
       LEFT JOIN kook_messages km ON km.message_id = m.message_id
       WHERE m.message_id IN (${placeholders})`,
      ids
    );
    return /** @type {Record<string, unknown>[]} */ (rows);
  }

  /**
   * @param {{ guildId: string, channelId?: string, fromMs?: number, toMs?: number }} q
   */
  async function listSignalsWithReviews(q) {
    const guildId = String(q.guildId ?? "").trim();
    if (!guildId) return [];
    /** @type {unknown[]} */
    const params = [guildId];
    let sql = `
      SELECT
        m.message_id, m.guild_id, m.channel_id, m.note AS mark_note, m.marked_at,
        r.hit_take_profit, r.hit_stop_loss, r.entry_type, r.entry_offset,
        r.review_note, r.reviewed_at, r.updated_at AS review_updated_at,
        km.content, km.author_id, km.create_at_ms
      FROM kook_signal_marks m
      LEFT JOIN kook_signal_reviews r ON r.message_id = m.message_id
      LEFT JOIN kook_messages km ON km.message_id = m.message_id
      WHERE m.guild_id = ?`;
    if (q.channelId) {
      sql += ` AND m.channel_id = ?`;
      params.push(q.channelId);
    }
    if (q.fromMs != null && Number.isFinite(q.fromMs)) {
      sql += ` AND COALESCE(km.create_at_ms, UNIX_TIMESTAMP(m.marked_at) * 1000) >= ?`;
      params.push(q.fromMs);
    }
    if (q.toMs != null && Number.isFinite(q.toMs)) {
      sql += ` AND COALESCE(km.create_at_ms, UNIX_TIMESTAMP(m.marked_at) * 1000) <= ?`;
      params.push(q.toMs);
    }
    sql += ` ORDER BY COALESCE(km.create_at_ms, 0) ASC, m.marked_at ASC`;
    const [rows] = await pool.query(sql, params);
    return /** @type {Record<string, unknown>[]} */ (rows);
  }

  /** @returns {Record<string, unknown>} */
  function emptySignalSummary() {
    return {
      totalSignals: 0,
      reviewedCount: 0,
      takeProfitHit: 0,
      takeProfitMiss: 0,
      stopLossHit: 0,
      stopLossMiss: 0,
      entryPrecise: 0,
      entryNearMiss: 0,
      entryNearStopLoss: 0,
      entryBadEntryNoSl: 0,
      entryNone: 0,
      entryNearMissAvgOffset: null,
      takeProfitRate: null,
      stopLossRate: null,
      entryPreciseRate: null,
    };
  }

  /** @param {Record<string, unknown>} s @param {string} [guildId] @param {string} [channelId] */
  function rowToSignalSummary(s, guildId = "", channelId = "") {
    const total = Number(s.total_signals) || 0;
    const reviewed = Number(s.reviewed_count) || 0;
    const tpHit = Number(s.tp_hit) || 0;
    const tpMiss = Number(s.tp_miss) || 0;
    const slHit = Number(s.sl_hit) || 0;
    const slMiss = Number(s.sl_miss) || 0;
    const entryPrecise = Number(s.entry_precise) || 0;
    const entryNearMiss = Number(s.entry_near_miss) || 0;
    const entryNearStopLoss = Number(s.entry_near_stop_loss) || 0;
    const entryBadEntryNoSl = Number(s.entry_bad_entry_no_sl) || 0;
    const entryNone = Number(s.entry_none) || 0;
    const tpDenom = tpHit + tpMiss;
    const slDenom = slHit + slMiss;
    const entryDenom = entryPrecise + entryNearMiss + entryNearStopLoss + entryBadEntryNoSl + entryNone;

    return {
      guildId: guildId || String(s.guild_id ?? ""),
      channelId: channelId || String(s.channel_id ?? ""),
      totalSignals: total,
      reviewedCount: reviewed,
      takeProfitHit: tpHit,
      takeProfitMiss: tpMiss,
      stopLossHit: slHit,
      stopLossMiss: slMiss,
      entryPrecise,
      entryNearMiss,
      entryNearStopLoss,
      entryBadEntryNoSl,
      entryNone,
      entryNearMissAvgOffset: s.entry_offset_avg != null ? Number(s.entry_offset_avg) : null,
      takeProfitRate: tpDenom > 0 ? tpHit / tpDenom : null,
      stopLossRate: slDenom > 0 ? slHit / slDenom : null,
      entryPreciseRate: entryDenom > 0 ? entryPrecise / entryDenom : null,
    };
  }

  /**
   * 按群组（guild_id）分别汇总，不合并。
   * @param {{ guildId?: string, fromMs?: number, toMs?: number }} q
   */
  async function listSignalSummariesByGuild(q) {
    /** @type {unknown[]} */
    const params = [];
    let timeJoin = "";
    if (q.fromMs != null || q.toMs != null) {
      timeJoin = ` LEFT JOIN kook_messages km ON km.message_id = m.message_id `;
    }
    let where = ` WHERE m.guild_id != '' `;
    const filterGuild = String(q.guildId ?? "").trim();
    if (filterGuild) {
      where += ` AND m.guild_id = ? `;
      params.push(filterGuild);
    }
    if (q.fromMs != null && Number.isFinite(q.fromMs)) {
      where += ` AND COALESCE(km.create_at_ms, UNIX_TIMESTAMP(m.marked_at) * 1000) >= ? `;
      params.push(q.fromMs);
    }
    if (q.toMs != null && Number.isFinite(q.toMs)) {
      where += ` AND COALESCE(km.create_at_ms, UNIX_TIMESTAMP(m.marked_at) * 1000) <= ? `;
      params.push(q.toMs);
    }

    const [rows] = await pool.query(
      `SELECT
         m.guild_id,
         COUNT(*) AS total_signals,
         SUM(CASE WHEN r.message_id IS NOT NULL THEN 1 ELSE 0 END) AS reviewed_count,
         SUM(CASE WHEN r.hit_take_profit = 1 THEN 1 ELSE 0 END) AS tp_hit,
         SUM(CASE WHEN r.hit_take_profit = 0 THEN 1 ELSE 0 END) AS tp_miss,
         SUM(CASE WHEN r.hit_stop_loss = 1 THEN 1 ELSE 0 END) AS sl_hit,
         SUM(CASE WHEN r.hit_stop_loss = 0 THEN 1 ELSE 0 END) AS sl_miss,
         SUM(CASE WHEN r.entry_type = 'precise' THEN 1 ELSE 0 END) AS entry_precise,
         SUM(CASE WHEN r.entry_type = 'near_miss' THEN 1 ELSE 0 END) AS entry_near_miss,
         SUM(CASE WHEN r.entry_type = 'near_stop_loss' THEN 1 ELSE 0 END) AS entry_near_stop_loss,
         SUM(CASE WHEN r.entry_type = 'bad_entry_no_sl' THEN 1 ELSE 0 END) AS entry_bad_entry_no_sl,
         SUM(CASE WHEN r.entry_type = 'none' THEN 1 ELSE 0 END) AS entry_none,
         AVG(CASE WHEN r.entry_type = 'near_miss' THEN r.entry_offset ELSE NULL END) AS entry_offset_avg
       FROM kook_signal_marks m
       LEFT JOIN kook_signal_reviews r ON r.message_id = m.message_id
       ${timeJoin}
       ${where}
       GROUP BY m.guild_id
       ORDER BY m.guild_id ASC`,
      params
    );
    return (/** @type {Record<string, unknown>[]} */ (rows)).map((row) =>
      rowToSignalSummary(row, String(row.guild_id ?? ""))
    );
  }

  /**
   * @param {{ guildId: string, fromMs?: number, toMs?: number }} q
   */
  async function getGuildSignalSummary(q) {
    const guildId = String(q.guildId ?? "").trim();
    if (!guildId) return emptySignalSummary();
    const list = await listSignalSummariesByGuild(q);
    return list[0] ?? { ...emptySignalSummary(), guildId };
  }

  async function getReplayRows() {
    const [rows] = await pool.query(
      `SELECT id, received_at, CAST(parsed_json AS CHAR) AS parsed_json
       FROM frames
       WHERE parsed_json IS NOT NULL
       ORDER BY id ASC`
    );
    log.debug(`查询回放行数: ${/** @type {unknown[]} */ (rows).length}`);
    return /** @type {{ id: number, received_at: Date|string, parsed_json: string }[]} */ (rows);
  }

  /**
   * 最近入库的帧（Show 页初始加载 / 轮询）。
   * @param {number} [limit]
   */
  async function listRecentFrames(limit = 100) {
    const n = Math.min(500, Math.max(1, Number(limit) || 100));
    const [rows] = await pool.query(
      `SELECT id, received_at, opcode, request_id,
              CAST(parsed_json AS CHAR) AS parsed_json,
              parse_error,
              LENGTH(raw_payload) AS raw_len
       FROM frames
       ORDER BY id DESC
       LIMIT ?`,
      [n]
    );
    return /** @type {{ id: number, received_at: Date|string, opcode: number|null, request_id: string|null, parsed_json: string|null, parse_error: string|null, raw_len: number }[]} */ (
      rows
    );
  }

  async function close() {
    await pool.end();
    log.info("MySQL 连接池已关闭");
  }

  return {
    insertFrame,
    insertKookMessagesBatch,
    listKookChannelMessages,
    upsertSignalMark,
    deleteSignalMark,
    upsertSignalReview,
    getSignalsWithReviewsByMessageIds,
    listSignalsWithReviews,
    getGuildSignalSummary,
    listSignalSummariesByGuild,
    getReplayRows,
    listRecentFrames,
    close,
  };
}

export function hashBuffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
