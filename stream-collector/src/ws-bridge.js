#!/usr/bin/env node
/**
 * 通用上游 WebSocket 桥：用环境变量配置 URL / Token / 头 / 解压，将解析后的 JSON 转发到本地 HTTP（可选）。
 * 不在仓库中写死任何第三方产品域名；由你自行设置 UPSTREAM_WS_URL 等变量。
 */
import "dotenv/config";
import http from "node:http";
import https from "node:https";
import { URL as NodeURL } from "node:url";
import zlib from "node:zlib";
import WebSocket from "ws";

import { createLogger, setLogLevel } from "./logger.js";

/** 仅向 stdout 打印每条上游 JSON（适合 `pnpm run test-ws`），其它桥接日志静默 */
const payloadsOnly =
  process.argv.includes("--payloads-only") ||
  process.env.WS_BRIDGE_PAYLOADS_ONLY === "1" ||
  process.env.WS_BRIDGE_PAYLOADS_ONLY === "true";

if (payloadsOnly) {
  setLogLevel("silent");
} else {
  setLogLevel(process.env.LOG_LEVEL ?? "info");
}
const log = createLogger("ws-bridge");

/** 从环境变量读取 token（勿把真实 token 写进代码仓库） */
const token = process.env.UPSTREAM_TOKEN ?? "";
/** 完整 WebSocket URL；可用占位符 {TOKEN}，将替换为 encodeURIComponent(token) */
const urlTemplate = process.env.UPSTREAM_WS_URL ?? "";
/** 为 1 时先 zlib.inflate 再 UTF-8 解析（上游带 compress/binary 时常用） */
const useZlib = process.env.UPSTREAM_USE_ZLIB === "1" || process.env.UPSTREAM_USE_ZLIB === "true";
/** 转发目标：若设置则对每个解析成功的 JSON 发 POST application/json */
const forwardUrl = (process.env.FORWARD_HOOK_URL ?? "").trim();
/** 重连间隔（毫秒） */
const reconnectMs = Number(process.env.WS_BRIDGE_RECONNECT_MS ?? 5000);

function parseHeaders() {
  const raw = process.env.UPSTREAM_HEADERS_JSON;
  if (!raw?.trim()) return {};
  try {
    const o = JSON.parse(raw);
    return typeof o === "object" && o !== null && !Array.isArray(o) ? o : {};
  } catch (e) {
    log.warn(`UPSTREAM_HEADERS_JSON 解析失败，将忽略: ${/** @type {Error} */ (e).message}`);
    return {};
  }
}

function buildWsUrl() {
  if (!urlTemplate.trim()) {
    throw new Error("请设置环境变量 UPSTREAM_WS_URL（可含 {TOKEN} 占位符）");
  }
  if (!token.trim() && urlTemplate.includes("{TOKEN}")) {
    throw new Error("URL 含 {TOKEN} 时请设置 UPSTREAM_TOKEN");
  }
  return urlTemplate.replaceAll("{TOKEN}", encodeURIComponent(token));
}

/** @param {string} u */
function redactUrlForLog(u) {
  try {
    const x = new NodeURL(u);
    if (x.searchParams.has("token")) x.searchParams.set("token", "****");
    return x.toString();
  } catch {
    return u.replace(/token=[^&]+/i, "token=****");
  }
}

/**
 * @param {Buffer|ArrayBuffer|Buffer[]} data
 */
function decodePayload(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (useZlib) {
    try {
      const inflated = zlib.inflateSync(buf);
      return inflated.toString("utf8");
    } catch {
      try {
        return buf.toString("utf8");
      } catch {
        return null;
      }
    }
  }
  return buf.toString("utf8");
}

/**
 * @param {unknown} body
 */
async function forwardJson(body) {
  if (!forwardUrl) return;
  const u = new NodeURL(forwardUrl);
  const payload = JSON.stringify(body);
  const mod = u.protocol === "https:" ? https : http;
  await new Promise((resolve, reject) => {
    const req = mod.request(
      u,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json; charset=utf-8",
          "Content-Length": Buffer.byteLength(payload),
        },
      },
      (res) => {
        res.resume();
        if (res.statusCode && res.statusCode >= 400) {
          reject(new Error(`forward HTTP ${res.statusCode}`));
        } else resolve(undefined);
      }
    );
    req.on("error", reject);
    req.write(payload);
    req.end();
  });
}

function connect() {
  let wsUrl;
  try {
    wsUrl = buildWsUrl();
  } catch (e) {
    const msg = /** @type {Error} */ (e).message;
    if (payloadsOnly) console.error("[ws-bridge]", msg);
    else log.error(msg);
    process.exit(1);
  }

  const headers = parseHeaders();
  if (!payloadsOnly) {
    log.info(`连接上游 WS: ${redactUrlForLog(wsUrl)} | zlib=${useZlib} | forward=${forwardUrl || "(仅日志)"}`);
  }

  const ws = new WebSocket(wsUrl, { headers });

  ws.on("open", () => {
    if (!payloadsOnly) log.info("WebSocket 已连接");
  });

  ws.on("message", (data, isBinary) => {
    try {
      const text = decodePayload(data);
      if (text === null) {
        if (!payloadsOnly) log.warn("无法解码为文本，跳过");
        return;
      }
      let message;
      try {
        message = JSON.parse(text);
      } catch {
        if (!payloadsOnly) {
          log.debug(`非 JSON 帧 (${isBinary ? "binary" : "text"}): ${text.slice(0, 200)}…`);
        }
        return;
      }
      if (payloadsOnly) {
        console.log(JSON.stringify(message));
      } else {
        log.info(`收到 JSON: ${JSON.stringify(message)}`);
      }
      void forwardJson(message).catch((err) => {
        if (payloadsOnly) console.error("[ws-bridge] forward:", err.message);
        else log.error(`转发失败: ${err.message}`);
      });
    } catch (e) {
      if (payloadsOnly) console.error("[ws-bridge]", /** @type {Error} */ (e).message);
      else log.error(`message 处理异常: ${/** @type {Error} */ (e).message}`);
    }
  });

  ws.on("error", (err) => {
    if (payloadsOnly) console.error("[ws-bridge] WS 错误:", err.message);
    else log.error(`WS 错误: ${err.message}`);
  });

  ws.on("close", (code, reason) => {
    if (payloadsOnly) {
      console.error(
        `[ws-bridge] 连接关闭 code=${code} reason=${reason?.toString?.() ?? ""}，${reconnectMs}ms 后重连`
      );
    } else {
      log.warn(`连接关闭 code=${code} reason=${reason?.toString?.() ?? ""}，${reconnectMs}ms 后重连…`);
    }
    setTimeout(connect, reconnectMs);
  });
}

connect();
