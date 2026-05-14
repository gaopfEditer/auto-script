import { createHash } from "node:crypto";
import mysql from "mysql2/promise";

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
      raw_payload LONGBLOB NULL,
      parsed_json JSON NULL,
      parse_error TEXT NULL,
      UNIQUE KEY uk_payload_hash (payload_hash),
      KEY idx_frames_received (received_at)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
  log.info("表 frames 就绪（若不存在则已创建）");

  const insertSql = `
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
    const [result] = await pool.execute(insertSql, [
      isoToMysqlDatetime3(row.receivedAt),
      row.payloadHash,
      row.opcode ?? null,
      row.requestId,
      row.rawPayload,
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
    getReplayRows,
    listRecentFrames,
    close,
  };
}

export function hashBuffer(buf) {
  return createHash("sha256").update(buf).digest("hex");
}
