/**
 * 仅 HTTP `/api/frames` + WebSocket `/ws`（无静态资源），供 `pnpm collect` 在嵌入模式
 * 下与 Vite `dev:ui-vue` 代理对接；逻辑与 collector-ui-server 的广播一致。
 *
 * @param {{ navigateKookChannel?: (guildId: string, channelId: string, trace?: { clientTraceId?: string }) => Promise<unknown> }} [cdpNav]
 *        在 `startCdpWebSocketMonitor` 完成后由调用方赋值 `navigateKookChannel`，用于 POST /api/cdp/kook-channel。
 */
import http from "node:http";

import express from "express";
import { WebSocketServer } from "ws";

import { registerKookMessageRoutes } from "./kook-message-api.js";
import { registerKookSignalRoutes } from "./kook-signal-api.js";
import { registerKookTradePushRoutes } from "./kook-trade-push-api.js";

/**
 * @param {number} port
 * @param {{ listRecentFrames: (limit: number) => Promise<unknown[]>, listKookChannelMessages?: (channelId: string, limit?: number) => Promise<unknown[]> }} store
 * @param {{ info: (s: string) => void, warn: (s: string) => void, error: (s: string) => void, debug?: (s: string) => void }} log
 * @param {{ navigateKookChannel?: (guildId: string, channelId: string, trace?: { clientTraceId?: string }) => Promise<unknown> }} [cdpNav]
 * @param {{ onClientBatch: (rows: unknown[]) => Promise<{ inserted: number, duplicate: number }> } | null} [kookIngest]
 * @param {ReturnType<typeof import("./kook-trade-telegram-push.js").createKookTradeTelegramPush> | null} [tradePush]
 */
export async function startEmbedUiServer(port, store, log, cdpNav, kookIngest = null, tradePush = null) {
  const nav = cdpNav ?? {};
  const app = express();
  app.use(express.json({ limit: "512kb" }));
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

  if (kookIngest) {
    registerKookMessageRoutes(app, store, kookIngest);
  }
  registerKookSignalRoutes(app, store);
  if (tradePush) {
    registerKookTradePushRoutes(app, tradePush);
  }

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
    const fn = nav.navigateKookChannel;
    if (typeof fn !== "function") {
      log.warn(`[kook-channel] 拒绝 503 CDP 尚未就绪${clientTraceId ? ` trace=${clientTraceId}` : ""}`);
      res.status(503).json({ ok: false, error: "CDP 尚未就绪，请稍后再试" });
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
      const out = /** @type {{ ok?: boolean, error?: string, finalUrl?: string }} */ (await fn(guildId, channelId, trace));
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

  app.use((req, res) => {
    if (req.path.startsWith("/api")) {
      log.warn(`[api] 404 未匹配路由 ${req.method} ${req.originalUrl}`);
      res.status(404).json({ ok: false, error: `API 不存在: ${req.method} ${req.path}` });
      return;
    }
    res.status(404).send("Not found");
  });

  await new Promise((resolve, reject) => {
    server.listen(port, "127.0.0.1", () => resolve(undefined));
    server.once("error", reject);
  });

  log.info(
    `COLLECTOR_UI_EMBED：实时推送已开 | http://127.0.0.1:${port}/api/frames  ws://127.0.0.1:${port}/ws（Vite 代理 /api /ws）`
  );

  return {
    broadcast,
    diagnosticSink,
    async close() {
      await new Promise((resolve) => {
        wss.close(() => {
          server.close(() => resolve(undefined));
        });
      });
    },
  };
}
