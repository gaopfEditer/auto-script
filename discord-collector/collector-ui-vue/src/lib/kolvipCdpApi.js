import { readJsonResponse } from "./httpJson.js";

/**
 * @returns {Promise<Record<string, unknown>>}
 */
export async function fetchKolvipCdpOverview(days = 30) {
  const q = new URLSearchParams();
  if (days) q.set("days", String(days));
  const res = await fetch(`/api/local/kolvip-cdp/overview?${q}`);
  const j = await readJsonResponse(res, "加载巨鲸概览失败");
  if (!j || typeof j !== "object" || !j.ok) {
    throw new Error((j && j.error) || "加载巨鲸概览失败");
  }
  return j;
}
