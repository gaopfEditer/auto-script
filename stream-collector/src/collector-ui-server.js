#!/usr/bin/env node
/**
 * CDP 采集 + HTTP 静态（debug/show 两页）+ WebSocket 实时推送诊断与 WS 帧摘要。
 * 配置与 `collect` 相同（.env：MySQL、COLLECTOR_*、CDP_CONNECT_URL、TARGET_PAGE_URL 等）。
 */
import "dotenv/config";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";

import { buildFrameChannelPayload } from "./collect-ws-decode.js";
import { config } from "./config.js";
import { startCdpWebSocketMonitor } from "./cdp-ws-monitor.js";
import { createLogger, setLogLevel } from "./logger.js";
import { hashBuffer, openStore } from "./store.js";
import { createKookMessageIngest } from "./kook-message-ingest.js";
import { registerKookMessageRoutes } from "./kook-message-api.js";
import { registerKookSignalRoutes } from "./kook-signal-api.js";
import { createKookTradeTelegramPush } from "./kook-trade-telegram-push.js";
import { registerKookTradePushRoutes } from "./kook-trade-push-api.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public", "collector-ui");
const PORT = Number.isFinite(config.collectUiPort) ? config.collectUiPort : 3840;

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
    void kookIngest.onDiag(evt).catch((e) => {
      log.debug(`kook ingest diag: ${/** @type {Error} */ (e).message}`);
    });
  };

  const store = await openStore(config.mysql, createLogger("store"));
  const tradePush = createKookTradeTelegramPush(createLogger("trade-push"));
  const kookIngest = createKookMessageIngest(store, createLogger("kook-ingest"), tradePush);

  app.use(express.json({ limit: "512kb" }));

  registerKookMessageRoutes(app, store, kookIngest);
  registerKookSignalRoutes(app, store);
  registerKookTradePushRoutes(app, tradePush);

  let frameSeq = 0;
  /** @type {null | ((guildId: string, channelId: string, trace?: { clientTraceId?: string }) => Promise<unknown>)} */
  let navigateKookImpl = null;

  app.get("/api/frames", async (req, res) => {
    try {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 120));
      const rows = await store.listRecentFrames(limit);
      res.json({ ok: true, rows });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.post("/api/cdp/kook-channel", async (req, res) => {
    const guildId = String(req.body?.guildId ?? req.query?.guild_id ?? "").trim();
    const channelId = String(req.body?.channelId ?? req.query?.channel_id ?? "").trim();
    const clientTraceIdRaw = String(req.body?.clientTraceId ?? "").trim();
    const clientTraceId = clientTraceIdRaw || undefined;
    /** @type {Record<string, string>} */
    const tracePayload = clientTraceId ? { clientTraceId } : {};

    if (!guildId || !channelId) {
      log.warn(
        `[kook-channel] 拒绝 400 缺少 guildId/channelId${clientTraceId ? ` trace=${clientTraceId}` : ""} | body=${JSON.stringify(req.body ?? {}).slice(0, 200)}`
      );
      res.status(400).json({ ok: false, error: "缺少 guildId 或 channelId" });
      return;
    }
    if (typeof navigateKookImpl !== "function") {
      log.warn(`[kook-channel] 拒绝 503 CDP 尚未就绪${clientTraceId ? ` trace=${clientTraceId}` : ""}`);
      res.status(503).json({ ok: false, error: "CDP 尚未就绪" });
      return;
    }

    log.info(
      `[kook-channel] 收到 POST guild=${guildId} channel=${channelId}${clientTraceId ? ` trace=${clientTraceId}` : ""}，转 CDP …`
    );
    diagnosticSink({
      kind: "kook_channel_api_received",
      guildId,
      channelId,
      phase: "post_received",
      ...tracePayload,
    });

    try {
      const trace = clientTraceId ? { clientTraceId } : {};
      const out = /** @type {{ ok?: boolean, error?: string, finalUrl?: string }} */ (
        await navigateKookImpl(guildId, channelId, trace)
      );
      diagnosticSink({
        kind: "kook_channel_api_finished",
        guildId,
        channelId,
        phase: "post_done",
        ok: Boolean(out?.ok),
        error: out?.ok ? null : (out?.error ?? "导航失败"),
        finalUrl: out?.finalUrl ?? null,
        ...tracePayload,
      });
      log.info(
        `[kook-channel] CDP 返回 ok=${Boolean(out?.ok)}${out?.error ? ` err=${out.error}` : ""}${out?.finalUrl ? ` final=${String(out.finalUrl).length > 180 ? `${String(out.finalUrl).slice(0, 180)}…` : out.finalUrl}` : ""}${clientTraceId ? ` trace=${clientTraceId}` : ""}`
      );
      if (out?.ok) {
        res.json({ ok: true, ...out, ...tracePayload });
      } else {
        log.warn(
          `[kook-channel] CDP 返回失败 err=${out?.error ?? "unknown"}${clientTraceId ? ` trace=${clientTraceId}` : ""}`
        );
        res.status(500).json({ ok: false, error: out?.error ?? "导航失败", ...tracePayload });
      }
    } catch (e) {
      const errMsg = String(/** @type {Error} */ (e).message ?? e);
      diagnosticSink({
        kind: "kook_channel_api_finished",
        guildId,
        channelId,
        phase: "post_done",
        ok: false,
        error: errMsg,
        finalUrl: null,
        ...tracePayload,
      });
      log.error(`[kook-channel] 未捕获异常: ${errMsg}${clientTraceId ? ` trace=${clientTraceId}` : ""}`);
      res.status(500).json({ ok: false, error: errMsg, ...tracePayload });
    }
  });

  const session = await startCdpWebSocketMonitor(
    {
      startUrl: config.startUrl,
      cdpConnectUrl: config.cdpConnectUrl,
      pageReloadIntervalMs: config.pageReloadIntervalMs,
      networkTrace: config.collectNetworkTrace,
      diagnosticSink,
      onData(buf, meta) {
        frameSeq += 1;
        const { payload, proc } = buildFrameChannelPayload(
          buf,
          meta,
          frameSeq,
          config.requiredTopLevelKeys
        );
        broadcast("frame", payload);
        void kookIngest.onWsFrame(payload).catch((e) => {
          log.debug(`kook ingest ws: ${/** @type {Error} */ (e).message}`);
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

  navigateKookImpl = (guildId, channelId, trace) => session.navigateKookChannel(guildId, channelId, trace);

  app.use(express.static(publicDir));

  /** Vue SPA：静态未命中且非 /api、路径无扩展名时回退 index.html */
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api")) return next();
    if (/\.\w+$/.test(req.path)) return next();
    res.sendFile(path.join(publicDir, "index.html"), (err) => (err ? next(err) : undefined));
  });

  /** 未实现的 /api（含 POST 落在此）：打日志并 JSON 404，避免静默落到 Express 默认 HTML 404 */
  app.use((req, res, next) => {
    if (!req.path.startsWith("/api")) return next();
    log.warn(`[api] 404 未匹配路由 ${req.method} ${req.originalUrl}`);
    res.status(404).json({ ok: false, error: `API 不存在: ${req.method} ${req.path}` });
  });

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
    log.info(
      `[api] 已注册 /api/kook/messages、/api/kook/signals*、/api/kook/trade-signal/*、/api/frames、/api/cdp/kook-channel（COLLECTOR_UI_PORT=${PORT}）`
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
