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
 * @param {Record<string, unknown> | null | undefined} [analysis]
 */
export function buildArchivePayload(parsed, videoId, lang, analysis = null) {
  const title = (parsed.title ?? videoId).replace(/^Transcript:\s*/i, "").trim();
  const fetchedAt = new Date().toISOString();
  const transcript = String(parsed.transcript ?? "").trim();
  const languageLine = parsed.languageLine ?? null;

  const mdParts = [
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
  ];

  /** @type {Record<string, unknown>} */
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

  if (analysis && typeof analysis === "object") {
    meta.analysis = analysis;
    const summary = Array.isArray(analysis.parsed?.summary)
      ? analysis.parsed.summary.map((s) => `- ${s}`).join("\n")
      : "";
    const raw = typeof analysis.raw === "string" ? analysis.raw.trim() : "";
    mdParts.push("## Analysis", "");
    if (summary) {
      mdParts.push("### Summary", "", summary, "");
    }
    if (raw) {
      mdParts.push("### Model output", "", raw, "");
    }
  }

  return { md: mdParts.join("\n"), meta };
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

/**
 * @param {string} md
 */
export function extractTranscriptFromMd(md) {
  const text = String(md ?? "");
  const m = text.match(/## Transcript\s*\r?\n([\s\S]*?)(?:\r?\n## |\s*$)/);
  return m ? m[1].trim() : text.trim();
}

/**
 * @param {string} archivesDir
 * @param {string} videoId
 */
export async function readArchiveMeta(archivesDir, videoId) {
  const jsonPath = path.join(archivesDir, `${videoId}.json`);
  const raw = await fs.readFile(jsonPath, "utf8");
  return /** @type {Record<string, unknown>} */ (JSON.parse(raw));
}

/**
 * @param {string} archivesDir
 * @param {string} videoId
 */
export async function readArchiveTranscript(archivesDir, videoId) {
  const mdPath = path.join(archivesDir, `${videoId}.md`);
  const md = await fs.readFile(mdPath, "utf8");
  return extractTranscriptFromMd(md);
}
