/**
 * YouTube 视频作者与发布时间（上传时间）解析 / 拉取。
 */

/**
 * @param {string} title
 */
export function parseAuthorFromTitle(title) {
  const t = String(title ?? "").trim();
  if (!t) return null;
  const parts = t.split(/[|｜]/);
  if (parts.length >= 2) {
    const tail = parts[parts.length - 1]
      .trim()
      .replace(/\s*20\d{2}[-/.]?\d{2}[-/.]?\d{2}\s*$/u, "")
      .trim();
    return tail || null;
  }
  return null;
}

/**
 * @param {string} title
 * @returns {string | null} ISO 8601
 */
export function parsePublishedAtFromTitle(title) {
  const t = String(title ?? "").trim();
  if (!t) return null;
  let m = t.match(/[\s|｜](20\d{2})(\d{2})(\d{2})\s*$/u);
  if (m) return `${m[1]}-${m[2]}-${m[3]}T12:00:00.000Z`;
  m = t.match(/\b(20\d{2})[-/.](\d{1,2})[-/.](\d{1,2})\b/u);
  if (m) {
    const mm = String(m[2]).padStart(2, "0");
    const dd = String(m[3]).padStart(2, "0");
    return `${m[1]}-${mm}-${dd}T12:00:00.000Z`;
  }
  return null;
}

/**
 * @param {unknown} raw
 * @returns {string | null} ISO 8601
 */
export function normalizePublishedAt(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString();
}

/**
 * @param {{ title?: string | null, author?: string | null, publishedAt?: string | null }} base
 * @param {{ author?: string | null, publishedAt?: string | null }} extra
 */
export function mergeVideoMeta(base, extra) {
  const title = String(base.title ?? "").trim();
  const author =
    String(extra.author ?? base.author ?? "").trim() ||
    parseAuthorFromTitle(title) ||
    null;
  const publishedAt =
    normalizePublishedAt(extra.publishedAt ?? base.publishedAt) ||
    parsePublishedAtFromTitle(title) ||
    null;
  return { author, publishedAt };
}

/**
 * @param {string} html
 */
function parseUploadDateFromWatchHtml(html) {
  const text = String(html ?? "");
  for (const re of [
    /"uploadDate"\s*:\s*"([^"]+)"/u,
    /"publishDate"\s*:\s*"([^"]+)"/u,
    /"datePublished"\s*:\s*"([^"]+)"/u,
  ]) {
    const m = text.match(re);
    if (m?.[1]) {
      const iso = normalizePublishedAt(m[1]);
      if (iso) return iso;
    }
  }
  return null;
}

/**
 * Node / 浏览器内均可：oEmbed 取频道名（作者）。
 * @param {string} videoId
 * @param {number} [timeoutMs]
 */
export async function fetchOEmbedAuthor(videoId, timeoutMs = 12_000) {
  const id = String(videoId ?? "").trim();
  if (!id) return null;
  const watch = `https://www.youtube.com/watch?v=${id}`;
  const url = `https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const r = await fetch(url, {
      signal: controller.signal,
      headers: { Accept: "application/json", "User-Agent": "youtube-fetch/1.0" },
    });
    if (!r.ok) return null;
    const j = await r.json();
    const name = String(j?.author_name ?? "").trim();
    return name || null;
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {import('playwright').Page} page
 * @param {string} videoId
 * @param {number} timeoutMs
 */
export async function fetchVideoMetaInPage(page, videoId, timeoutMs = 25_000) {
  return page.evaluate(
    async ({ videoId: vid, timeoutMs: ms }) => {
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), ms);
      /** @type {{ author: string | null, publishedAt: string | null }} */
      const out = { author: null, publishedAt: null };
      try {
        const watch = `https://www.youtube.com/watch?v=${vid}`;
        const oembedUrl = `https://www.youtube.com/oembed?url=${encodeURIComponent(watch)}&format=json`;
        const o = await fetch(oembedUrl, { signal: ctrl.signal });
        if (o.ok) {
          const j = await o.json();
          out.author = String(j?.author_name ?? "").trim() || null;
        }
        const w = await fetch(`${watch}&hl=en`, { signal: ctrl.signal });
        if (w.ok) {
          const html = await w.text();
          for (const re of [
            /"uploadDate"\s*:\s*"([^"]+)"/,
            /"publishDate"\s*:\s*"([^"]+)"/,
            /"datePublished"\s*:\s*"([^"]+)"/,
          ]) {
            const m = html.match(re);
            if (m?.[1]) {
              const d = new Date(m[1]);
              if (!Number.isNaN(d.getTime())) {
                out.publishedAt = d.toISOString();
                break;
              }
            }
          }
        }
      } catch {
        /* ignore */
      } finally {
        clearTimeout(t);
      }
      return out;
    },
    { videoId, timeoutMs }
  );
}

/**
 * 无 CDP 时的远程补全（列表 backfill）。
 * @param {string} videoId
 * @param {{ title?: string | null, author?: string | null, publishedAt?: string | null }} existing
 */
export async function resolveVideoMetaRemote(videoId, existing = {}) {
  const merged = mergeVideoMeta(existing, {});
  if (merged.author && merged.publishedAt) return merged;
  const author = merged.author || (await fetchOEmbedAuthor(videoId));
  let publishedAt = merged.publishedAt;
  if (!publishedAt) {
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 12_000);
      const r = await fetch(`https://www.youtube.com/watch?v=${videoId}&hl=en`, {
        signal: controller.signal,
        headers: { "User-Agent": "Mozilla/5.0 (compatible; youtube-fetch/1.0)" },
      });
      clearTimeout(timer);
      if (r.ok) publishedAt = parseUploadDateFromWatchHtml(await r.text());
    } catch {
      /* ignore */
    }
  }
  return mergeVideoMeta(existing, { author, publishedAt });
}

/**
 * @param {string} rawMd 原始 transcript markdown（若站点扩展字段）
 */
export function parseVideoMetaFromTranscriptMd(rawMd) {
  const text = String(rawMd ?? "");
  const authorMatch = text.match(/^Author:\s*(.+)$/m);
  const channelMatch = text.match(/^Channel:\s*(.+)$/m);
  const publishedMatch = text.match(/^Published(?:\s+at)?:\s*(.+)$/im);
  return {
    author: (authorMatch?.[1] ?? channelMatch?.[1] ?? "").trim() || null,
    publishedAt: normalizePublishedAt(publishedMatch?.[1] ?? null),
  };
}
