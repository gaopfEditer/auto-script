/**
 * 合约自动下单审计（Bitget / WEEX）：每笔追加 JSONL（与卡片 parsed 互补）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const _dir = path.dirname(fileURLToPath(import.meta.url));

/** @returns {string} */
export function defaultBitgetAuditLogDir() {
  return path.join(_dir, "..", "data", "bitget-trade-audit");
}

/** @param {Date} [d] */
function dayFile(d = new Date()) {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return path.join(defaultBitgetAuditLogDir(), `${y}-${m}-${day}.jsonl`);
}

/**
 * @param {{
 *   cardId?: number;
 *   channelId?: string;
 *   channelName?: string;
 *   event: string;
 *   exchange?: "bitget" | "weex";
 *   dryRun?: boolean;
 *   executionTemplate?: string;
 *   orderSizeUsdt?: number;
 *   leverage?: number;
 *   symbol?: string;
 *   direction?: string;
 *   plan?: unknown;
 *   bitgetOrder?: unknown;
 *   error?: string;
 *   meta?: Record<string, unknown>;
 * }} row
 */
export function appendBitgetTradeAudit(row) {
  const dir = defaultBitgetAuditLogDir();
  try {
    fs.mkdirSync(dir, { recursive: true });
  } catch {
  }
  const line = {
    at: new Date().toISOString(),
    exchange: row.exchange ?? "bitget",
    ...row,
  };
  try {
    fs.appendFileSync(dayFile(), `${JSON.stringify(line)}\n`, "utf8");
  } catch {
    /* best-effort */
  }
  return line;
}