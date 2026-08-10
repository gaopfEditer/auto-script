/**
 * Show 布局同步：
 * - 本地（localhost / 127.0.0.1）：可读可写后台
 * - 域名访问：仅首次从后台拉取一次，之后只读写 localStorage
 */

export const SHOW_LAYOUT_SEEDED_KEY = "discord-collector.show.layout.server-seeded.v1";

/** @returns {boolean} */
export function isLocalShowClient() {
  if (typeof location === "undefined") return true;
  const host = String(location.hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}

/** @returns {Promise<{ ok: boolean, layout?: Record<string, unknown>, updatedAt?: number | null, error?: string }>} */
export async function fetchShowLayoutFromServer() {
  const res = await fetch("/api/show/layout");
  const text = await res.text();
  if (!text.trim()) {
    return { ok: false, error: `空响应 HTTP ${res.status}` };
  }
  let data;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, error: `非 JSON HTTP ${res.status}` };
  }
  if (!data?.ok) return { ok: false, error: data?.error || "读取布局失败" };
  return {
    ok: true,
    layout: data.layout && typeof data.layout === "object" ? data.layout : {},
    updatedAt: data.updatedAt ?? null,
  };
}

/**
 * @param {Record<string, unknown>} layout
 * @returns {Promise<{ ok: boolean, error?: string, updatedAt?: number }>}
 */
export async function putShowLayoutToServer(layout) {
  const res = await fetch("/api/show/layout", {
    method: "PUT",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ layout }),
  });
  const text = await res.text();
  let data = {};
  try {
    data = text.trim() ? JSON.parse(text) : {};
  } catch {
    return { ok: false, error: `非 JSON HTTP ${res.status}` };
  }
  if (!res.ok || !data.ok) {
    return { ok: false, error: data.error || `保存失败 HTTP ${res.status}` };
  }
  return { ok: true, updatedAt: data.updatedAt };
}

/** @returns {boolean} */
export function hasRemoteLayoutSeeded() {
  try {
    return Boolean(localStorage.getItem(SHOW_LAYOUT_SEEDED_KEY));
  } catch {
    return false;
  }
}

/** @param {number} [ts] */
export function markRemoteLayoutSeeded(ts = Date.now()) {
  try {
    localStorage.setItem(SHOW_LAYOUT_SEEDED_KEY, String(ts));
  } catch {
    /* quota */
  }
}
