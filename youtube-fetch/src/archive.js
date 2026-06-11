import fs from "node:fs/promises";
import path from "node:path";

/** @param {string} raw */
export function stripBom(raw) {
  return raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw;
}

/**
 * @param {string} languageLine
 */
export function wordCountFromLanguageLine(languageLine) {
  const m = String(languageLine ?? "").match(/Words:\s*(\d+)/i);
  return m ? Number(m[1]) : null;
}

/**
 * @param {{ title: string | null, sourceUrl: string, languageLine: string | null, transcript: string }} parsed
 * @param {string} videoId
 * @param {string | null | undefined} lang
 */
export function buildArchivePayload(parsed, videoId, lang) {
  const title = (parsed.title ?? videoId).replace(/^Transcript:\s*/i, "").trim();
  const fetchedAt = new Date().toISOString();
  const transcript = String(parsed.transcript ?? "").trim();
  const languageLine = parsed.languageLine ?? null;

  const md = [
    `# ${title}`,
    "",
    `Source: ${parsed.sourceUrl}`,
    languageLine ? `Language: ${languageLine}` : "Language: —",
    `Fetched: ${fetchedAt}`,
    "",
    "## Transcript",
    "",
    transcript,
    "",
  ].join("\n");

  const meta = {
    videoId,
    title,
    sourceUrl: parsed.sourceUrl,
    languageLine,
    lang: lang ?? null,
    fetchedAt,
    charCount: transcript.length,
    wordCount: wordCountFromLanguageLine(languageLine),
  };

  return { md, meta };
}

/**
 * @param {string} archivesDir
 * @param {string} videoId
 * @param {{ md: string, meta: Record<string, unknown> }} payload
 */
export async function writeArchiveFiles(archivesDir, videoId, payload) {
  await fs.mkdir(archivesDir, { recursive: true });
  const mdPath = path.join(archivesDir, `${videoId}.md`);
  const jsonPath = path.join(archivesDir, `${videoId}.json`);
  await fs.writeFile(mdPath, payload.md, "utf8");
  await fs.writeFile(jsonPath, `${JSON.stringify(payload.meta, null, 2)}\n`, "utf8");
  return { mdPath, jsonPath };
}
