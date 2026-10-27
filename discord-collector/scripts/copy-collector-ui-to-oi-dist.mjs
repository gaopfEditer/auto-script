#!/usr/bin/env node
/**
 * 已废弃：勿把 Vue 主站拷进 oi-dist（会覆盖 OI React 包，导致 op.b 嵌套 /oi）。
 * 双域部署：collector-ui → op.c；oi_mornitor/public/oi-dist → op.b。
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
