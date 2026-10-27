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
 * @param {{ urls: string[], lang?: string, analyze?: boolean }} payload
 */
export async function enqueueYoutubeUrls(payload) {
  const res = await fetch("/api/youtube-fetch/queue", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      urls: payload.urls,
      lang: payload.lang || undefined,
      analyze: payload.analyze === true,
    }),
  });
  const data = await parseJsonResponse(res);
  if (!data.ok && !data.results?.length) {
    throw new Error(data.error || "入队失败");
  }
  return data;
}

/** @param {string} videoId */
export async function analyzeYoutubeArchive(videoId) {
  const id = String(videoId ?? "").trim();
  if (!id) throw new Error("缺少 videoId");
  const res = await fetch(`/api/youtube-fetch/analyze/${encodeURIComponent(id)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({}),
  });
  const data = await parseJsonResponse(res);
  if (!data.ok) throw new Error(data.error || "分析失败");
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

/** @param {{ text?: string, title?: string, body?: string }} payload */
export async function parsePastedYoutubeText(payload) {
  const res = await fetch("/api/youtube-fetch/parse-text", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await parseJsonResponse(res);
  if (!data.ok) throw new Error(data.error || "解析失败");
  return /** @type {{ title: string, preview: Record<string, unknown>, analysis: Record<string, unknown>, coinActions?: unknown[] }} */ (data);
}

export async function fetchPasteFileList() {
  const res = await fetch("/api/youtube-fetch/paste-files");
  const data = await parseJsonResponse(res);
  if (!data.ok) throw new Error(data.error || "加载文稿列表失败");
  return data;
}

/** @param {string} name */
export async function fetchPasteFileResult(name) {
  const res = await fetch(`/api/youtube-fetch/paste-files/${encodeURIComponent(name)}`);
  const data = await parseJsonResponse(res);
  if (!data.ok) throw new Error(data.error || "加载解析结果失败");
  return /** @type {{ data: Record<string, unknown> }} */ (data);
}

/** @param {string} name */
export async function fetchPasteFileRaw(name) {
  const res = await fetch(`/api/youtube-fetch/paste-files/${encodeURIComponent(name)}/raw`);
  const data = await parseJsonResponse(res);
  if (!data.ok) throw new Error(data.error || "加载原文失败");
  return /** @type {{ name: string, text: string }} */ (data);
}

/** @param {{ force?: boolean }} [opts] */
export async function triggerPasteFileScan(opts = {}) {
  const res = await fetch("/api/youtube-fetch/paste-files/scan", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force: opts.force === true }),
  });
  const data = await parseJsonResponse(res);
  if (!data.ok) throw new Error(data.error || "触发扫描失败");
  return data;
}

/** @param {string} name @param {{ force?: boolean }} [opts] */
export async function parsePasteFileByName(name, opts = {}) {
  const res = await fetch(`/api/youtube-fetch/paste-files/${encodeURIComponent(name)}/parse`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ force: opts.force !== false }),
  });
  const data = await parseJsonResponse(res);
  if (!data.ok) throw new Error(data.error || "解析失败");
  return data;
}

/**
 * 注册 coin-action 入场价位监听（±5% / 每 5min）
 * @param {{ sourceRef: string, title?: string, rawContent?: string, coinActions?: unknown[], bandPct?: number }} payload
 */
export async function registerCoinActionWatches(payload) {
  const res = await fetch("/api/youtube-fetch/coin-actions/watch", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const data = await parseJsonResponse(res);
  if (!data.ok) throw new Error(data.error || "注册监听失败");
  return data;
}
