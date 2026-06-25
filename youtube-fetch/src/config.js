import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";

const _root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
dotenv.config({ path: path.join(_root, ".env") });
dotenv.config({ path: path.join(_root, "youtube-fetch", ".env") });

function normalizeCdpUrl(raw) {
  const s = (raw ?? "").trim() || "http://127.0.0.1:9222";
  return s.replace(/\/$/, "");
}

function envBool(name, defaultOn = false) {
  const raw = process.env[name];
  if (raw == null || raw === "") return defaultOn;
  return ["1", "true", "yes", "on"].includes(String(raw).trim().toLowerCase());
}

function loadPromptTemplate() {
  const file = (process.env.YOUTUBE_ANALYZE_PROMPT_FILE ?? "").trim();
  if (file) {
    try {
      return fs.readFileSync(path.isAbsolute(file) ? file : path.join(_root, file), "utf8");
    } catch {
      /* fall through */
    }
  }
  const inline = (process.env.YOUTUBE_ANALYZE_PROMPT ?? "").trim();
  return inline || undefined;
}

export const config = {
  cdpConnectUrl: normalizeCdpUrl(process.env.CDP_CONNECT_URL),
  port: Number(process.env.YOUTUBE_FETCH_PORT ?? 3920),
  transcriptSite: (process.env.YOUTUBE_TRANSCRIPT_SITE ?? "https://youtube-transcript.ai").replace(/\/$/, ""),
  archivesDir: path.resolve(
    _root,
    (process.env.YOUTUBE_ARCHIVES_DIR ?? "youtube-fetch/archives").replace(/\\/g, "/")
  ),
  fetchTimeoutMs: Number(process.env.YOUTUBE_FETCH_TIMEOUT_MS ?? 90_000),
  logLevel: (process.env.YOUTUBE_FETCH_LOG_LEVEL ?? process.env.LOG_LEVEL ?? "info").toLowerCase(),
  ollamaChatUrl: (process.env.OLLAMA_CHAT_URL ?? "http://127.0.0.1:8000/ollama/chat").trim(),
  ollamaModel: (process.env.OLLAMA_MODEL ?? "gemma4:26b").trim(),
  deepseekApiKey: (process.env.DEEPSEEK_API_KEY ?? "").trim(),
  deepseekModel: (process.env.DEEPSEEK_MODEL ?? "deepseek-chat").trim(),
  deepseekApiUrl: (process.env.DEEPSEEK_API_URL ?? "https://api.deepseek.com").trim().replace(/\/$/, ""),
  analyzeEnabled: envBool("YOUTUBE_ANALYZE", false),
  analyzeTimeoutMs: Number(process.env.YOUTUBE_ANALYZE_TIMEOUT_MS ?? 120_000),
  analyzePromptTemplate: loadPromptTemplate(),
  analyzeMaxTranscriptChars: Number(process.env.YOUTUBE_ANALYZE_MAX_CHARS ?? 14_000),
  dealVideoWsEnabled: envBool("DEAL_VIDEO_WS_ENABLED", true),
  dealVideoWsUrl: (
    process.env.DEAL_VIDEO_WS_URL ?? "ws://127.0.0.1:3123/api/ws?type=deal-video"
  ).trim(),
  dealVideoWsReconnectMs: Number(process.env.DEAL_VIDEO_WS_RECONNECT_MS ?? 5_000),
  dealVideoClientName: (process.env.DEAL_VIDEO_CLIENT_NAME ?? "youtube-fetch").trim(),
  dealVideoAnalyzeOnTask: envBool("DEAL_VIDEO_ANALYZE", envBool("YOUTUBE_ANALYZE", false)),
  dealVideoWsReportResult: envBool("DEAL_VIDEO_WS_REPORT_RESULT", true),
};
