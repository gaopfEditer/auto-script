#!/usr/bin/env node
/**
 * dev:ui-vue 启动前释放 Vite dev 端口（默认 5178），避免 Port already in use。
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { killListenersOnPort } from "./kill-port.mjs";

const __dir = dirname(fileURLToPath(import.meta.url));
dotenv.config({ path: resolve(__dir, "../.env") });

const raw = process.env.VITE_DEV_PORT ?? process.env.COLLECTOR_VUE_DEV_PORT ?? "5178";
const port = String(raw).trim() || "5178";

await killListenersOnPort(port, "dev:ui-vue");
