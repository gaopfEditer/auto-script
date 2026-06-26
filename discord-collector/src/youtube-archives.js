import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mergeVideoMeta, normalizePublishedAt, resolveVideoMetaRemote } from "../../youtube-fetch/src/video-meta.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ARCHIVES_DIR = path.resolve(__dirname, "..", "..", "youtube-fetch", "archives");

/** @param {string | undefined} configured */
export function resolveYoutubeArchivesDir(configured) {
  const raw = (configured ?? "").trim();
  if (raw) return path.resolve(raw);
  return DEFAULT_ARCHIVES_DIR;
}

/** @param {string} videoId */
export function isValidArchiveVideoId(videoId) {
  return /^[\w-]{11}$/.test(videoId);
}

/** @param {string} raw */
function stripBom(raw) {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/** @param {string} md */
function parseArchiveMd(md) {
  const text = String(md ?? "");
  const lines = text.split(/\r?\n/);

  let title = null;
  if (lines[0]?.startsWith("# ")) title = lines[0].slice(2).trim();

  let sourceUrl = null;
  let languageLine = null;
  let author = null;
  let publishedAt = null;
  let fetchedAt = null;
  for (const line of lines.slice(1, 16)) {
    if (line.startsWith("Source:")) sourceUrl = line.slice("Source:".length).trim();
    if (line.startsWith("Author:")) {
      const v = line.slice("Author:".length).trim();
      if (v && v !== "—") author = v;
    }
    if (line.startsWith("Published:")) {
      const v = line.slice("Published:".length).trim();
      if (v && v !== "—") publishedAt = normalizePublishedAt(v);
    }
    if (line.startsWith("Language:")) languageLine = line.slice("Language:".length).trim();
    if (line.startsWith("Fetched:")) fetchedAt = line.slice("Fetched:".length).trim();
  }

  const idx = text.indexOf("\n## Transcript\n");
  let transcript = "";
  if (idx >= 0) {
    const rest = text.slice(idx + "\n## Transcript\n".length);
    const analysisIdx = rest.indexOf("\n## Analysis\n");
    transcript = (analysisIdx >= 0 ? rest.slice(0, analysisIdx) : rest).trim();
  }

  return { title, sourceUrl, languageLine, author, publishedAt, fetchedAt, transcript };
}

/**
 * @param {Record<string, unknown>} meta
 * @param {ReturnType<typeof parseArchiveMd>} mdParsed
 */
function mergeMeta(meta, mdParsed) {
  const title = String(meta.title ?? mdParsed.title ?? meta.videoId ?? "");
  const merged = mergeVideoMeta(
    {
      title,
      author: meta.author ?? mdParsed.author ?? null,
      publishedAt: meta.publishedAt ?? mdParsed.publishedAt ?? null,
    },
    {}
  );
  return {
    title,
    sourceUrl: String(meta.sourceUrl ?? mdParsed.sourceUrl ?? ""),
    languageLine: meta.languageLine ?? mdParsed.languageLine ?? null,
    fetchedAt: meta.fetchedAt ?? mdParsed.fetchedAt ?? null,
    author: merged.author,
    publishedAt: merged.publishedAt,
    lang: meta.lang ?? null,
    charCount: meta.charCount ?? mdParsed.transcript.length,
    wordCount: meta.wordCount ?? null,
    analysis: meta.analysis ?? null,
  };
}

/** @param {string} archivesDir @param {string} videoId */
async function readArchivePair(archivesDir, videoId) {
  const jsonPath = path.join(archivesDir, `${videoId}.json`);
  const mdPath = path.join(archivesDir, `${videoId}.md`);

  let meta = /** @type {Record<string, unknown>} */ ({ videoId });
  try {
    const raw = stripBom(await fs.readFile(jsonPath, "utf8"));
    const data = JSON.parse(raw);
    meta = { videoId, ...data };
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    if (err.code !== "ENOENT") throw e;
  }

  let mdParsed = {
    title: null,
    sourceUrl: null,
    languageLine: null,
    author: null,
    publishedAt: null,
    fetchedAt: null,
    transcript: "",
  };
  try {
    const md = await fs.readFile(mdPath, "utf8");
    mdParsed = parseArchiveMd(md);
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    if (err.code === "ENOENT" && !meta.title) return null;
    if (err.code !== "ENOENT") throw e;
  }

  const merged = mergeMeta(meta, mdParsed);
  return { videoId, ...merged, hasMd: Boolean(mdParsed.transcript || mdParsed.title) };
}

/**
 * @param {string | undefined} raw
 * @param {boolean} [endOfDay]
 */
function parseDateBoundMs(raw, endOfDay = false) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  if (/^\d{4}-\d{2}-\d{2}$/u.test(s)) {
    const d = new Date(`${s}T${endOfDay ? "23:59:59.999" : "00:00:00.000"}`);
    return Number.isNaN(d.getTime()) ? null : d.getTime();
  }
  const d = new Date(s);
  return Number.isNaN(d.getTime()) ? null : d.getTime();
}

/**
 * @param {{ publishedAt?: unknown, fetchedAt?: unknown }} item
 */
function publishSortMs(item) {
  const p = normalizePublishedAt(item.publishedAt);
  if (p) return Date.parse(p);
  const f = item.fetchedAt ? Date.parse(String(item.fetchedAt)) : NaN;
  return Number.isFinite(f) ? f : 0;
}

/**
 * @param {string} archivesDir
 * @param {{ author?: string, from?: string, to?: string, backfill?: boolean }} [opts]
 */
export async function listYoutubeArchives(archivesDir, opts = {}) {
  const authorFilter = String(opts.author ?? "").trim().toLowerCase();
  const fromMs = parseDateBoundMs(opts.from, false);
  const toMs = parseDateBoundMs(opts.to, true);
  const backfill = opts.backfill !== false;
  let names;
  try {
    names = await fs.readdir(archivesDir);
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    if (err.code === "ENOENT") {
      return {
        ok: true,
        dir: archivesDir,
        authors: [],
        total: 0,
        items: [],
        filters: { author: null, from: opts.from ?? null, to: opts.to ?? null },
      };
    }
    throw e;
  }

  const ids = new Set();
  for (const name of names) {
    if (name.endsWith(".json")) ids.add(name.slice(0, -5));
    else if (name.endsWith(".md")) ids.add(name.slice(0, -3));
  }

  const items = [];
  for (const videoId of ids) {
    if (!isValidArchiveVideoId(videoId)) continue;
    const row = await readArchivePair(archivesDir, videoId);
    if (!row) continue;
    let author = row.author ?? null;
    let publishedAt = row.publishedAt ?? null;
    if (backfill && (!author || !publishedAt)) {
      const remote = await resolveVideoMetaRemote(videoId, {
        title: row.title,
        author,
        publishedAt,
      });
      author = remote.author;
      publishedAt = remote.publishedAt;
    }
    items.push({
      videoId: row.videoId,
      title: row.title,
      sourceUrl: row.sourceUrl,
      author,
      publishedAt,
      languageLine: row.languageLine,
      fetchedAt: row.fetchedAt,
      charCount: row.charCount,
      wordCount: row.wordCount,
      hasMd: row.hasMd,
      hasAnalysis: Boolean(row.analysis && !row.analysis.error),
      analyzedAt: row.analysis?.analyzedAt ?? null,
    });
  }

  items.sort((a, b) => {
    const tb = publishSortMs(b);
    const ta = publishSortMs(a);
    if (tb !== ta) return tb - ta;
    return String(b.videoId).localeCompare(String(a.videoId));
  });

  const authors = [...new Set(items.map((x) => String(x.author ?? "").trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "zh-CN")
  );

  let filtered = authorFilter
    ? items.filter((x) => String(x.author ?? "").trim().toLowerCase() === authorFilter)
    : items;

  if (fromMs != null) {
    filtered = filtered.filter((x) => publishSortMs(x) >= fromMs);
  }
  if (toMs != null) {
    filtered = filtered.filter((x) => publishSortMs(x) <= toMs);
  }

  return {
    ok: true,
    dir: archivesDir,
    authors,
    total: items.length,
    items: filtered,
    filters: {
      author: authorFilter || null,
      from: opts.from ?? null,
      to: opts.to ?? null,
    },
  };
}

/**
 * @param {string} archivesDir
 * @param {string} videoId
 */
export async function getYoutubeArchive(archivesDir, videoId) {
  if (!isValidArchiveVideoId(videoId)) {
    return { ok: false, error: "无效的 videoId" };
  }

  const mdPath = path.join(archivesDir, `${videoId}.md`);
  const row = await readArchivePair(archivesDir, videoId);
  if (!row) return { ok: false, error: "归档不存在", videoId };

  let md = "";
  try {
    md = await fs.readFile(mdPath, "utf8");
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    if (err.code === "ENOENT") return { ok: false, error: "缺少 .md 正文文件", videoId };
    throw e;
  }

  const parsed = parseArchiveMd(md);
  return {
    ok: true,
    videoId,
    title: row.title || parsed.title,
    sourceUrl: row.sourceUrl || parsed.sourceUrl,
    languageLine: row.languageLine || parsed.languageLine,
    fetchedAt: row.fetchedAt || parsed.fetchedAt,
    author: row.author ?? null,
    publishedAt: row.publishedAt ?? null,
    lang: row.lang ?? null,
    charCount: row.charCount ?? parsed.transcript.length,
    wordCount: row.wordCount ?? null,
    transcript: parsed.transcript,
    analysis: row.analysis ?? null,
  };
}

/**
 * @param {import('express').Express} app
 * @param {{ archivesDir: string, log: ReturnType<import('./logger.js').createLogger> }} opts
 */
export function registerYoutubeArchiveRoutes(app, opts) {
  const { archivesDir, log } = opts;

  app.get("/api/youtube-archives", async (req, res) => {
    try {
      const author = String(req.query.author ?? "").trim();
      const from = String(req.query.from ?? req.query.fromDate ?? "").trim();
      const to = String(req.query.to ?? req.query.toDate ?? "").trim();
      const backfill = req.query.backfill !== "0";
      const out = await listYoutubeArchives(archivesDir, { author, from, to, backfill });
      res.json(out);
    } catch (e) {
      log.warn(`list archives: ${/** @type {Error} */ (e).message}`);
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.get("/api/youtube-archives/:videoId", async (req, res) => {
    try {
      const out = await getYoutubeArchive(archivesDir, String(req.params.videoId ?? ""));
      if (!out.ok) {
        res.status(out.error === "无效的 videoId" ? 400 : 404).json(out);
        return;
      }
      res.json(out);
    } catch (e) {
      log.warn(`read archive: ${/** @type {Error} */ (e).message}`);
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });
}
