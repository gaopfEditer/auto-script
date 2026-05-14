#!/usr/bin/env node
/**
 * 使用 Playwright 持久化用户数据目录启动可见浏览器，挂载 CDP Network.webSocketFrameReceived，
 * 将 WS 帧解压为 JSON 后打印，并可选择写入现有 MySQL frames 表。
 *
 * 配置全部来自环境变量（见 .env）；目标站点 URL、Profile 路径由你自行填写。
 */
import "dotenv/config";
import zlib from "node:zlib";
import { chromium } from "playwright";

import { config } from "./config.js";
import { createLogger, setLogLevel } from "./logger.js";
import { hashBuffer, openStore } from "./store.js";

setLogLevel(config.logLevel);
const log = createLogger("persistent-cdp");

const userDataDir = process.env.CHROME_USER_DATA_DIR?.trim() || "D:/chrome_debug_profile";
const targetUrl = process.env.TARGET_PAGE_URL?.trim();
const remotePort = Number(process.env.REMOTE_DEBUGGING_PORT ?? 9222);
const ignoreS = new Set(
  (process.env.PERSISTENT_IGNORE_S_VALUES ?? "1,5,6")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => Number(s))
    .filter((n) => !Number.isNaN(n))
);
const storeMysql = process.env.PERSISTENT_STORE_MYSQL === "1" || process.env.PERSISTENT_STORE_MYSQL === "true";
const useSystemChrome = process.env.USE_SYSTEM_CHROME === "1" || process.env.USE_SYSTEM_CHROME === "true";

/**
 * @param {string} payloadData
 * @param {number} opcode
 */
function payloadToBuffer(payloadData, opcode) {
  if (opcode === 2) {
    return Buffer.from(String(payloadData), "base64");
  }
  return Buffer.from(String(payloadData), "utf8");
}

/**
 * @param {Buffer} buf
 */
function bufferToJson(buf) {
  try {
    return JSON.parse(buf.toString("utf8"));
  } catch {
    try {
      const inflated = zlib.inflateSync(buf);
      return JSON.parse(inflated.toString("utf8"));
    } catch {
      return null;
    }
  }
}

/**
 * @param {unknown} data
 */
function shouldIgnore(data) {
  if (data === null || typeof data !== "object" || Array.isArray(data)) return false;
  if (!("s" in data)) return false;
  const s = /** @type {{ s: unknown }} */ (data).s;
  const n = typeof s === "number" ? s : Number(s);
  return !Number.isNaN(n) && ignoreS.has(n);
}

/**
 * @param {unknown} data
 */
function logSignal(data) {
  const t = new Date().toLocaleTimeString("zh-CN", { hour12: false });
  log.info(`[${t}] 消息: ${JSON.stringify(data).slice(0, 2000)}${JSON.stringify(data).length > 2000 ? "…" : ""}`);
}

async function main() {
  if (!targetUrl) {
    log.error("请设置环境变量 TARGET_PAGE_URL（要打开的页面完整 URL）");
    process.exit(1);
  }

  log.info(
    `launchPersistentContext | userDataDir=${userDataDir} | remote-debugging-port=${remotePort} | headless=false`
  );

  const launchOpts = {
    headless: false,
    args: [`--remote-debugging-port=${remotePort}`, "--no-sandbox"],
  };
  if (useSystemChrome) {
    launchOpts.channel = "chrome";
  }

  const browserContext = await chromium.launchPersistentContext(userDataDir, launchOpts);

  const page = browserContext.pages()[0] ?? (await browserContext.newPage());

  log.info(`打开页面: ${targetUrl}`);
  await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 120_000 });

  const client = await page.context().newCDPSession(page);
  await client.send("Network.enable");
  log.info("CDP Network.enable 已发送，正在监听 WebSocket 帧…");

  let store = null;
  if (storeMysql) {
    store = await openStore(config.mysql, createLogger("store"));
  }

  let frameSeq = 0;
  client.on("Network.webSocketFrameReceived", (params) => {
    const response = params.response ?? {};
    const opcode = response.opcode ?? -1;
    const payloadData = response.payloadData;
    if (payloadData === undefined || payloadData === null) return;

    let buf;
    try {
      buf = payloadToBuffer(payloadData, opcode);
    } catch (e) {
      log.debug(`payload 解码跳过: ${/** @type {Error} */ (e).message}`);
      return;
    }

    const data = bufferToJson(buf);
    if (data === null) return;

    if (shouldIgnore(data)) {
      log.debug("忽略心跳/控制帧 (PERSISTENT_IGNORE_S_VALUES)");
      return;
    }

    frameSeq += 1;
    if (frameSeq <= 5 || frameSeq % 200 === 0) {
      log.debug(`已处理 WS JSON 帧 #${frameSeq}`);
    }

    logSignal(data);

    if (store) {
      const wrapped = { type: "cdp_ws", payload: data };
      const raw = Buffer.from(JSON.stringify(wrapped), "utf8");
      const receivedAt = new Date().toISOString();
      void store
        .insertFrame({
          receivedAt,
          payloadHash: hashBuffer(raw),
          opcode,
          requestId: params.requestId ?? null,
          rawPayload: buf,
          parsedJson: JSON.stringify(wrapped),
          parseError: null,
        })
        .catch((err) => log.error(`MySQL 写入失败: ${err.message}`));
    }
  });

  log.info("采集已运行；Ctrl+C 退出（会关闭持久化浏览器上下文）。");

  const shutdown = async () => {
    if (store) await store.close().catch(() => {});
    await browserContext.close().catch((e) => log.warn(`关闭上下文: ${e.message}`));
    process.exit(0);
  };
  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((e) => {
  log.error(String(e?.stack ?? e));
  process.exit(1);
});
