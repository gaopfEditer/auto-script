#!/usr/bin/env node
/**
 * 确认 oi:ui:build 产物是 OI React，而不是误拷的 collector-ui 主站。
 */
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const indexPath = resolve(root, "oi_mornitor/public/oi-dist/index.html");

let html = "";
try {
  html = readFileSync(indexPath, "utf8");
} catch {
  console.error(`[verify-oi-dist] 未找到 ${indexPath}，请先 pnpm run oi:ui:build`);
  process.exit(1);
}

const mtime = statSync(indexPath).mtime.toISOString();
const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? "";

if (/discord-collector/i.test(title)) {
  console.error(
    `[verify-oi-dist] 错误：oi-dist 是主站「${title}」，不是 OI。\n` +
      `  勿再运行 scripts/copy-collector-ui-to-oi-dist.mjs。\n` +
      `  正确路径：oi_mornitor/public/oi-dist/（pnpm run oi:ui:build）`
  );
  process.exit(1);
}

if (!/OI/i.test(title)) {
  console.warn(`[verify-oi-dist] 警告：title 异常「${title}」`);
}

const js = html.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1] ?? "?";
console.info(`[verify-oi-dist] OK  title=${title}  js=${js}  mtime=${mtime}`);
console.info(
  `[verify-oi-dist] 部署 op.b：rsync public/oi-dist/ 或 oi_mornitor/public/oi-dist/ → 独立站点根目录`
);
