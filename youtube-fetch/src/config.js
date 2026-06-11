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
};
