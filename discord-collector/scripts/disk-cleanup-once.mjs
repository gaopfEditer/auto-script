#!/usr/bin/env node
/**
 * 一次性释放 discord-collector 相关磁盘（frames + binlog + 本地日志）。
 * 用法：node scripts/disk-cleanup-once.mjs
 */
import { truncate } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import mysql from "mysql2/promise";

const __dir = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dir, "..");
dotenv.config({ path: resolve(ROOT, ".env") });

const oiLog = resolve(ROOT, "oi_mornitor/data/oi-supervisor.log");

async function main() {
  console.log("[cleanup] 清空 oi-supervisor.log …");
  await truncate(oiLog, 0).catch(() => {});

  const conn = await mysql.createConnection({
    host: process.env.MYSQL_HOST || "127.0.0.1",
    port: Number(process.env.MYSQL_PORT || 3306),
    user: process.env.MYSQL_USER || "root",
    password: process.env.MYSQL_PASSWORD || "",
    database: process.env.MYSQL_DATABASE || "discord_collector",
  });

  const [[before]] = await conn.query("SELECT COUNT(*) AS cnt FROM frames");
  console.log(`[cleanup] frames 当前行数: ${before.cnt}`);

  console.log("[cleanup] TRUNCATE frames …");
  await conn.query("TRUNCATE TABLE frames");

  const [logs] = await conn.query("SHOW BINARY LOGS");
  console.log(`[cleanup] binlog 文件数: ${logs.length}`);
  if (logs.length > 1) {
    const keep = logs[logs.length - 1].Log_name;
    console.log(`[cleanup] PURGE BINARY LOGS TO '${keep}' …`);
    await conn.query("PURGE BINARY LOGS TO ?", [keep]);
  }

  try {
    await conn.query("SET GLOBAL binlog_expire_logs_seconds = 259200");
    console.log("[cleanup] binlog 保留期设为 3 天");
  } catch (e) {
    console.warn("[cleanup] 无法设置 binlog_expire_logs_seconds:", e.message);
  }

  await conn.end();
  console.log("[cleanup] 完成。请确认 .env 中 COLLECTOR_FRAME_PERSIST=0 并重启 collect:ui。");
}

main().catch((e) => {
  console.error("[cleanup] 失败:", e.message);
  process.exit(1);
});
