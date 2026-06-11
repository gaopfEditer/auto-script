import { buildArchivePayload, writeArchiveFiles } from "./archive.js";
import { parseTranscriptMarkdown } from "./parse-transcript.js";

/**
 * @param {{
 *   client: import('./cdp-client.js').CdpTranscriptClient,
 *   archivesDir: string,
 *   log: ReturnType<import('./logger.js').createLogger>,
 * }} deps
 */
export function createTranscriptFetcher(deps) {
  const { client, archivesDir, log } = deps;

  /**
   * @param {string} videoId
   * @param {string | undefined} lang
   */
  async function fetchAndArchive(videoId, lang) {
    if (!client.ready) throw new Error("CDP 未就绪，请确认 Chrome 已开启 remote debugging");
    const markdown = await client.fetchTranscriptText(videoId, lang);
    const parsed = parseTranscriptMarkdown(markdown, videoId);
    const archive = buildArchivePayload(parsed, videoId, lang);
    const saved = await writeArchiveFiles(archivesDir, videoId, archive);
    log.info(`已归档 ${videoId} → ${saved.mdPath}`);
    return {
      videoId,
      title: archive.meta.title,
      sourceUrl: archive.meta.sourceUrl,
      languageLine: archive.meta.languageLine,
      charCount: archive.meta.charCount,
      wordCount: archive.meta.wordCount,
      saved,
    };
  }

  /**
   * @param {string} videoId
   * @param {string | undefined} lang
   * @param {boolean} save
   */
  async function fetchTranscript(videoId, lang, save) {
    if (!client.ready) throw new Error("CDP 未就绪，请确认 Chrome 已开启 remote debugging");
    const markdown = await client.fetchTranscriptText(videoId, lang);
    const parsed = parseTranscriptMarkdown(markdown, videoId);
    const archive = buildArchivePayload(parsed, videoId, lang);
    let saved = null;
    if (save) {
      saved = await writeArchiveFiles(archivesDir, videoId, archive);
      log.info(`已归档 ${videoId} → ${saved.mdPath}`);
    }
    return {
      videoId,
      title: archive.meta.title,
      sourceUrl: archive.meta.sourceUrl,
      languageLine: archive.meta.languageLine,
      charCount: archive.meta.charCount,
      wordCount: archive.meta.wordCount,
      transcript: parsed.transcript,
      saved,
    };
  }

  return { fetchAndArchive, fetchTranscript };
}
