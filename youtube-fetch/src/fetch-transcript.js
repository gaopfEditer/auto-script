import {
  buildArchivePayload,
  readArchiveMeta,
  readArchiveTranscript,
  writeArchiveFiles,
} from "./archive.js";
import { analyzeTranscriptWithOllama } from "./ollama-analyze.js";
import { parseTranscriptMarkdown } from "./parse-transcript.js";

/**
 * @param {{
 *   client: import('./cdp-client.js').CdpTranscriptClient,
 *   archivesDir: string,
 *   log: ReturnType<import('./logger.js').createLogger>,
 *   analyze?: {
 *     enabled: boolean,
 *     chatUrl: string,
 *     model: string,
 *     promptTemplate?: string,
 *     timeoutMs: number,
 *   },
 * }} deps
 */
export function createTranscriptFetcher(deps) {
  const { client, archivesDir, log, analyze } = deps;

  /**
   * @param {{ title?: string | null, transcript: string }} parsed
   * @param {boolean | undefined} explicitAnalyze
   */
  async function maybeAnalyze(parsed, explicitAnalyze) {
    const enabled = explicitAnalyze ?? analyze?.enabled ?? false;
    if (!enabled || !analyze) return null;
    const transcript = String(parsed.transcript ?? "").trim();
    if (!transcript) return null;
    try {
      return await analyzeTranscriptWithOllama({
        transcript,
        title: parsed.title ?? undefined,
        chatUrl: analyze.chatUrl,
        model: analyze.model,
        promptTemplate: analyze.promptTemplate,
        timeoutMs: analyze.timeoutMs,
        log,
      });
    } catch (e) {
      const msg = /** @type {Error} */ (e).message;
      log.warn(`Ollama 分析失败: ${msg}`);
      return {
        model: analyze.model,
        analyzedAt: new Date().toISOString(),
        error: msg,
        raw: null,
        parsed: null,
      };
    }
  }

  /**
   * @param {string} videoId
   * @param {string | undefined} lang
   * @param {{ analyze?: boolean }} [options]
   */
  async function fetchAndArchive(videoId, lang, options = {}) {
    if (!client.ready) throw new Error("CDP 未就绪，请确认 Chrome 已开启 remote debugging");
    const markdown = await client.fetchTranscriptText(videoId, lang);
    const parsed = parseTranscriptMarkdown(markdown, videoId);
    const analysis = await maybeAnalyze(parsed, options.analyze);
    const archive = buildArchivePayload(parsed, videoId, lang, analysis);
    const saved = await writeArchiveFiles(archivesDir, videoId, archive);
    log.info(`已归档 ${videoId} → ${saved.mdPath}`);
    return {
      videoId,
      title: archive.meta.title,
      sourceUrl: archive.meta.sourceUrl,
      languageLine: archive.meta.languageLine,
      charCount: archive.meta.charCount,
      wordCount: archive.meta.wordCount,
      analysis,
      saved,
    };
  }

  /**
   * @param {string} videoId
   * @param {string | undefined} lang
   * @param {boolean} save
   * @param {{ analyze?: boolean }} [options]
   */
  async function fetchTranscript(videoId, lang, save, options = {}) {
    if (!client.ready) throw new Error("CDP 未就绪，请确认 Chrome 已开启 remote debugging");
    const markdown = await client.fetchTranscriptText(videoId, lang);
    const parsed = parseTranscriptMarkdown(markdown, videoId);
    const analysis = await maybeAnalyze(parsed, options.analyze);
    const archive = buildArchivePayload(parsed, videoId, lang, analysis);
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
      analysis,
      saved,
    };
  }

  /**
   * 对已归档文稿重新调用 Ollama，更新 archives/{videoId}.*
   * @param {string} videoId
   * @param {string | null | undefined} lang
   */
  async function analyzeArchive(videoId, lang) {
    const meta = await readArchiveMeta(archivesDir, videoId);
    const transcript = await readArchiveTranscript(archivesDir, videoId);
    if (!transcript) throw new Error("归档中无文字稿正文");
    const parsed = {
      title: typeof meta.title === "string" ? meta.title : videoId,
      sourceUrl: typeof meta.sourceUrl === "string" ? meta.sourceUrl : `https://www.youtube.com/watch?v=${videoId}`,
      languageLine: typeof meta.languageLine === "string" ? meta.languageLine : null,
      transcript,
    };
    const analysis = await maybeAnalyze(parsed, true);
    if (!analysis) throw new Error("分析未启用或未配置 Ollama");
    const archive = buildArchivePayload(parsed, videoId, lang ?? (typeof meta.lang === "string" ? meta.lang : null), analysis);
    const saved = await writeArchiveFiles(archivesDir, videoId, archive);
    log.info(`已更新分析 ${videoId} → ${saved.jsonPath}`);
    return { videoId, title: archive.meta.title, analysis, saved };
  }

  return { fetchAndArchive, fetchTranscript, analyzeArchive };
}
