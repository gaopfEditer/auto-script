/** @param {Response} res */
async function parseJsonResponse(res) {
  const text = await res.text();
  if (!text.trim()) {
    throw new Error(`接口返回空响应（HTTP ${res.status}），请确认 collect:ui 已重启`);
  }
  try {
    return JSON.parse(text);
  } catch {
    const preview = text.slice(0, 120).replace(/\s+/g, " ");
    throw new Error(`接口返回非 JSON（HTTP ${res.status}）：${preview}`);
  }
}

export async function fetchYoutubeArchiveList() {
  const res = await fetch("/api/youtube-archives");
  const data = await parseJsonResponse(res);
  if (!data.ok) throw new Error(data.error || "加载归档列表失败");
  return /** @type {{ dir: string, items: Array<Record<string, unknown>> }} */ ({
    dir: data.dir,
    items: data.items ?? [],
  });
}

/** @param {string} videoId */
export async function fetchYoutubeArchive(videoId) {
  const res = await fetch(`/api/youtube-archives/${encodeURIComponent(videoId)}`);
  const data = await parseJsonResponse(res);
  if (!data.ok) throw new Error(data.error || "加载文稿失败");
  return /** @type {Record<string, unknown>} */ (data);
}
