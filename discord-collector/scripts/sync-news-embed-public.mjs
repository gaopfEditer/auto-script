#!/usr/bin/env node
/**
 * 将 news_mornitor 前端同步到 public/collector-ui/news-embed/
 * 目录须与 index.html 中 static/* 一致，否则 CSS/JS 404 → 样式全崩。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "news_mornitor/frontend/public");
const dest = resolve(root, "public/collector-ui/news-embed");
const destStatic = resolve(dest, "static");

if (!existsSync(resolve(src, "index.html"))) {
  console.error(`[sync-news-embed-public] 缺少 ${src}/index.html`);
  process.exit(1);
}

mkdirSync(resolve(root, "public/collector-ui"), { recursive: true });
rmSync(dest, { recursive: true, force: true });
mkdirSync(destStatic, { recursive: true });

cpSync(resolve(src, "index.html"), resolve(dest, "index.html"));
for (const name of ["styles.css", "app.js"]) {
  const from = resolve(src, name);
  if (!existsSync(from)) {
    console.error(`[sync-news-embed-public] 缺少 ${from}`);
    process.exit(1);
  }
  cpSync(from, resolve(destStatic, name));
}

console.info(`[sync-news-embed-public] ${src} → ${dest} (index + static/)`);
