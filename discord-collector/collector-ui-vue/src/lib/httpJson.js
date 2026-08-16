/**
 * 安全解析 fetch Response 为 JSON。
 * 避免空 body / 代理失败时抛出 Unexpected end of JSON input。
 *
 * @param {Response} res
 * @param {string} [fallback="请求失败"]
 * @returns {Promise<any>}
 */
export async function readJsonResponse(res, fallback = "请求失败") {
  let text = "";
  try {
    text = await res.text();
  } catch {
    throw new Error(res.ok ? fallback : `HTTP ${res.status}`);
  }
  if (!text.trim()) {
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    throw new Error(`${fallback}（空响应，后端是否在运行？）`);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new Error(res.ok ? `${fallback}（非 JSON 响应）` : `HTTP ${res.status}`);
  }
}

/**
 * @param {Response} res
 * @param {string} [fallback]
 */
export async function readOkJson(res, fallback = "请求失败") {
  const j = await readJsonResponse(res, fallback);
  if (!j || typeof j !== "object") {
    throw new Error(fallback);
  }
  if (j.ok === false) {
    throw new Error(String(j.error || fallback));
  }
  return j;
}
