import { readJsonResponse } from "./httpJson.js";

/** @typedef {{
 *   logicName: string,
 *   kolvipChannelId: string,
 *   discordChannelId: string,
 *   channelName: string,
 *   pushedCount: number,
 *   notEnteredCount: number,
 *   displayState: 'win_rate' | 'insufficient_sample' | 'fetching',
 *   decided: number,
 *   metrics: import('./cardEvalApi.js').EvalMetrics,
 *   section?: string,
 * }} KolvipEvalChannelRow */

export async function fetchKolvipEvalSummary(opts = {}) {
  const q = new URLSearchParams();
  if (opts.days) q.set("days", String(opts.days));
  const res = await fetch(`/api/kolvip/eval-summary?${q}`);
  const j = await readJsonResponse(res, "加载巨鲸胜率摘要失败");
  if (!j || typeof j !== "object" || !j.ok) {
    throw new Error((j && j.error) || "加载巨鲸胜率摘要失败");
  }
  return {
    days: Number(j.days) || 7,
    fromMs: Number(j.fromMs) || 0,
    toMs: Number(j.toMs) || 0,
    note: typeof j.note === "string" ? j.note : "",
    curated: Array.isArray(j.curated) ? j.curated : Array.isArray(j.channels) ? j.channels : [],
    candidates: Array.isArray(j.candidates) ? j.candidates : [],
    catalogUpdatedAt: j.catalogUpdatedAt ?? null,
  };
}

/** @typedef {{
 *   status: string,
 *   channelName?: string,
 *   curated?: boolean,
 *   cardsCreated?: number,
 *   sampleCount?: number,
 *   batchesDone?: number,
 *   lastError?: string | null,
 *   updatedAt?: string | null,
 *   backfillCursor?: string | null,
 * }} KolvipBackfillJob */

export async function fetchKolvipBackfillStatus() {
  const res = await fetch("/api/kolvip/backfill/status");
  const j = await readJsonResponse(res, "加载巨鲸回溯状态失败");
  if (!j || typeof j !== "object" || !j.ok) {
    throw new Error((j && j.error) || "加载巨鲸回溯状态失败");
  }
  return j;
}

export async function fetchKolvipStatus() {
  const res = await fetch("/api/kolvip/status");
  const j = await readJsonResponse(res, "加载巨鲸源状态失败");
  if (!j || typeof j !== "object") {
    throw new Error("加载巨鲸源状态失败");
  }
  return j;
}

export async function syncKolvipCatalog() {
  const res = await fetch("/api/kolvip/catalog/sync", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const j = await readJsonResponse(res, "同步巨鲸频道目录失败");
  if (!j || typeof j !== "object" || j.ok === false) {
    throw new Error((j && j.error) || "同步巨鲸频道目录失败");
  }
  return j;
}

export async function startKolvipBackfillAll() {
  const res = await fetch("/api/kolvip/backfill/start-all", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const j = await readJsonResponse(res, "启动全站巨鲸回溯失败");
  if (!j || typeof j !== "object" || j.ok === false) {
    throw new Error((j && j.error) || "启动全站巨鲸回溯失败");
  }
  return j;
}

/** @param {string} kolvipChannelId */
export async function startKolvipBackfillPilot(kolvipChannelId) {
  const res = await fetch("/api/kolvip/backfill/start", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ kolvipChannelId }),
  });
  const j = await readJsonResponse(res, "启动试点回溯失败");
  if (!j || typeof j !== "object" || j.ok === false) {
    throw new Error((j && j.error) || "启动试点回溯失败");
  }
  return j;
}

export async function pauseKolvipBackfill() {
  const res = await fetch("/api/kolvip/backfill/pause", { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
  const j = await readJsonResponse(res, "暂停巨鲸回溯失败");
  if (!j || typeof j !== "object" || j.ok === false) {
    throw new Error((j && j.error) || "暂停巨鲸回溯失败");
  }
  return j;
}
