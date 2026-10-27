#!/usr/bin/env node
/**
 * 启动前释放占用端口（macOS / Linux：lsof + kill -9）。
 * 用法：node scripts/free-port.js [port]
 */
import { execSync } from "node:child_process";

const port = String(process.argv[2] ?? process.env.YOUTUBE_FETCH_PORT ?? "3920").trim();
if (!/^\d+$/.test(port)) {
  console.error(`[free-port] 无效端口: ${port}`);
  process.exit(1);
}

try {
  const out = execSync(`lsof -nP -iTCP:${port} -sTCP:LISTEN -t`, { encoding: "utf8" }).trim();
  const pids = [...new Set(out.split(/\s+/).filter(Boolean))];
  for (const pid of pids) {
    try {
      execSync(`kill -9 ${pid}`);
      console.log(`[free-port] 已结束 PID ${pid}（端口 ${port}）`);
    } catch (e) {
      console.warn(`[free-port] 无法结束 PID ${pid}: ${/** @type {Error} */ (e).message}`);
    }
  }
} catch {
  /* 端口未被占用 */
}
