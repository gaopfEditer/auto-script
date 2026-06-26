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

/** @param {{ author?: string, from?: string, to?: string }} [opts] */
export async function fetchYoutubeArchiveList(opts = {}) {
  const params = new URLSearchParams();
  const author = String(opts.author ?? "").trim();
  const from = String(opts.from ?? "").trim();
  const to = String(opts.to ?? "").trim();
  if (author) params.set("author", author);
  if (from) params.set("from", from);
  if (to) params.set("to", to);
  const qs = params.toString();
  const res = await fetch(`/api/youtube-archives${qs ? `?${qs}` : ""}`);
  const data = await parseJsonResponse(res);
  if (!data.ok) throw new Error(data.error || "加载归档列表失败");
  return /** @type {{ dir: string, authors: string[], total: number, items: Array<Record<string, unknown>> }} */ ({
    dir: data.dir,
    authors: data.authors ?? [],
    total: Number(data.total) || (data.items ?? []).length,
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
