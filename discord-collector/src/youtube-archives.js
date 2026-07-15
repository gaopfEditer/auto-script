import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mergeVideoMeta, normalizePublishedAt, resolveVideoMetaRemote } from "../../youtube-fetch/src/video-meta.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_ARCHIVES_DIR = path.resolve(__dirname, "..", "..", "youtube-fetch", "archives");
const INDEX_FILENAME = "_archives-index.json";
const INDEX_VERSION = 1;
const PARSED_CACHE_VERSION = 1;

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
export function parseArchiveMd(md) {
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

/** @param {string} p */
async function statMtimeMs(p) {
  try {
    return (await fs.stat(p)).mtimeMs;
  } catch {
    return null;
  }
}

/** @param {string} archivesDir */
async function getArchivesSourceMtimeMs(archivesDir) {
  let max = 0;
  let names;
  try {
    names = await fs.readdir(archivesDir);
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    if (err.code === "ENOENT") return 0;
    throw e;
  }
  for (const name of names) {
    if (name === INDEX_FILENAME) continue;
    if (!name.endsWith(".json") && !name.endsWith(".md")) continue;
    const m = await statMtimeMs(path.join(archivesDir, name));
    if (m != null && m > max) max = m;
  }
  return max;
}

/** @param {string} archivesDir @param {string} videoId */
async function readVideoJson(archivesDir, videoId) {
  const jsonPath = path.join(archivesDir, `${videoId}.json`);
  try {
    const raw = stripBom(await fs.readFile(jsonPath, "utf8"));
    const data = JSON.parse(raw);
    return { meta: { videoId, ...data }, jsonPath };
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    if (err.code === "ENOENT") return { meta: { videoId }, jsonPath };
    throw e;
  }
}

/** @param {string} jsonPath @param {Record<string, unknown>} meta */
async function writeVideoJson(jsonPath, meta) {
  await fs.writeFile(jsonPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
}

/**
 * 解析 .md 并写入 .json 的 parsedCache（含 transcript），供列表/详情快速读取。
 * @param {string} archivesDir
 * @param {string} videoId
 * @param {{ backfill?: boolean }} [opts]
 */
export async function syncArchiveParsedCache(archivesDir, videoId, opts = {}) {
  if (!isValidArchiveVideoId(videoId)) return null;

  const mdPath = path.join(archivesDir, `${videoId}.md`);
  const { meta, jsonPath } = await readVideoJson(archivesDir, videoId);
  const mdMtimeMs = await statMtimeMs(mdPath);

  /** @type {Record<string, unknown> | null} */
  const existingCache =
    meta.parsedCache && typeof meta.parsedCache === "object"
      ? /** @type {Record<string, unknown>} */ (meta.parsedCache)
      : null;

  let mdParsed = {
    title: null,
    sourceUrl: null,
    languageLine: null,
    author: null,
    publishedAt: null,
    fetchedAt: null,
    transcript: "",
  };
  let needsMdRead = !existingCache?.transcript || existingCache.mdMtimeMs !== mdMtimeMs;

  if (needsMdRead && mdMtimeMs != null) {
    try {
      const md = await fs.readFile(mdPath, "utf8");
      mdParsed = parseArchiveMd(md);
    } catch (e) {
      const err = /** @type {NodeJS.ErrnoException} */ (e);
      if (err.code !== "ENOENT") throw e;
      needsMdRead = false;
    }
  } else if (existingCache?.transcript) {
    mdParsed = {
      title: existingCache.title ? String(existingCache.title) : null,
      sourceUrl: existingCache.sourceUrl ? String(existingCache.sourceUrl) : null,
      languageLine: existingCache.languageLine ? String(existingCache.languageLine) : null,
      author: existingCache.author ? String(existingCache.author) : null,
      publishedAt: existingCache.publishedAt ? String(existingCache.publishedAt) : null,
      fetchedAt: existingCache.fetchedAt ? String(existingCache.fetchedAt) : null,
      transcript: String(existingCache.transcript),
    };
  }

  const merged = mergeMeta(meta, mdParsed);
  let author = merged.author;
  let publishedAt = merged.publishedAt;
  let dirty = false;

  if (opts.backfill && (!author || !publishedAt)) {
    const remote = await resolveVideoMetaRemote(videoId, {
      title: merged.title,
      author,
      publishedAt,
    });
    if (remote.author && remote.author !== author) {
      author = remote.author;
      dirty = true;
    }
    if (remote.publishedAt && remote.publishedAt !== publishedAt) {
      publishedAt = remote.publishedAt;
      dirty = true;
    }
  }

  const shouldWriteCache = needsMdRead || dirty || !existingCache;
  if (shouldWriteCache) {
    const next = {
      ...meta,
      title: merged.title,
      sourceUrl: merged.sourceUrl,
      languageLine: merged.languageLine,
      fetchedAt: merged.fetchedAt,
      author,
      publishedAt,
      charCount: merged.charCount,
      wordCount: merged.wordCount,
      analysis: merged.analysis,
      parsedCache: {
        version: PARSED_CACHE_VERSION,
        mdMtimeMs,
        parsedAt: new Date().toISOString(),
        transcript: mdParsed.transcript,
        title: mdParsed.title,
        sourceUrl: mdParsed.sourceUrl,
        languageLine: mdParsed.languageLine,
        author: mdParsed.author,
        publishedAt: mdParsed.publishedAt,
        fetchedAt: mdParsed.fetchedAt,
      },
    };
    await writeVideoJson(jsonPath, next);
    return { meta: next, merged: { ...merged, author, publishedAt } };
  }

  return { meta, merged: { ...merged, author, publishedAt } };
}

/** @param {string} archivesDir @param {string} videoId */
async function readListItemFromJson(archivesDir, videoId) {
  const { meta } = await readVideoJson(archivesDir, videoId);
  if (!meta.title && !meta.videoId) return null;

  const cache =
    meta.parsedCache && typeof meta.parsedCache === "object"
      ? /** @type {Record<string, unknown>} */ (meta.parsedCache)
      : null;

  const mdParsed = {
    title: cache?.title ? String(cache.title) : null,
    sourceUrl: cache?.sourceUrl ? String(cache.sourceUrl) : null,
    languageLine: cache?.languageLine ? String(cache.languageLine) : null,
    author: cache?.author ? String(cache.author) : null,
    publishedAt: cache?.publishedAt ? String(cache.publishedAt) : null,
    fetchedAt: cache?.fetchedAt ? String(cache.fetchedAt) : null,
    transcript: cache?.transcript ? String(cache.transcript) : "",
  };

  const merged = mergeMeta(meta, mdParsed);
  return toListItem(meta, merged);
}

/**
 * 后台预热：解析 .md 写入 parsedCache（可选 backfill 元数据）。
 * @param {string} archivesDir
 * @param {{ backfill?: boolean }} [opts]
 */
export async function warmArchivesParsedCache(archivesDir, opts = {}) {
  const names = await fs.readdir(archivesDir);
  const ids = new Set();
  for (const name of names) {
    if (name.endsWith(".json") && name !== INDEX_FILENAME) ids.add(name.slice(0, -5));
    else if (name.endsWith(".md")) ids.add(name.slice(0, -3));
  }
  const videoIds = [...ids].filter(isValidArchiveVideoId);
  await runPool(videoIds, 4, async (videoId) => {
    await syncArchiveParsedCache(archivesDir, videoId, { backfill: opts.backfill === true });
  });
  return rebuildArchivesIndex(archivesDir, { force: true });
}

/**
 * @param {Record<string, unknown>} meta
 * @param {ReturnType<typeof mergeMeta>} merged
 */
function toListItem(meta, merged) {
  const videoId = String(meta.videoId ?? "");
  return {
    videoId,
    title: merged.title,
    sourceUrl: merged.sourceUrl,
    author: merged.author,
    publishedAt: merged.publishedAt,
    languageLine: merged.languageLine,
    fetchedAt: merged.fetchedAt,
    charCount: merged.charCount,
    wordCount: merged.wordCount,
    hasMd: Boolean(
      meta.parsedCache && typeof meta.parsedCache === "object"
        ? /** @type {Record<string, unknown>} */ (meta.parsedCache).transcript
        : merged.charCount
    ),
    hasAnalysis: Boolean(merged.analysis && !/** @type {Record<string, unknown>} */ (merged.analysis).error),
    analyzedAt:
      merged.analysis && typeof merged.analysis === "object"
        ? /** @type {Record<string, unknown>} */ (merged.analysis).analyzedAt ?? null
        : null,
  };
}

/**
 * @template T
 * @param {T[]} items
 * @param {number} concurrency
 * @param {(item: T) => Promise<void>} fn
 */
async function runPool(items, concurrency, fn) {
  let idx = 0;
  async function worker() {
    while (idx < items.length) {
      const i = idx++;
      await fn(items[i]);
    }
  }
  const n = Math.max(1, Math.min(concurrency, items.length || 1));
  await Promise.all(Array.from({ length: n }, () => worker()));
}

/** @param {string} archivesDir @param {{ backfill?: boolean, force?: boolean, warm?: boolean }} [opts] */
export async function rebuildArchivesIndex(archivesDir, opts = {}) {
  await fs.mkdir(archivesDir, { recursive: true });
  const sourceMtimeMs = await getArchivesSourceMtimeMs(archivesDir);
  const indexPath = path.join(archivesDir, INDEX_FILENAME);

  if (!opts.force) {
    try {
      const raw = await fs.readFile(indexPath, "utf8");
      const cached = JSON.parse(stripBom(raw));
      if (
        cached?.version === INDEX_VERSION &&
        Number(cached.sourceMtimeMs) >= sourceMtimeMs &&
        Array.isArray(cached.items)
      ) {
        return cached;
      }
    } catch {
      /* rebuild */
    }
  }

  const names = await fs.readdir(archivesDir);
  const ids = new Set();
  for (const name of names) {
    if (name.endsWith(".json") && name !== INDEX_FILENAME) ids.add(name.slice(0, -5));
    else if (name.endsWith(".md")) ids.add(name.slice(0, -3));
  }

  const videoIds = [...ids].filter(isValidArchiveVideoId);
  /** @type {ReturnType<typeof toListItem>[]} */
  const items = [];
  const needWarm = opts.warm === true || opts.backfill === true;

  await runPool(videoIds, needWarm ? 4 : 12, async (videoId) => {
    if (needWarm) {
      const synced = await syncArchiveParsedCache(archivesDir, videoId, { backfill: opts.backfill === true });
      if (!synced) return;
      items.push(toListItem(synced.meta, synced.merged));
      return;
    }
    const row = await readListItemFromJson(archivesDir, videoId);
    if (row) items.push(row);
  });

  items.sort((a, b) => {
    const tb = publishSortMs(b);
    const ta = publishSortMs(a);
    if (tb !== ta) return tb - ta;
    return String(b.videoId).localeCompare(String(a.videoId));
  });

  const authors = [...new Set(items.map((x) => String(x.author ?? "").trim()).filter(Boolean))].sort((a, b) =>
    a.localeCompare(b, "zh-CN")
  );

  const index = {
    version: INDEX_VERSION,
    builtAt: new Date().toISOString(),
    sourceMtimeMs,
    authors,
    total: items.length,
    items,
  };

  await fs.writeFile(indexPath, `${JSON.stringify(index, null, 2)}\n`, "utf8");
  return index;
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
 * @param {ReturnType<typeof toListItem>[]} items
 * @param {{ author?: string, from?: string, to?: string }} opts
 */
function filterArchiveItems(items, opts) {
  const authorFilter = String(opts.author ?? "").trim().toLowerCase();
  const fromMs = parseDateBoundMs(opts.from, false);
  const toMs = parseDateBoundMs(opts.to, true);

  let filtered = authorFilter
    ? items.filter((x) => String(x.author ?? "").trim().toLowerCase() === authorFilter)
    : items;

  if (fromMs != null) {
    filtered = filtered.filter((x) => publishSortMs(x) >= fromMs);
  }
  if (toMs != null) {
    filtered = filtered.filter((x) => publishSortMs(x) <= toMs);
  }
  return filtered;
}

/**
 * @param {string} archivesDir
 * @param {{ author?: string, from?: string, to?: string, backfill?: boolean, rebuild?: boolean }} [opts]
 */
export async function listYoutubeArchives(archivesDir, opts = {}) {
  const authorFilter = String(opts.author ?? "").trim().toLowerCase();
  try {
    const index = await rebuildArchivesIndex(archivesDir, {
      force: opts.rebuild === true,
    });
    const filtered = filterArchiveItems(index.items, opts);
    return {
      ok: true,
      dir: archivesDir,
      authors: index.authors,
      total: index.total,
      items: filtered,
      cached: true,
      indexBuiltAt: index.builtAt,
      filters: {
        author: authorFilter || null,
        from: opts.from ?? null,
        to: opts.to ?? null,
      },
    };
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    if (err.code === "ENOENT") {
      return {
        ok: true,
        dir: archivesDir,
        authors: [],
        total: 0,
        items: [],
        cached: false,
        filters: { author: null, from: opts.from ?? null, to: opts.to ?? null },
      };
    }
    throw e;
  }
}

/**
 * @param {string} archivesDir
 * @param {string} videoId
 */
export async function getYoutubeArchive(archivesDir, videoId) {
  if (!isValidArchiveVideoId(videoId)) {
    return { ok: false, error: "无效的 videoId" };
  }

  const synced = await syncArchiveParsedCache(archivesDir, videoId, { backfill: false });
  if (!synced) return { ok: false, error: "归档不存在", videoId };

  const { meta, merged } = synced;
  const cache =
    meta.parsedCache && typeof meta.parsedCache === "object"
      ? /** @type {Record<string, unknown>} */ (meta.parsedCache)
      : null;
  const transcript = cache?.transcript ? String(cache.transcript) : "";

  if (!transcript) {
    return { ok: false, error: "缺少 .md 正文或解析缓存", videoId };
  }

  return {
    ok: true,
    videoId,
    title: merged.title,
    sourceUrl: merged.sourceUrl,
    languageLine: merged.languageLine,
    fetchedAt: merged.fetchedAt,
    author: merged.author ?? null,
    publishedAt: merged.publishedAt ?? null,
    lang: merged.lang ?? null,
    charCount: merged.charCount ?? transcript.length,
    wordCount: merged.wordCount ?? null,
    transcript,
    analysis: merged.analysis ?? null,
    cached: Boolean(cache?.transcript),
  };
}

/**
 * @param {string} archivesDir
 * @param {{ author?: string, from?: string, to?: string }} opts
 */
export async function purgeYoutubeArchives(archivesDir, opts = {}) {
  const index = await rebuildArchivesIndex(archivesDir, { force: true, backfill: false });
  const targets = filterArchiveItems(index.items, opts);
  /** @type {string[]} */
  const deleted = [];
  /** @type {string[]} */
  const errors = [];

  for (const item of targets) {
    const videoId = String(item.videoId);
    const jsonPath = path.join(archivesDir, `${videoId}.json`);
    const mdPath = path.join(archivesDir, `${videoId}.md`);
    try {
      await fs.unlink(jsonPath).catch((e) => {
        if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e;
      });
      await fs.unlink(mdPath).catch((e) => {
        if (/** @type {NodeJS.ErrnoException} */ (e).code !== "ENOENT") throw e;
      });
      deleted.push(videoId);
    } catch (e) {
      errors.push(`${videoId}: ${/** @type {Error} */ (e).message}`);
    }
  }

  await rebuildArchivesIndex(archivesDir, { force: true, backfill: false });

  return {
    ok: true,
    deleted,
    deletedCount: deleted.length,
    matchedCount: targets.length,
    errors,
    filters: {
      author: opts.author ?? null,
      from: opts.from ?? null,
      to: opts.to ?? null,
    },
  };
}

/**
 * @param {import('express').Express} app
 * @param {{ archivesDir: string, log: ReturnType<import('./logger.js').createLogger> }} opts
 */
export function registerYoutubeArchiveRoutes(app, opts) {
  const { archivesDir, log } = opts;
  log.info("YouTube 文稿：JSON 索引加载（列表不阻塞解析/backfill）");

  app.get("/api/youtube-archives/health", (_req, res) => {
    res.json({ ok: true, archivesDir });
  });

  app.get("/api/youtube-archives", async (req, res) => {
    try {
      const author = String(req.query.author ?? "").trim();
      const from = String(req.query.from ?? req.query.fromDate ?? "").trim();
      const to = String(req.query.to ?? req.query.toDate ?? "").trim();
      const rebuild = req.query.rebuild === "1" || req.query.rebuild === "true";
      const out = await listYoutubeArchives(archivesDir, { author, from, to, rebuild });
      res.json(out);
    } catch (e) {
      log.warn(`list archives: ${/** @type {Error} */ (e).message}`);
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.post("/api/youtube-archives/rebuild", async (req, res) => {
    try {
      const backfill = req.query.backfill === "1" || req.body?.backfill === true;
      const warm = req.query.warm === "1" || req.body?.warm === true || backfill;
      if (warm || backfill) {
        res.json({ ok: true, async: true, message: "后台预热中" });
        void warmArchivesParsedCache(archivesDir, { backfill }).catch((e) => {
          log.warn(`warm archives: ${/** @type {Error} */ (e).message}`);
        });
        return;
      }
      const index = await rebuildArchivesIndex(archivesDir, { force: true });
      res.json({ ok: true, total: index.total, builtAt: index.builtAt });
    } catch (e) {
      log.warn(`rebuild archives index: ${/** @type {Error} */ (e).message}`);
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.delete("/api/youtube-archives", async (req, res) => {
    try {
      const author = String(req.query.author ?? req.body?.author ?? "").trim();
      const from = String(req.query.from ?? req.body?.from ?? "").trim();
      const to = String(req.query.to ?? req.body?.to ?? "").trim();
      if (!author && !from && !to) {
        res.status(400).json({ ok: false, error: "请指定作者或发布日期范围后再清空" });
        return;
      }
      const out = await purgeYoutubeArchives(archivesDir, { author, from, to });
      res.json(out);
    } catch (e) {
      log.warn(`purge archives: ${/** @type {Error} */ (e).message}`);
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
