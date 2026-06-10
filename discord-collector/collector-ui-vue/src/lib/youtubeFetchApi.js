/** @param {Response} res */
async function parseJsonResponse(res) {
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(`接口返回空响应（HTTP ${res.status}），请确认 collect:ui 与 youtube-fetch 已启动`);
  }
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.slice(0, 120).replace(/\s+/g, " ");
    throw new Error(`接口返回非 JSON（HTTP ${res.status}）：${preview}`);
  }
}

/**
 * @param {{ urls: string[], lang?: string }} payload
 */
export async function enqueueYoutubeUrls(payload) {
  const res = await fetch("/api/youtube-fetch/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      urls: payload.urls,
      lang: payload.lang || undefined,
    }),
  });
  const data = await parseJsonResponse(res);
  if (!data.ok && !data.results?.length) {
    throw new Error(data.error || "入队失败");
  }
  return data;
}

/** @param {number} [limit] */
export async function fetchYoutubeQueue(limit = 80) {
  const res = await fetch(`/api/youtube-fetch/queue?limit=${limit}`);
  const data = await parseJsonResponse(res);
  if (!data.ok) throw new Error(data.error || "加载队列失败");
  return data;
}

export async function fetchYoutubeFetchHealth() {
  const res = await fetch("/api/youtube-fetch/health");
  const data = await parseJsonResponse(res);
  if (!data.ok) throw new Error(data.error || "youtube-fetch 不可用");
  return data;
}
