import { readJsonResponse } from "./httpJson.js";

/** @typedef {'7'|'30'|'all'} KolvipSigRange */

export async function fetchKolvipSigMeta() {
  const res = await fetch("/api/kolvip/sig/meta", { cache: "no-store" });
  return readJsonResponse(res, "加载博主胜率元数据失败");
}

/** @param {KolvipSigRange} range */
export async function fetchKolvipSigRank(range = "30") {
  const res = await fetch(`/api/kolvip/sig/rank?range=${encodeURIComponent(range)}`, {
    cache: "no-store",
  });
  return readJsonResponse(res, "加载博主胜率榜单失败");
}

/**
 * @param {string} name
 * @param {KolvipSigRange} range
 */
export async function fetchKolvipSigBlogger(name, range = "30") {
  const q = new URLSearchParams({ name, range });
  const res = await fetch(`/api/kolvip/sig/blogger?${q}`, { cache: "no-store" });
  return readJsonResponse(res, "加载博主详情失败");
}

export async function syncKolvipSigLocal() {
  const res = await fetch("/api/kolvip/sig/sync", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ detailLimit: 0 }),
  });
  return readJsonResponse(res, "同步博主胜率失败");
}