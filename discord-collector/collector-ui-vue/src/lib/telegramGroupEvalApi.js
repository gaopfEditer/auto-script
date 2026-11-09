import { readJsonResponse } from "./httpJson.js";

/** @typedef {{
 *   cardCount: number,
 *   winCount: number,
 *   lossCount: number,
 *   pendingCount: number,
 *   winRate: number|null,
 *   totalPnlPct: number,
 *   decidedCount: number,
 * }} TgWindowMetrics */

/** @typedef {{
 *   chatId: string,
 *   name: string,
 *   month: TgWindowMetrics,
 *   week: TgWindowMetrics,
 *   lastWeek: TgWindowMetrics,
 * }} TgGroupEvalRow */

/**
 * @param {Response} res
 * @param {string} fallback
 */
async function readJson(res, fallback) {
  return readJsonResponse(res, fallback);
}

/** @returns {Promise<{ note: string, windows: Record<string, { key: string, label: string, fromMs: number, toMs: number }>, groups: TgGroupEvalRow[] }>} */
export async function fetchTelegramGroupEval() {
  const res = await fetch("/api/telegram/live/group-eval");
  const j = await readJson(res, "加载群组盈利率失败");
  if (!j || typeof j !== "object" || !j.ok) {
    throw new Error((j && j.error) || "加载群组盈利率失败");
  }
  return {
    note: typeof j.note === "string" ? j.note : "",
    windows: j.windows && typeof j.windows === "object" ? j.windows : {},
    groups: Array.isArray(j.groups) ? j.groups : [],
  };
}

/**
 * @param {string} chatId
 * @param {"month"|"week"|"lastWeek"} window
 */
export async function fetchTelegramGroupEvalCards(chatId, window) {
  const id = encodeURIComponent(chatId);
  const q = new URLSearchParams();
  q.set("window", window);
  const res = await fetch(`/api/telegram/live/group-eval/${id}/cards?${q}`);
  const j = await readJson(res, "加载单子详情失败");
  if (!j || typeof j !== "object" || !j.ok) {
    throw new Error((j && j.error) || "加载单子详情失败");
  }
  return {
    name: typeof j.name === "string" ? j.name : chatId,
    window: j.window,
    fromMs: Number(j.fromMs) || 0,
    toMs: Number(j.toMs) || 0,
    note: typeof j.note === "string" ? j.note : "",
    metrics: j.metrics && typeof j.metrics === "object" ? j.metrics : {},
    cards: Array.isArray(j.cards) ? j.cards : [],
  };
}

/**
 * @param {number|null|undefined} pnl
 * @param {TgWindowMetrics|undefined} m
 */
export function formatTotalPnlLabel(pnl, m) {
  const entered = m?.cardCount ?? 0;
  if (!entered && (pnl == null || !Number.isFinite(Number(pnl)))) return "—";
  const v = Number(pnl);
  const body = Number.isFinite(v) ? `${v >= 0 ? "+" : ""}${v.toFixed(2)}%` : "0.00%";
  const sample = entered ? ` · ${entered}张` : "";
  const undecided =
    m && m.pendingCount > 0 ? `（${m.pendingCount}待定）` : "";
  return `${body}${sample}${undecided}`;
}
