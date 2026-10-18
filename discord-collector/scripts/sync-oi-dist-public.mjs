#!/usr/bin/env node
/**
 * 将 oi_mornitor/public/oi-dist 同步到 discord-collector/public/oi-dist（便于 rsync / 本机查看）。
 * 来源必须是 OI React 构建产物，勿把 collector-ui 拷到此目录。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "oi_mornitor/public/oi-dist");
const dest = resolve(root, "public/oi-dist");

if (!existsSync(resolve(src, "index.html"))) {
  console.error(`[sync-oi-dist-public] 缺少 ${src}，请先 pnpm run oi:ui:build`);
  process.exit(1);
}

mkdirSync(resolve(root, "public"), { recursive: true });
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.info(`[sync-oi-dist-public] ${src} → ${dest}`);
