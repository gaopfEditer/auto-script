#!/usr/bin/env node
import { readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const oiIndex = resolve(root, "oi_mornitor/public/oi-dist/index.html");
const oiPublicMirror = resolve(root, "public/oi-dist/index.html");
const uiIndex = resolve(root, "public/collector-ui/index.html");

function line(label, path) {
  try {
    const html = readFileSync(path, "utf8");
    const title = html.match(/<title>([^<]*)<\/title>/i)?.[1]?.trim() ?? "?";
    const mtime = statSync(path).mtime.toISOString();
    console.info(`[build:all] ${label}\n  path: ${path}\n  title: ${title}\n  mtime: ${mtime}`);
  } catch {
    console.warn(`[build:all] ${label} 缺失: ${path}`);
  }
}

console.info("");
line("OI 独立站（源）", oiIndex);
line("OI 镜像 public/oi-dist（可 rsync op.b）", oiPublicMirror);
line("Vue 主站 public/collector-ui（rsync op.c）", uiIndex);
console.info("");
