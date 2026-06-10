import { archiveExists } from "./archive-exists.js";
import { parseYouTubeVideoId } from "./video-id.js";

/**
 * @typedef {'pending'|'running'|'skipped'|'done'|'failed'} JobStatus
 * @typedef {{
 *   id: number,
 *   videoId: string,
 *   url: string,
 *   lang: string | null,
 *   status: JobStatus,
 *   reason?: string,
 *   title?: string | null,
 *   error?: string,
 *   enqueuedAt: string,
 *   startedAt?: string,
 *   finishedAt?: string,
 * }} FetchJob
 */

/**
 * @param {{
 *   archivesDir: string,
 *   log: ReturnType<import('./logger.js').createLogger>,
 *   fetchAndArchive: (videoId: string, lang?: string) => Promise<{ title: string | null }>,
 *   maxHistory?: number,
 * }} opts
 */
export function createFetchQueue(opts) {
  const { archivesDir, log, fetchAndArchive, maxHistory = 200 } = opts;
  /** @type {FetchJob[]} */
  const jobs = [];
  let seq = 0;
  /** @type {Promise<void>} */
  let chain = Promise.resolve();
  /** @type {FetchJob | null} */
  let running = null;

  function trimHistory() {
    if (jobs.length > maxHistory) jobs.length = maxHistory;
  }

  /**
   * @param {FetchJob} job
   */
  async function runJob(job) {
    running = job;
    job.status = "running";
    job.startedAt = new Date().toISOString();
    log.info(`队列开始 #${job.id} ${job.videoId}`);
    try {
      const out = await fetchAndArchive(job.videoId, job.lang ?? undefined);
      job.status = "done";
      job.title = out.title ?? null;
      job.finishedAt = new Date().toISOString();
      log.info(`队列完成 #${job.id} ${job.videoId}`);
    } catch (e) {
      job.status = "failed";
      job.error = /** @type {Error} */ (e).message;
      job.finishedAt = new Date().toISOString();
      log.warn(`队列失败 #${job.id} ${job.videoId}: ${job.error}`);
    } finally {
      running = null;
    }
  }

  /**
   * @param {{ url: string, lang?: string | null }} input
   */
  async function enqueue(input) {
    const rawUrl = String(input.url ?? "").trim();
    const videoId = parseYouTubeVideoId(rawUrl);
    if (!videoId) {
      return {
        ok: false,
        error: "无法解析 YouTube video id",
        url: rawUrl,
      };
    }

    const lang = input.lang ?? null;
    const canonicalUrl = rawUrl.includes("youtube") || rawUrl.includes("youtu.be")
      ? rawUrl
      : `https://www.youtube.com/watch?v=${videoId}`;

    if (await archiveExists(archivesDir, videoId)) {
      const job = /** @type {FetchJob} */ ({
        id: ++seq,
        videoId,
        url: canonicalUrl,
        lang,
        status: "skipped",
        reason: "archived",
        enqueuedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
      });
      jobs.unshift(job);
      trimHistory();
      return { ok: true, queued: false, skipped: true, job };
    }

    const dup = jobs.find(
      (j) => j.videoId === videoId && (j.status === "pending" || j.status === "running")
    );
    if (dup) {
      return { ok: true, queued: false, duplicate: true, job: dup };
    }

    const job = /** @type {FetchJob} */ ({
      id: ++seq,
      videoId,
      url: canonicalUrl,
      lang,
      status: "pending",
      enqueuedAt: new Date().toISOString(),
    });
    jobs.unshift(job);
    trimHistory();

    chain = chain.then(() => runJob(job));
    return { ok: true, queued: true, job };
  }

  /**
   * @param {string[]} urls
   * @param {string | null | undefined} lang
   */
  async function enqueueMany(urls, lang) {
    const results = [];
    for (const url of urls) {
      results.push(await enqueue({ url, lang }));
    }
    return results;
  }

  function snapshot() {
    const pending = jobs.filter((j) => j.status === "pending").length;
    const runningCount = running ? 1 : 0;
    return {
      pending,
      running: runningCount,
      runningJobId: running?.id ?? null,
      total: jobs.length,
    };
  }

  /**
   * @param {number} [limit]
   */
  function listJobs(limit = 80) {
    return {
      ...snapshot(),
      jobs: jobs.slice(0, Math.max(1, Math.min(500, limit))),
    };
  }

  return { enqueue, enqueueMany, listJobs, snapshot };
}
