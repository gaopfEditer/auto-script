#!/usr/bin/env node
/**
 * HTTP API：通过 CDP 附着 Chrome，在 youtube-transcript.ai 上下文中拉取 YouTube 文字稿。
 *
 * 环境变量：
 *   CDP_CONNECT_URL=http://127.0.0.1:9222
 *   YOUTUBE_FETCH_PORT=3920
 *
 * 接口：
 *   GET  /health
 *   GET  /api/transcript?url=...&lang=en
 *   GET  /api/transcript/:videoId?lang=en
 *   POST /api/transcript  { "url": "...", "videoId": "...", "lang": "en", "raw": false }
 *   POST /api/queue       { "url": "...", "urls": ["..."], "lang": "en" }
 *   GET  /api/queue       ?limit=80
 */
import express from "express";

import { CdpTranscriptClient } from "./cdp-client.js";
import { config } from "./config.js";
import { createDealVideoWsClient } from "./deal-video-ws-client.js";
import { createFetchQueue } from "./fetch-queue.js";
import { createTranscriptFetcher } from "./fetch-transcript.js";
import { createLogger, setLogLevel } from "./logger.js";
import { parseYouTubeVideoId } from "./video-id.js";

setLogLevel(config.logLevel);
const log = createLogger("server");

const client = new CdpTranscriptClient({
  cdpUrl: config.cdpConnectUrl,
  siteUrl: config.transcriptSite,
  timeoutMs: config.fetchTimeoutMs,
  log: createLogger("cdp"),
});

const { fetchAndArchive, fetchTranscript, analyzeArchive } = createTranscriptFetcher({
  client,
  archivesDir: config.archivesDir,
  log: createLogger("fetch"),
  analyze: {
    enabled: config.analyzeEnabled,
    chatUrl: config.ollamaChatUrl,
    model: config.ollamaModel,
    promptTemplate: config.analyzePromptTemplate,
    timeoutMs: config.analyzeTimeoutMs,
    maxChars: config.analyzeMaxTranscriptChars,
    deepseekApiKey: config.deepseekApiKey,
    deepseekModel: config.deepseekModel,
    deepseekApiUrl: config.deepseekApiUrl,
  },
});

const queue = createFetchQueue({
  archivesDir: config.archivesDir,
  log: createLogger("queue"),
  fetchAndArchive: async (videoId, lang, options) => {
    const out = await fetchAndArchive(videoId, lang, options);
    return { title: out.title, analysis: out.analysis };
  },
});

/** @param {unknown} meta */
function analyzeFromMeta(meta) {
  if (!meta || typeof meta !== "object") return config.dealVideoAnalyzeOnTask;
  const m = /** @type {Record<string, unknown>} */ (meta);
  if (m.analyze === true || m.analyze === "1") return true;
  if (m.analyze === false || m.analyze === "0") return false;
  return config.dealVideoAnalyzeOnTask;
}

/** @param {unknown} meta */
function langFromMeta(meta) {
  if (!meta || typeof meta !== "object") return undefined;
  const lang = /** @type {Record<string, unknown>} */ (meta).lang;
  return typeof lang === "string" && lang.trim() ? lang.trim() : undefined;
}

const dealVideoWs = createDealVideoWsClient({
  wsUrl: config.dealVideoWsUrl,
  enabled: config.dealVideoWsEnabled,
  clientName: config.dealVideoClientName,
  analyzeOnTask: config.dealVideoAnalyzeOnTask,
  reconnectMs: config.dealVideoWsReconnectMs,
  reportResult: config.dealVideoWsReportResult,
  log: createLogger("deal-video-ws"),
  onTask: async ({ videoUrl, meta }) => {
    const lang = langFromMeta(meta);
    const analyze = analyzeFromMeta(meta);
    const result = await queue.enqueueAndWait({ url: videoUrl, lang, analyze });
    if (!result.ok) {
      return { ok: false, error: result.error ?? "enqueue failed", videoUrl };
    }
    const job = result.job;
    if (job?.status === "failed") {
      return {
        ok: false,
        videoUrl,
        videoId: job.videoId,
        error: job.error ?? "fetch failed",
        status: job.status,
      };
    }
    return {
      ok: true,
      videoUrl,
      videoId: job?.videoId,
      title: job?.title ?? null,
      queued: Boolean(result.queued),
      skipped: Boolean(result.skipped),
      duplicate: Boolean(result.duplicate),
      status: job?.status,
    };
  },
});

const app = express();
app.use(express.json({ limit: "256kb" }));

/**
 * @param {import('express').Request} req
 */
function readLang(req) {
  const q = req.query.lang;
  if (typeof q === "string" && q.trim()) return q.trim();
  const b = req.body?.lang;
  if (typeof b === "string" && b.trim()) return b.trim();
  return undefined;
}

/**
 * @param {import('express').Request} req
 */
function readVideoInput(req) {
  const fromParam = req.params.videoId;
  if (fromParam) return String(fromParam);
  const q = req.query.url ?? req.query.videoId ?? req.query.v;
  if (typeof q === "string" && q.trim()) return q.trim();
  const b = req.body?.url ?? req.body?.videoId ?? req.body?.v;
  if (typeof b === "string" && b.trim()) return b.trim();
  return "";
}

/**
 * @param {import('express').Request} req
 */
function readSave(req) {
  const q = req.query.save;
  if (q === "1" || q === "true") return true;
  return req.body?.save === true || req.body?.save === "1";
}

/**
 * @param {import('express').Request} req
 */
function readAnalyze(req) {
  const q = req.query.analyze;
  if (q === "1" || q === "true") return true;
  if (q === "0" || q === "false") return false;
  const b = req.body?.analyze;
  if (b === true || b === "1") return true;
  if (b === false || b === "0") return false;
  return config.analyzeEnabled;
}

/**
 * @param {string} input
 * @param {string | undefined} lang
 * @param {boolean} rawOnly
 * @param {boolean} save
 * @param {boolean} analyze
 */
async function handleTranscript(input, lang, rawOnly, save, analyze) {
  const videoId = parseYouTubeVideoId(input);
  if (!videoId) {
    return { status: 400, body: { ok: false, error: "无法解析 YouTube video id", input } };
  }
  if (!client.ready) {
    return { status: 503, body: { ok: false, error: "CDP 未就绪，请确认 Chrome 已开启 remote debugging" } };
  }

  try {
    if (rawOnly) {
      const markdown = await client.fetchTranscriptText(videoId, lang);
      return {
        status: 200,
        body: { ok: true, videoId, lang: lang ?? null, format: "markdown", text: markdown },
      };
    }
    const out = await fetchTranscript(videoId, lang, save, { analyze });
    return {
      status: 200,
      body: {
        ok: true,
        videoId,
        lang: lang ?? null,
        title: out.title,
        sourceUrl: out.sourceUrl,
        languageLine: out.languageLine,
        charCount: out.charCount,
        wordCount: out.wordCount,
        transcript: out.transcript,
        analysis: out.analysis,
        saved: out.saved ? { md: out.saved.mdPath, json: out.saved.jsonPath } : null,
      },
    };
  } catch (e) {
    const err = /** @type {Error} */ (e);
    log.warn(`拉取失败 videoId=${videoId}: ${err.message}`);
    return { status: 502, body: { ok: false, error: err.message, videoId } };
  }
}

app.get("/health", (_req, res) => {
  res.json({
    ok: true,
    cdpReady: client.ready,
    cdpUrl: config.cdpConnectUrl,
    site: config.transcriptSite,
    analyze: {
      enabledDefault: config.analyzeEnabled,
      chatUrl: config.ollamaChatUrl,
      model: config.ollamaModel,
      deepseekConfigured: Boolean(config.deepseekApiKey),
      deepseekModel: config.deepseekModel,
    },
    dealVideoWs: {
      enabled: config.dealVideoWsEnabled,
      url: config.dealVideoWsUrl,
      clientId: dealVideoWs.getClientId(),
    },
    queue: queue.snapshot(),
  });
});

app.get("/api/transcript/:videoId", async (req, res) => {
  const rawOnly = req.query.raw === "1" || req.query.raw === "true";
  const out = await handleTranscript(
    readVideoInput(req),
    readLang(req),
    rawOnly,
    readSave(req),
    readAnalyze(req)
  );
  res.status(out.status).json(out.body);
});

app.get("/api/transcript", async (req, res) => {
  const input = readVideoInput(req);
  if (!input) {
    res.status(400).json({ ok: false, error: "缺少 url / videoId 查询参数" });
    return;
  }
  const rawOnly = req.query.raw === "1" || req.query.raw === "true";
  const out = await handleTranscript(input, readLang(req), rawOnly, readSave(req), readAnalyze(req));
  res.status(out.status).json(out.body);
});

app.post("/api/transcript", async (req, res) => {
  const input = readVideoInput(req);
  if (!input) {
    res.status(400).json({ ok: false, error: "请求体需包含 url 或 videoId" });
    return;
  }
  const rawOnly = req.body?.raw === true || req.body?.raw === "1";
  const out = await handleTranscript(input, readLang(req), rawOnly, readSave(req), readAnalyze(req));
  res.status(out.status).json(out.body);
});

app.post("/api/analyze/:videoId", async (req, res) => {
  const videoId = String(req.params.videoId ?? "").trim();
  if (!videoId) {
    res.status(400).json({ ok: false, error: "缺少 videoId" });
    return;
  }
  try {
    const out = await analyzeArchive(videoId, readLang(req));
    res.json({
      ok: true,
      videoId: out.videoId,
      title: out.title,
      analysis: out.analysis,
      saved: { md: out.saved.mdPath, json: out.saved.jsonPath },
    });
  } catch (e) {
    const err = /** @type {Error} */ (e);
    const status = err.message.includes("ENOENT") ? 404 : 502;
    res.status(status).json({ ok: false, error: err.message, videoId });
  }
});

app.post("/api/queue", async (req, res) => {
  const lang = readLang(req);
  const analyze = readAnalyze(req);
  const urls = [];
  if (typeof req.body?.url === "string" && req.body.url.trim()) {
    urls.push(req.body.url.trim());
  }
  if (Array.isArray(req.body?.urls)) {
    for (const u of req.body.urls) {
      if (typeof u === "string" && u.trim()) urls.push(u.trim());
    }
  }
  if (urls.length === 0) {
    res.status(400).json({ ok: false, error: "请求体需包含 url 或 urls[]" });
    return;
  }

  const results = await queue.enqueueMany(urls, lang ?? null, analyze);
  const invalid = results.filter((r) => !r.ok);
  res.status(invalid.length === results.length ? 400 : 200).json({
    ok: invalid.length < results.length,
    results,
    queue: queue.snapshot(),
  });
});

app.get("/api/queue", (req, res) => {
  const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 80));
  res.json({ ok: true, ...queue.listJobs(limit) });
});

async function main() {
  await client.connect();
  dealVideoWs.start();
  app.listen(config.port, () => {
    log.info(`HTTP API http://127.0.0.1:${config.port}`);
    log.info(`示例: GET http://127.0.0.1:${config.port}/api/transcript?url=https://www.youtube.com/watch?v=dQw4w9WgXcQ`);
    log.info(`队列: POST http://127.0.0.1:${config.port}/api/queue  { "urls": ["..."] }`);
    if (config.dealVideoWsEnabled) {
      log.info(`deal-video WS: ${config.dealVideoWsUrl}`);
    }
  });
}

function shutdown() {
  dealVideoWs.stop();
  void client.close().finally(() => process.exit(0));
}

process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

main().catch((e) => {
  log.error(/** @type {Error} */ (e).message);
  process.exit(1);
});
