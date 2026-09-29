#!/usr/bin/env node
/**
 * 将 collector-ui-vue 构建产物同步到 public/oi-dist（与 ui:build / vite build 配套）。
 */
import { cpSync, existsSync, mkdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = resolve(root, "public/collector-ui");
const dest = resolve(root, "public/oi-dist");

if (!existsSync(src)) {
  console.error("[copy-collector-ui-to-oi-dist] 未找到 public/collector-ui，请先执行 vite build");
  process.exit(1);
}

mkdirSync(resolve(root, "public"), { recursive: true });
rmSync(dest, { recursive: true, force: true });
cpSync(src, dest, { recursive: true });
console.info(`[copy-collector-ui-to-oi-dist] ${src} → ${dest}`);
