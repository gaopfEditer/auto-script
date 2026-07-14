/**
 * 本地 Bitget 下单历史（手动 + 自动记录）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const _dir = path.dirname(fileURLToPath(import.meta.url));
const HISTORY_FILE = path.join(_dir, "..", "data", "bitget-order-history.json");
const MAX_ROWS = 500;

/** @returns {Array<Record<string, unknown>>} */
function readAll() {
  if (!fs.existsSync(HISTORY_FILE)) return [];
  try {
    const raw = JSON.parse(fs.readFileSync(HISTORY_FILE, "utf8"));
    return Array.isArray(raw) ? raw : Array.isArray(raw?.orders) ? raw.orders : [];
  } catch {
    return [];
  }
}

/** @param {Array<Record<string, unknown>>} rows */
function writeAll(rows) {
  fs.mkdirSync(path.dirname(HISTORY_FILE), { recursive: true });
  fs.writeFileSync(HISTORY_FILE, JSON.stringify(rows.slice(0, MAX_ROWS), null, 2), "utf8");
}

/** @param {Record<string, unknown>} row */
export function appendBitgetOrderHistory(row) {
  const rows = readAll();
  rows.unshift({
    id: `local-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    at: new Date().toISOString(),
    ...row,
  });
  writeAll(rows);
  return rows[0];
}

/** @param {{ limit?: number; symbol?: string }} [opts] */
export function listBitgetOrderHistory(opts = {}) {
  const limit = Math.min(200, Math.max(1, Number(opts.limit ?? 100)));
  const sym = String(opts.symbol ?? "")
    .trim()
    .toUpperCase();
  let rows = readAll();
  if (sym) {
    rows = rows.filter((r) => {
      const s = String(r.symbol ?? "").toUpperCase();
      return s.includes(sym) || s.replace(/USDT$/, "") === sym.replace(/USDT$/, "");
    });
  }
  return rows.slice(0, limit);
}

export function bitgetHistoryFilePath() {
  return HISTORY_FILE;
}
