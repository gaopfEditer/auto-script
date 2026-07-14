#!/usr/bin/env node
/**
 * Discord CDP 采集 + HTTP 静态 UI + WebSocket 实时推送。
 */
import "./load-env.js";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";

import { buildFrameChannelPayload } from "./collect-ws-decode.js";
import { config } from "./config.js";
import { startCdpWebSocketMonitor } from "./cdp-ws-monitor.js";
import { createDiscordMessageIngest } from "./discord-message-ingest.js";
import { createDiscordSignalCardService } from "./discord-signal-card-service.js";
import { createDiscordTelegramMessagePush } from "./discord-telegram-message-push.js";
import { createDiscordWebhookForward } from "./discord-webhook-forward.js";
import { createSystemTelegramAlert } from "./discord-system-telegram.js";
import { registerDiscordSignalRoutes } from "./discord-signal-api.js";
import { COIN_ACTION_SIGNAL_CHANNEL_ID, getSignalChannelConfig } from "./discord-signal-config.js";
import { getBitgetTradeStatus, loadBitgetTradeConfig } from "./bitget-trade-config.js";
import { getWeexTradeStatus, loadWeexTradeConfig } from "./weex-trade-config.js";
import { isStagedTradeChannel } from "./discord-signal-staged-trade.js";
import { getDebugConfig, isDebugMode, setDebugMode } from "./discord-debug.js";
import { isBlockedWsPayload, isForwardableFramePayload } from "./ws-noise-filter.js";
import { createLogger, setLogLevel } from "./logger.js";
import { hashBuffer, tryOpenStore } from "./store.js";
import { killListenersOnPort } from "../scripts/kill-port.mjs";
import { registerYoutubeArchiveRoutes } from "./youtube-archives.js";
import { registerYoutubeFetchProxyRoutes } from "./youtube-fetch-proxy.js";
import { registerYoutubePasteParseRoutes } from "./youtube-paste-parse.js";
import { registerYoutubePasteBatchRoutes, startPasteBatchService } from "./youtube-paste-batch.js";
import { createCardArchiveService } from "./card-archive-service.js";
import { registerCardArchiveRoutes } from "./card-archive-api.js";
import { createCardPriceMonitor } from "./card-price-monitor.js";
import { createBitgetOrderService } from "./bitget-order-service.js";
import { createWeexOrderService } from "./weex-order-service.js";
import { createBitgetManualService } from "./bitget-manual-service.js";
import { registerBitgetRoutes } from "./bitget-api-routes.js";
import { registerWeexRoutes } from "./weex-api-routes.js";
import { getBitgetProxyInUse } from "./bitget-api.js";
import {
  getAutoTradeChannelIds,
  getTradePlatformToggles,
  setTradePlatformToggles,
} from "./trade-platform-toggles.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public", "collector-ui");
const PORT = Number.isFinite(config.collectUiPort) ? config.collectUiPort : 3851;

async function main() {
  setLogLevel(config.logLevel);
  setDebugMode(config.debugMode);
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

  const storeLog = createLogger("store");
  const { store, offline: mysqlOffline, hint: mysqlHint } = await tryOpenStore(config.mysql, storeLog);
  const telegramPush = createDiscordTelegramMessagePush(createLogger("telegram-push"));
  const webhookForward = createDiscordWebhookForward(createLogger("webhook-forward"));
  const systemTelegram = createSystemTelegramAlert(createLogger("system-telegram"));
  const bitgetOrder = createBitgetOrderService(store, createLogger("bitget"));
  const weexOrder = createWeexOrderService(store, createLogger("weex"));
  const bitgetManual = createBitgetManualService(createLogger("bitget-manual"));
  if (config.bitgetEnabled) {
    const bgProxy = getBitgetProxyInUse();
    const bgCfg = loadBitgetTradeConfig();
    log.info(
      `Bitget 自动交易 enabled ${bgCfg.dryRun ? "dryRun=模拟" : "LIVE=实盘"}${bgProxy ? ` proxy=${bgProxy}` : "（未配置代理，国内直连可能失败）"}`
    );
  }
  if (config.weexEnabled) {
    const wxCfg = loadWeexTradeConfig();
    log.info(`WEEX 自动交易 enabled ${wxCfg.dryRun ? "dryRun=模拟" : "LIVE=实盘"}（参数与 Bitget 共用）`);
  }
  const signalCards = createDiscordSignalCardService(store, createLogger("signal"), broadcast, {
    bitgetOrder,
    weexOrder,
  });
  const cardArchive = createCardArchiveService(store, createLogger("card-archive"), broadcast);
  const cardPriceMonitor = createCardPriceMonitor(
    store,
    createLogger("card-price"),
    systemTelegram,
    broadcast
  );
  const discordIngest = createDiscordMessageIngest(
    store,
    createLogger("discord-ingest"),
    broadcast,
    { signalCards, telegramPush, webhookForward }
  );

  const diagnosticSink = /** @param {Record<string, unknown>} evt */ (evt) => {
    broadcast("diag", { ...evt, debugMode: isDebugMode() });
    void discordIngest.onDiag(evt).catch((e) => {
      log.warn(`discord ingest diag: ${/** @type {Error} */ (e).message}`);
    });
  };

  app.use(express.json({ limit: "512kb" }));

  registerDiscordSignalRoutes(app, store, signalCards, broadcast);
  registerBitgetRoutes(app, bitgetOrder, bitgetManual);
  registerWeexRoutes(app, weexOrder);
  registerCardArchiveRoutes(app, store, cardArchive);
  registerYoutubeArchiveRoutes(app, { archivesDir: config.youtubeArchivesDir, log: createLogger("yt-archives") });
  void import("./youtube-archives.js")
    .then(({ rebuildArchivesIndex, warmArchivesParsedCache }) => {
      void rebuildArchivesIndex(config.youtubeArchivesDir).catch(() => {});
      setImmediate(() => {
        void warmArchivesParsedCache(config.youtubeArchivesDir, { backfill: false }).catch(() => {});
      });
    })
    .catch(() => {});
  registerYoutubeFetchProxyRoutes(app, {
    baseUrl: config.youtubeFetchUrl,
    log: createLogger("yt-fetch-proxy"),
  });
  registerYoutubePasteParseRoutes(app, createLogger("yt-paste-parse"));
  const pasteBatchLog = createLogger("paste-batch");
  registerYoutubePasteBatchRoutes(app, config, pasteBatchLog, { archiveService: cardArchive });
  startPasteBatchService(config, pasteBatchLog);

  let frameSeq = 0;
  /** @type {null | ((guildId: string, channelId: string, trace?: { clientTraceId?: string }) => Promise<unknown>)} */
  let navigateDiscordImpl = null;

  app.get("/api/frames", async (req, res) => {
    try {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 120));
      const rows = await store.listRecentFrames(limit);
      const filtered = rows.filter((row) => {
        let j = row.parsed_json;
        if (typeof j === "string") {
          try {
            j = JSON.parse(j);
          } catch {
            j = null;
          }
        }
        const raw = typeof row.raw_payload === "string" ? row.raw_payload : "";
        if (!j) return false;
        return !isBlockedWsPayload(j, raw);
      });
      res.json({ ok: true, rows: filtered });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      mysql: !mysqlOffline,
      mysqlHint: mysqlOffline ? mysqlHint : undefined,
      mysqlHost: config.mysql.host,
      mysqlPort: config.mysql.port,
      mysqlDatabase: config.mysql.database,
    });
  });

  app.get("/api/config", (_req, res) => {
    res.json({ ok: true, mysql: !mysqlOffline, ...getDebugConfig() });
  });

  app.post("/api/config", (req, res) => {
    if (typeof req.body?.debugMode === "boolean") {
      setDebugMode(req.body.debugMode);
      broadcast("config", { kind: "debug_mode", ...getDebugConfig() });
    }
    res.json({ ok: true, ...getDebugConfig() });
  });

  app.get("/api/debug/telegram", (_req, res) => {
    const tg = signalCards.telegram;
    res.json({
      ok: true,
      enabled: tg.enabled,
      chatId: tg.chatId != null && tg.chatId !== "" ? String(tg.chatId) : null,
      sendUrl: tg.sendUrl || config.telegramSendUrl,
    });
  });

  app.post("/api/debug/telegram-test", async (req, res) => {
    const tg = signalCards.telegram;
    if (!tg.enabled) {
      res.status(503).json({
        ok: false,
        skipped: "telegram_disabled",
        error: "Telegram 未配置",
        hint: "在 .env 设置 TELEGRAM_PUSH_CHAT_ID 与 TELEGRAM_SEND_URL",
      });
      return;
    }
    const custom = String(req.body?.text ?? "").trim();
    const text =
      custom ||
      `🧪 discord-collector Telegram 链路测试\n${new Date().toISOString()}\n来源: Debug 页`;
    try {
      const result = await tg.send(text, { skipChannelLabel: true, kind: "debug_test" });
      if (result.skipped) {
        res.status(400).json({ ok: false, ...result });
        return;
      }
      res.json({
        ok: true,
        chatId: tg.chatId,
        sendUrl: tg.sendUrl,
        text,
      });
    } catch (e) {
      res.status(500).json({
        ok: false,
        error: String(/** @type {Error} */ (e).message ?? e),
        chatId: tg.chatId,
        sendUrl: tg.sendUrl,
      });
    }
  });

  app.get("/api/debug/webhook-forward", (_req, res) => {
    res.json({
      ok: true,
      enabled: webhookForward.enabled,
      ruleCount: webhookForward.ruleCount,
      configFile: config.webhookForwardsFile,
    });
  });

  app.post("/api/debug/webhook-forward-test", async (req, res) => {
    if (!webhookForward.enabled) {
      res.status(503).json({
        ok: false,
        error: "webhook_forward_disabled",
        hint: "请检查 config/channel-webhook-forwards.json",
      });
      return;
    }
    const text =
      String(req.body?.text ?? "").trim() ||
      `🧪 webhook-forward 链路测试\n${new Date().toISOString()}`;
    const channelId = String(req.body?.channelId ?? "1444964635068338270").trim();
    try {
      const result = await webhookForward.forward({
        messageId: `test-${Date.now()}`,
        channelId,
        guildId: String(req.body?.guildId ?? "1444959079209504831").trim(),
        authorUsername: "debug-test",
        content: text,
      });
      if (result.skipped) {
        res.status(400).json({ ok: false, skipped: result.skipped });
        return;
      }
      res.json({ ok: true, channelId, text });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  const DEBUG_SIMULATE_CHANNELS = [
    { id: "1444963506431463474", name: "山寨之王", parser: "altcoin_king" },
    { id: "1444963372134301827", name: "seven", parser: "tw_opg" },
  ];

  app.get("/api/debug/trade-platforms", (_req, res) => {
    res.json({
      ok: true,
      platforms: getTradePlatformToggles(),
      requiredChannelIds: getAutoTradeChannelIds(),
    });
  });

  app.post("/api/debug/trade-platforms", (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const platforms = setTradePlatformToggles({
      bitget: typeof body.bitget === "boolean" ? body.bitget : undefined,
      weex: typeof body.weex === "boolean" ? body.weex : undefined,
    });
    log.info(`[debug] trade platforms bitget=${platforms.bitget} weex=${platforms.weex}`);
    res.json({ ok: true, platforms, requiredChannelIds: getAutoTradeChannelIds() });
  });

  app.get("/api/debug/simulate-signal", (_req, res) => {
    res.json({
      ok: true,
      defaultChannelId: "1444963506431463474",
      channels: DEBUG_SIMULATE_CHANNELS,
      tradePlatforms: getTradePlatformToggles(),
      requiredChannelIds: getAutoTradeChannelIds(),
      bitget: getBitgetTradeStatus(),
      weex: getWeexTradeStatus(),
      examples: {
        altcoin_king: {
          open: "#SOL 市价多",
          tpsl: "止盈：508-501-477\n止損：520",
        },
        tw_opg: {
          open: "开单 #BTC 市价進多",
          tpsl: "止盈：4.71   止損：4.9",
        },
      },
      hints: [
        "回车提交；Shift+Enter 换行",
        "Debug 模式：跳过去重 / 不走 Ollama，响应更快",
        "第 1 条通常为市价开仓（Bitget + WEEX 同步，BTC/ETH 100x / 山寨 30x）",
        "开仓同时挂市价 -4.3% 初始止损",
        "第 2 条通常为 TP/SL 补充（合并到同币种未完结卡片）",
        "正式 Discord 信号仍保留 4h 同币种去重",
        "下方勾选控制 Bitget / WEEX 是否下单（localStorage + 服务端同步）；频道须在 BITGET_AUTO_TRADE_CHANNEL_IDS",
      ],
    });
  });

  app.post("/api/debug/simulate-signal", async (req, res) => {
    const channelId = String(req.body?.channelId ?? "1444963506431463474").trim();
    const content = String(req.body?.content ?? "").trim();
    if (!content) {
      res.status(400).json({ ok: false, error: "content_required" });
      return;
    }
    if (!isStagedTradeChannel(channelId)) {
      res.status(400).json({ ok: false, error: "channel_not_staged", hint: "仅支持分阶段交易频道" });
      return;
    }
    const chCfg = getSignalChannelConfig(channelId);
    if (!chCfg) {
      res.status(400).json({ ok: false, error: "invalid_channel" });
      return;
    }
    const messageId = `debug-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const bodyPlatforms =
      req.body?.tradePlatforms && typeof req.body.tradePlatforms === "object" ? req.body.tradePlatforms : null;
    const simulateOpts = { skipDedup: true, skipTelegram: true, debugSimulate: true };
    if (bodyPlatforms) {
      simulateOpts.tradePlatforms = {
        bitget: bodyPlatforms.bitget !== false,
        weex: bodyPlatforms.weex !== false,
      };
    }
    try {
      const result = await signalCards.onMessage(
        {
          channelId,
          messageId,
          guildId: String(req.body?.guildId ?? "").trim(),
          content,
          timestamp: new Date().toISOString(),
        },
        simulateOpts
      );
      const ok = !result.skipped || result.merged;
      log.info(
        `[debug-simulate] channel=${channelId} skipped=${result.skipped ?? "-"} phase=${String(result.parsed?.signalPhase ?? "")} card=#${result.card?.id ?? "-"}`
      );
      res.json({
        ok,
        channelId,
        channelName: chCfg.name,
        messageId,
        content,
        ...result,
        bitget: getBitgetTradeStatus(),
        weex: getWeexTradeStatus(),
        tradePlatforms: getTradePlatformToggles(),
        requiredChannelIds: getAutoTradeChannelIds(),
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.get("/api/discord/context", (_req, res) => {
    res.json({ ok: true, snapshot: discordIngest.context.snapshot() });
  });

  app.get("/api/discord/cdp-active", (_req, res) => {
    res.json({ ok: true, ...discordIngest.getCdpPage() });
  });

  app.get("/api/discord/guilds", async (_req, res) => {
    try {
      const rows = await store.listDiscordGuilds();
      const guilds = rows.map((row) => ({
        guildId: row.guild_id,
        name: row.name,
        iconHash: row.icon_hash,
        iconUrl: row.icon_url,
        channelCount: Number(row.channel_count) || 0,
        updatedAt: row.updated_at,
      }));
      res.json({ ok: true, guilds });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.get("/api/discord/guilds/:guildId/channels", async (req, res) => {
    try {
      const guildId = String(req.params.guildId ?? "").trim();
      const rows = await store.listDiscordChannelsByGuild(guildId);
      const channels = rows.map((row) => ({
        channelId: row.channel_id,
        guildId: row.guild_id,
        name: row.name,
        type: row.channel_type,
        lastMessagePreview: row.last_message_preview,
        lastMessageAtMs: row.last_message_at_ms,
        updatedAt: row.updated_at,
      }));
      res.json({ ok: true, guildId, channels });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.get("/api/discord/messages", async (req, res) => {
    try {
      const limit = Math.min(500, Math.max(1, Number(req.query.limit) || 200));
      const channelId = String(req.query.channel_id ?? req.query.channelId ?? "").trim();
      const guildId = String(req.query.guild_id ?? req.query.guildId ?? "").trim();
      const orderParam = String(req.query.order ?? "asc").toLowerCase();
      const wantChronological = orderParam !== "desc";
      const rows = await store.listRecentMessages(
        limit,
        { channelId, guildId, order: "desc" },
        { includeRaw: isDebugMode() }
      );
      let clientRows = rows.map((row) => {
        const enriched = discordIngest.enrichForApi(row);
        if (!isDebugMode()) {
          enriched.rawJson = undefined;
        }
        return enriched;
      });
      if (wantChronological) clientRows = clientRows.reverse();
      res.json({ ok: true, debugMode: isDebugMode(), rows: clientRows });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.post("/api/cdp/discord-channel", async (req, res) => {
    const guildId = String(req.body?.guildId ?? req.query?.guild_id ?? "").trim();
    const channelId = String(req.body?.channelId ?? req.query?.channel_id ?? "").trim();
    const clientTraceId = String(req.body?.clientTraceId ?? "").trim() || undefined;
    const tracePayload = clientTraceId ? { clientTraceId } : {};

    if (!guildId || !channelId) {
      res.status(400).json({ ok: false, error: "缺少 guildId 或 channelId" });
      return;
    }
    if (typeof navigateDiscordImpl !== "function") {
      res.status(503).json({ ok: false, error: "CDP 尚未就绪" });
      return;
    }

    log.info(`[discord-channel] POST guild=${guildId} channel=${channelId}`);
    diagnosticSink({
      kind: "discord_channel_api_received",
      guildId,
      channelId,
      ...tracePayload,
    });

    try {
      const out = /** @type {{ ok?: boolean, error?: string, finalUrl?: string }} */ (
        await navigateDiscordImpl(guildId, channelId, clientTraceId ? { clientTraceId } : {})
      );
      if (out?.ok) {
        res.json({ ok: true, ...out, ...tracePayload });
      } else {
        res.status(500).json({ ok: false, error: out?.error ?? "导航失败", ...tracePayload });
      }
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e), ...tracePayload });
    }
  });

  /** @type {Awaited<ReturnType<typeof startCdpWebSocketMonitor>> | null} */
  let session = null;

  app.use(express.static(publicDir));

  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api")) return next();
    if (/\.\w+$/.test(req.path)) return next();
    res.sendFile(path.join(publicDir, "index.html"), (err) => (err ? next(err) : undefined));
  });

  app.use((req, res, next) => {
    if (!req.path.startsWith("/api")) return next();
    res.status(404).json({ ok: false, error: `API 不存在: ${req.method} ${req.path}` });
  });

  const shutdown = async (reason = "shutdown") => {
    log.info(`退出 (${reason})`);
    cardPriceMonitor.stop();
    await telegramPush.flushAll().catch((e) => log.warn(String(e?.message ?? e)));
    if (session) await session.close().catch((e) => log.warn(String(e?.message ?? e)));
    await store.close().catch((e) => log.warn(String(e?.message ?? e)));
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await killListenersOnPort(PORT, "collect:ui");

  let listenError = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      await new Promise((resolve, reject) => {
        const onError = (err) => {
          server.removeListener("listening", onListening);
          reject(err);
        };
        const onListening = () => {
          server.removeListener("error", onError);
          resolve(undefined);
        };
        server.once("error", onError);
        server.once("listening", onListening);
        server.listen(PORT, "127.0.0.1");
      });
      listenError = null;
      break;
    } catch (e) {
      listenError = e;
      if (/** @type {NodeJS.ErrnoException} */ (e).code === "EADDRINUSE" && attempt === 0) {
        log.warn(`端口 ${PORT} 仍被占用，再次尝试释放…`);
        await killListenersOnPort(PORT, "collect:ui");
        continue;
      }
      throw e;
    }
  }
  if (listenError) throw listenError;

  log.info(
    `Discord Collector UI  http://127.0.0.1:${PORT}/  |  /cards  |  /fetch  |  /archives  |  /debug  |  WS ws://127.0.0.1:${PORT}/ws`
  );
  if (mysqlOffline) {
    log.warn("MySQL 离线 — 服务已启动但无持久化；修复数据库后请重启 collect:ui");
  } else {
    cardPriceMonitor.start();
    if (store.migrateCoinActionPasteCards) {
      void store
        .migrateCoinActionPasteCards(COIN_ACTION_SIGNAL_CHANNEL_ID)
        .then((n) => {
          if (n > 0) log.info(`coin-action 卡片已迁移至颜驰（/signals）共 ${n} 条`);
        })
        .catch((e) => log.warn(`coin-action 迁移: ${/** @type {Error} */ (e).message}`));
    }
  }
  log.info(
    `[api] /api/cards /api/v1/cards /api/discord/signal-cards（debugMode=${isDebugMode()}）`
  );
  if (config.cdpConnectUrl) {
    log.info(`CDP 附加: ${config.cdpConnectUrl} — 请在 Chrome 中打开并登录 ${config.startUrl}`);
  }

  void (async () => {
    try {
      session = await startCdpWebSocketMonitor(
        {
          startUrl: config.startUrl,
          cdpConnectUrl: config.cdpConnectUrl,
          pageReloadIntervalMs: config.pageReloadIntervalMs,
          networkTrace: config.collectNetworkTrace,
          wsFrameTrace: config.collectWsFrameTrace,
          diagnosticSink,
          onConnectionLost: (info) => systemTelegram.notifyCdpDisconnected(info),
          onData(buf, meta) {
            frameSeq += 1;
            const { payload, proc } = buildFrameChannelPayload(
              buf,
              meta,
              frameSeq,
              config.requiredTopLevelKeys
            );
            if (isForwardableFramePayload(payload)) {
              broadcast("frame", { ...payload, debugMode: isDebugMode() });
              void discordIngest.onWsFrame(payload).catch((e) => {
                log.debug(`discord ingest ws: ${/** @type {Error} */ (e).message}`);
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
            }
          },
        },
        createLogger("cdp")
      );
      navigateDiscordImpl = (g, c, t) => session.navigateDiscordChannel(g, c, t);
      webhookForward.setBrowserPost((url, payload) => session.postWebhookViaBrowser(url, payload));
    } catch (e) {
      log.error(`CDP 启动失败: ${/** @type {Error} */ (e).message ?? e}`);
    }
  })();
}

main().catch((e) => {
  const err = /** @type {NodeJS.ErrnoException} */ (e);
  if (err?.code === "EADDRINUSE") {
    console.error(`\n[collect:ui] 端口 ${PORT} 无法绑定（EADDRINUSE）。`);
    console.error("旧进程可能处于僵死状态（macOS 上 STAT=UE 时 kill -9 无效）。");
    console.error("请关闭之前运行 collect:ui 的终端窗口后重试；");
    console.error(`或临时换端口: COLLECTOR_UI_PORT=3852 pnpm run collect:ui\n`);
  }
  console.error(e);
  process.exit(1);
});
