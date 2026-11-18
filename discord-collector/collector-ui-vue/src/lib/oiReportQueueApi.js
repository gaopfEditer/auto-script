import { readOkJson } from "./httpJson.js";

/**
 * @typedef {{
 *   id: string,
 *   kind: string,
 *   symbol: string,
 *   interval: string,
 *   side: string,
 *   sideLabel: string,
 *   pattern: string,
 *   volumeSurge: "yes"|"no"|"unknown"|string,
 *   volumeSurgeLabel: string,
 *   volumeRatio?: number|null,
 *   oiAnomaly: boolean,
 *   oiHistoric?: boolean,
 *   oiWindows?: string[],
 *   timeMs: number,
 *   timeLabel: string,
 *   dateLabel?: string,
 * }} OiReportQueueItem
 */

/**
 * @typedef {{
 *   id: string,
 *   windowStartMs: number,
 *   windowEndMs: number,
 *   windowLabel: string,
 *   windowDateLabel?: string,
 *   itemCount: number,
 *   createdAtMs?: number|null,
 *   pending?: boolean,
 *   preview: string,
 *   items: OiReportQueueItem[],
 * }} OiReportQueueReport
 */

/**
 * @param {{ limit?: number, items?: boolean }} [opts]
 */
export async function fetchOiReportQueue(opts = {}) {
  const q = new URLSearchParams();
  if (opts.limit != null) q.set("limit", String(opts.limit));
  if (opts.items === false) q.set("items", "0");
  const suffix = q.toString() ? `?${q}` : "";
  const res = await fetch(`/api/oi/report-queue${suffix}`);
  const data = await readOkJson(res, "无法读取形态/OI 报告队列");
  const reports = Array.isArray(data.reports) ? data.reports : [];
  const pending = data.pending && typeof data.pending === "object" ? data.pending : null;
  return {
    ok: true,
    timezone: data.timezone || "UTC+8",
    windowSec: Number(data.windowSec) || 300,
    minInterval: data.minInterval || "5m",
    pending,
    reports,
    count: reports.length,
    oiOnline: data.oiOnline !== false,
  };
}

/** @param {string} reportId */
export async function fetchOiReportQueueOne(reportId) {
  const id = String(reportId || "").trim();
  if (!id) throw new Error("缺少报告 id");
  const res = await fetch(`/api/oi/report-queue/${encodeURIComponent(id)}`);
  const data = await readOkJson(res, "无法读取报告详情");
  return data.report ?? data;
}
