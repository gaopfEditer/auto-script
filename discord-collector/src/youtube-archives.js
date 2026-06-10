import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

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
  let fetchedAt = null;
  for (const line of lines.slice(1, 12)) {
    if (line.startsWith("Source:")) sourceUrl = line.slice("Source:".length).trim();
    if (line.startsWith("Language:")) languageLine = line.slice("Language:".length).trim();
    if (line.startsWith("Fetched:")) fetchedAt = line.slice("Fetched:".length).trim();
  }

  const idx = text.indexOf("\n## Transcript\n");
  const transcript = idx >= 0 ? text.slice(idx + "\n## Transcript\n".length).trim() : "";

  return { title, sourceUrl, languageLine, fetchedAt, transcript };
}

/**
 * @param {Record<string, unknown>} meta
 * @param {ReturnType<typeof parseArchiveMd>} mdParsed
 */
function mergeMeta(meta, mdParsed) {
  return {
    title: String(meta.title ?? mdParsed.title ?? meta.videoId ?? ""),
    sourceUrl: String(meta.sourceUrl ?? mdParsed.sourceUrl ?? ""),
    languageLine: meta.languageLine ?? mdParsed.languageLine ?? null,
    fetchedAt: meta.fetchedAt ?? mdParsed.fetchedAt ?? null,
    lang: meta.lang ?? null,
    charCount: meta.charCount ?? mdParsed.transcript.length,
    wordCount: meta.wordCount ?? null,
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

  let mdParsed = { title: null, sourceUrl: null, languageLine: null, fetchedAt: null, transcript: "" };
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
 * @param {string} archivesDir
 */
export async function listYoutubeArchives(archivesDir) {
  let names;
  try {
    names = await fs.readdir(archivesDir);
  } catch (e) {
    const err = /** @type {NodeJS.ErrnoException} */ (e);
    if (err.code === "ENOENT") return { ok: true, dir: archivesDir, items: [] };
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
    items.push({
      videoId: row.videoId,
      title: row.title,
      sourceUrl: row.sourceUrl,
      languageLine: row.languageLine,
      fetchedAt: row.fetchedAt,
      charCount: row.charCount,
      wordCount: row.wordCount,
      hasMd: row.hasMd,
    });
  }

  items.sort((a, b) => {
    const ta = a.fetchedAt ? Date.parse(String(a.fetchedAt)) : 0;
    const tb = b.fetchedAt ? Date.parse(String(b.fetchedAt)) : 0;
    if (tb !== ta) return tb - ta;
    return String(b.videoId).localeCompare(String(a.videoId));
  });

  return { ok: true, dir: archivesDir, items };
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
    lang: row.lang ?? null,
    charCount: row.charCount ?? parsed.transcript.length,
    wordCount: row.wordCount ?? null,
    transcript: parsed.transcript,
  };
}

/**
 * @param {import('express').Express} app
 * @param {{ archivesDir: string, log: ReturnType<import('./logger.js').createLogger> }} opts
 */
export function registerYoutubeArchiveRoutes(app, opts) {
  const { archivesDir, log } = opts;

  app.get("/api/youtube-archives", async (_req, res) => {
    try {
      const out = await listYoutubeArchives(archivesDir);
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
