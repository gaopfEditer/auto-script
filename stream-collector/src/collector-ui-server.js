#!/usr/bin/env node
/**
 * CDP 采集 + HTTP 静态（debug/show 两页）+ WebSocket 实时推送诊断与 WS 帧摘要。
 * 配置与 `collect` 相同（.env：MySQL、COLLECTOR_*、CDP_CONNECT_URL、TARGET_PAGE_URL 等）。
 */
import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import zlib from "node:zlib";
import express from "express";
import { WebSocketServer } from "ws";

import { config } from "./config.js";
import { startCdpWebSocketMonitor } from "./cdp-ws-monitor.js";
import { createLogger, setLogLevel } from "./logger.js";
import { processBuffer } from "./processor.js";
import { hashBuffer, openStore } from "./store.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public", "collector-ui");
const PORT = Number.isFinite(config.collectUiPort) ? config.collectUiPort : 3840;

/**
 * @param {Buffer} buf
 */
function tryDecodeWsPayload(buf) {
  try {
    const t = buf.toString("utf8");
    const obj = JSON.parse(t);
    return { format: "json_utf8", obj, len: buf.length };
  } catch {
    try {
      const inflated = zlib.inflateSync(buf);
      const t = inflated.toString("utf8");
      const obj = JSON.parse(t);
      return { format: "json_zlib", obj, len: buf.length };
    } catch {
      try {
        const inflated = zlib.inflateRawSync(buf);
        const t = inflated.toString("utf8");
        const obj = JSON.parse(t);
        return { format: "json_zlib_raw", obj, len: buf.length };
      } catch {
        return {
          format: "opaque",
          len: buf.length,
          hexPreview: buf.subarray(0, 48).toString("hex"),
        };
      }
    }
  }
}

/** @param {unknown} obj @param {number} max */
function jsonWire(obj, max = 32000) {
  try {
    const s = JSON.stringify(obj);
    if (s.length <= max) return { json: obj, truncated: false };
    return { json: null, truncated: true, snippet: s.slice(0, max) };
  } catch {
    return { json: null, truncated: false, snippet: String(obj).slice(0, max) };
  }
}

async function main() {
  setLogLevel(config.logLevel);
  const log = createLogger("ui-server");

  const app = express();
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server, path: "/ws" });

  /** @param {string} channel @param {Record<string, unknown>} payload */
  function broadcast(channel, payload) {
    const msg = JSON.stringify({ v: 1, ts: Date.now(), channel, ...payload });
    for (const client of wss.clients) {
      if (client.readyState === 1) client.send(msg);
    }
  }

  const diagnosticSink = /** @param {Record<string, unknown>} evt */ (evt) => {
    broadcast("diag", evt);
  };

  const store = await openStore(config.mysql, createLogger("store"));

  app.get("/api/frames", async (req, res) => {
    try {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 120));
      const rows = await store.listRecentFrames(limit);
      res.json({ ok: true, rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.use(express.static(publicDir));

  /** Vue SPA：静态未命中且非 /api、路径无扩展名时回退 index.html */
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api")) return next();
    if (/\.\w+$/.test(req.path)) return next();
    res.sendFile(path.join(publicDir, "index.html"), (err) => (err ? next(err) : undefined));
  });

  let frameSeq = 0;
  const session = await startCdpWebSocketMonitor(
    {
      startUrl: config.startUrl,
      cdpConnectUrl: config.cdpConnectUrl,
      pageReloadIntervalMs: config.pageReloadIntervalMs,
      networkTrace: config.collectNetworkTrace,
      diagnosticSink,
      onData(buf, meta) {
        frameSeq += 1;
        const decoded = tryDecodeWsPayload(buf);
        const proc = processBuffer(buf, config.requiredTopLevelKeys);
        const parsedObj = "obj" in decoded && decoded.obj !== undefined ? decoded.obj : undefined;
        const body =
          parsedObj !== undefined
            ? jsonWire(parsedObj)
            : {
                json: null,
                truncated: false,
                snippet:
                  "hexPreview" in decoded ? String(decoded.hexPreview) : null,
                rawLen: decoded.len,
              };

        broadcast("frame", {
          kind: "ws_frame",
          seq: frameSeq,
          opcode: meta.opcode,
          pageUrl: meta.pageUrl ?? "",
          requestId: meta.requestId ?? "",
          decodeFormat: decoded.format,
          len: buf.length,
          dbParseOk: proc.ok,
          dbParseError: proc.parseError,
          body,
        });

        void store
          .insertFrame({
            receivedAt: proc.receivedAt,
            payloadHash: hashBuffer(buf),
            opcode: meta.opcode,
            requestId: meta.requestId || null,
            rawPayload: buf,
            parsedJson: proc.ok ? proc.parsedJson : null,
            parseError: proc.ok ? null : proc.parseError,
          })
          .catch((err) => log.error(`MySQL: ${err.message}`));
      },
    },
    createLogger("cdp")
  );

  const shutdown = async (reason = "shutdown") => {
    log.info(`退出 (${reason})`);
    await session.close().catch((e) => log.warn(String(e?.message ?? e)));
    await store.close().catch((e) => log.warn(String(e?.message ?? e)));
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  server.listen(PORT, "127.0.0.1", () => {
    log.info(
      `Collector UI (Vue)  http://127.0.0.1:${PORT}/  |  /debug  /show  |  WS ws://127.0.0.1:${PORT}/ws  （先 pnpm run ui:build）`
    );
    if (config.collectStartUsedTargetFallback) {
      log.info(`COLLECTOR_START_URL 回退为 TARGET_PAGE_URL → ${config.startUrl}`);
    }
  });
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
