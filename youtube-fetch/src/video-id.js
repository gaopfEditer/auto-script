/**
 * 从 YouTube URL 或 11 位 video id 解析出 id。
 * @param {string} input
 * @returns {string | null}
 */
export function parseYouTubeVideoId(input) {
  const raw = String(input ?? "").trim();
  if (!raw) return null;

  if (/^[\w-]{11}$/.test(raw)) return raw;

  let url;
  try {
    url = new URL(raw);
  } catch {
    const m = raw.match(/(?:v=|\/embed\/|\/shorts\/|youtu\.be\/)([\w-]{11})/);
    return m?.[1] ?? null;
  }

  const host = url.hostname.replace(/^www\./, "");
  if (host === "youtu.be") {
    const id = url.pathname.slice(1).split("/")[0];
    return /^[\w-]{11}$/.test(id) ? id : null;
  }
  if (host === "youtube.com" || host === "m.youtube.com" || host === "music.youtube.com") {
    const v = url.searchParams.get("v");
    if (v && /^[\w-]{11}$/.test(v)) return v;
    const parts = url.pathname.split("/").filter(Boolean);
    const shortsIdx = parts.indexOf("shorts");
    if (shortsIdx >= 0 && parts[shortsIdx + 1] && /^[\w-]{11}$/.test(parts[shortsIdx + 1])) {
      return parts[shortsIdx + 1];
    }
    const embedIdx = parts.indexOf("embed");
    if (embedIdx >= 0 && parts[embedIdx + 1] && /^[\w-]{11}$/.test(parts[embedIdx + 1])) {
      return parts[embedIdx + 1];
    }
  }
  return null;
}
