/**
 * 聊天链接预览：抓取公开网页 HTML，解析 Open Graph + Twitter Cards。
 * 含基础 SSRF 防护（仅 http(s)、拒绝内网字面量主机）。
 */
import dns from "node:dns/promises";
import { config } from "./config.js";

const URL_IN_TEXT =
  /https?:\/\/[^\s<>"'`）】》»\]]+/gi;

/** @param {string} text */
export function extractFirstHttpUrl(text) {
  const m = String(text ?? "").match(URL_IN_TEXT);
  if (!m?.[0]) return null;
  let raw = m[0];
  // 去掉句末标点
  raw = raw.replace(/[.,;:!?。，；：！？、]+$/u, "");
  try {
    const u = new URL(raw);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    return u.href;
  } catch {
    return null;
  }
}

/** @param {string} host */
function isBlockedHostname(host) {
  const h = String(host || "")
    .trim()
    .toLowerCase()
    .replace(/\.$/, "");
  if (!h) return true;
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local")) return true;
  if (h === "0.0.0.0" || h === "::" || h === "::1") return true;
  // IPv4 字面量
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const parts = v4.slice(1).map(Number);
    if (parts.some((n) => n > 255)) return true;
    const [a, b] = parts;
    if (a === 10 || a === 127 || a === 0) return true;
    if (a === 169 && b === 254) return true;
    if (a === 172 && b >= 16 && b <= 31) return true;
    if (a === 192 && b === 168) return true;
    if (a === 100 && b >= 64 && b <= 127) return true; // CGNAT
    return false;
  }
  // 粗略拦 IPv6 私网
  if (h.includes(":")) {
    if (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80")) return true;
  }
  return false;
}

/** @param {string} hostname */
async function hostnameResolvesPrivate(hostname) {
  try {
    const records = await dns.lookup(hostname, { all: true, verbatim: true });
    for (const r of records) {
      if (isBlockedHostname(r.address)) return true;
    }
    return false;
  } catch {
    // 解析失败则仍允许尝试（由 fetch 失败兜底），避免过度拒绝
    return false;
  }
}

/** @param {string} s */
function decodeEntities(s) {
  return String(s ?? "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)));
}

/**
 * @param {string} html
 * @param {string} key  og:title | twitter:card | …
 * @param {"property"|"name"} attr
 */
function readMeta(html, key, attr = "property") {
  const esc = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re1 = new RegExp(
    `<meta[^>]+${attr}\\s*=\\s*["']${esc}["'][^>]+content\\s*=\\s*["']([^"']*)["'][^>]*>`,
    "i"
  );
  const re2 = new RegExp(
    `<meta[^>]+content\\s*=\\s*["']([^"']*)["'][^>]+${attr}\\s*=\\s*["']${esc}["'][^>]*>`,
    "i"
  );
  const m = html.match(re1) || html.match(re2);
  return m?.[1] ? decodeEntities(m[1]).trim() : "";
}

/** Twitter Cards 常用 name=；少数站点用 property= */
function readTwitterMeta(html, key) {
  return readMeta(html, key, "name") || readMeta(html, key, "property");
}

/** @param {string} html */
function readTitleTag(html) {
  const m = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i);
  return m?.[1] ? decodeEntities(m[1].replace(/\s+/g, " ")).trim() : "";
}

/**
 * @param {string} pageUrl
 * @param {string} imageUrl
 */
function absolutize(pageUrl, imageUrl) {
  const img = String(imageUrl || "").trim();
  if (!img) return "";
  try {
    return new URL(img, pageUrl).href;
  } catch {
    return "";
  }
}

/** @param {string} card */
function normalizeTwitterCard(card) {
  const c = String(card || "")
    .trim()
    .toLowerCase();
  if (
    c === "summary" ||
    c === "summary_large_image" ||
    c === "player" ||
    c === "app" ||
    c === "photo" ||
    c === "gallery" ||
    c === "product"
  ) {
    return c;
  }
  return "";
}

/**
 * 从 HTML（通常是 &lt;head&gt;）解析 OGP + Twitter Cards。
 * @param {string} html
 * @param {string} pageUrl
 */
export function parseLinkMetadata(html, pageUrl) {
  const headEnd = html.search(/<\/head>/i);
  const head = headEnd > 0 ? html.slice(0, headEnd + 7) : html.slice(0, Math.min(html.length, 120_000));

  const ogTitle = readMeta(head, "og:title", "property");
  const ogDescription = readMeta(head, "og:description", "property");
  const ogImage =
    readMeta(head, "og:image", "property") || readMeta(head, "og:image:url", "property");
  const ogSiteName = readMeta(head, "og:site_name", "property");

  const twCard = normalizeTwitterCard(readTwitterMeta(head, "twitter:card"));
  const twSite = readTwitterMeta(head, "twitter:site");
  const twCreator = readTwitterMeta(head, "twitter:creator");
  const twTitle = readTwitterMeta(head, "twitter:title");
  const twDescription = readTwitterMeta(head, "twitter:description");
  const twImage =
    readTwitterMeta(head, "twitter:image") || readTwitterMeta(head, "twitter:image:src");
  const twImageAlt = readTwitterMeta(head, "twitter:image:alt");

  const title = ogTitle || twTitle || readTitleTag(head) || "";
  const description =
    ogDescription || readMeta(head, "description", "name") || twDescription || "";
  const imageRaw = ogImage || twImage || "";
  const image = absolutize(pageUrl, imageRaw);
  const imageAlt = twImageAlt || readMeta(head, "og:image:alt", "property") || "";

  let siteName = ogSiteName;
  if (!siteName && twSite) {
    siteName = twSite.replace(/^@/, "");
  }
  if (!siteName) {
    try {
      siteName = new URL(pageUrl).hostname.replace(/^www\./i, "");
    } catch {
      siteName = "";
    }
  }

  // 有 twitter:card 但无图时，summary 仍可展示；完全空则放弃
  if (!title && !description && !image && !twCard) return null;

  /** @type {"og"|"twitter"|"mixed"|"basic"} */
  let source = "basic";
  const hasOg = Boolean(ogTitle || ogDescription || ogImage || ogSiteName);
  const hasTw = Boolean(twCard || twTitle || twDescription || twImage || twSite || twCreator);
  if (hasOg && hasTw) source = "mixed";
  else if (hasTw) source = "twitter";
  else if (hasOg) source = "og";

  // 布局：显式 large → 大图；仅 summary → 小图；否则有图默认大图横幅
  let card = twCard;
  if (!card && image) card = "summary_large_image";
  if (!card) card = "summary";

  return {
    url: pageUrl,
    title: title.slice(0, 200),
    description: description.slice(0, 400),
    image: image.slice(0, 512),
    imageAlt: imageAlt.slice(0, 200),
    siteName: String(siteName).slice(0, 128),
    card,
    twitterSite: twSite.slice(0, 64),
    twitterCreator: twCreator.slice(0, 64),
    source,
  };
}

/**
 * @param {string} url
 * @returns {Promise<ReturnType<typeof parseLinkMetadata>>}
 */
export async function fetchLinkPreview(url) {
  if (!config.communityLinkPreviewEnabled) return null;
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  if (isBlockedHostname(parsed.hostname)) return null;
  if (await hostnameResolvesPrivate(parsed.hostname)) return null;

  const timeoutMs = config.communityLinkPreviewTimeoutMs;
  const maxBytes = config.communityLinkPreviewMaxBytes;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(parsed.href, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
      headers: {
        Accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1",
        "User-Agent":
          "DiscordCollectorLinkPreview/1.0 (+community chat; Open Graph / Twitter Cards)",
        "Accept-Language": "zh-CN,zh;q=0.9,en;q=0.8",
      },
    });
    if (!res.ok) return null;
    const finalUrl = res.url || parsed.href;
    try {
      const finalHost = new URL(finalUrl).hostname;
      if (isBlockedHostname(finalHost)) return null;
    } catch {
      return null;
    }

    const ctype = String(res.headers.get("content-type") || "").toLowerCase();
    if (ctype && !ctype.includes("html") && !ctype.includes("xml") && !ctype.includes("text/plain")) {
      return null;
    }

    const buf = await res.arrayBuffer();
    const slice = buf.byteLength > maxBytes ? buf.slice(0, maxBytes) : buf;
    const html = new TextDecoder("utf-8", { fatal: false }).decode(slice);
    return parseLinkMetadata(html, finalUrl);
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}
