/**
 * 固定从 discord-collector/.env 加载（不依赖 cwd，避免误读上级目录 .env）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

const _dir = path.dirname(fileURLToPath(import.meta.url));
const envPath = path.join(_dir, "..", ".env");

dotenv.config({ path: envPath, override: true });

/**
 * 本机 CDP(9222) / oi / collect:ui 绝不能走 HTTP(S)_PROXY。
 * 否则 Playwright connectOverCDP 会经 Clash 访问 127.0.0.1 并收到 400：
 * “Unexpected status 400 … /json/version/ … does not look like a DevTools server”
 */
const LOCAL_NO_PROXY = [
  "127.0.0.1",
  "localhost",
  "::1",
  "0.0.0.0",
  "*.local",
];
for (const key of ["NO_PROXY", "no_proxy"]) {
  const cur = String(process.env[key] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const merged = [...new Set([...LOCAL_NO_PROXY, ...cur])];
  process.env[key] = merged.join(",");
}
