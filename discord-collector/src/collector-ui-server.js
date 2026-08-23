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
import { startCdpChannelRotate } from "./cdp-channel-rotate.js";
import { createShowLayoutStore } from "./show-layout-store.js";
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
import { findFreePortNear, killListenersOnPort } from "../scripts/kill-port.mjs";
import { startOiSupervisor } from "../scripts/oi-supervisor.mjs";
import { startContentSupervisor } from "../scripts/content-supervisor.mjs";
import { registerContentBoardProxy } from "./content-board-proxy.js";
import { registerYoutubeArchiveRoutes } from "./youtube-archives.js";
import { registerYoutubeFetchProxyRoutes } from "./youtube-fetch-proxy.js";
import { registerYoutubePasteParseRoutes } from "./youtube-paste-parse.js";
import { registerYoutubePasteBatchRoutes, startPasteBatchService } from "./youtube-paste-batch.js";
import { createCardArchiveService } from "./card-archive-service.js";
import { registerCardArchiveRoutes } from "./card-archive-api.js";
import { createCommunityFeedService } from "./community-feed-service.js";
import { registerCardEvalRoutes } from "./card-eval-api.js";
import { registerCommunityRoutes } from "./community-api.js";
import { createCardPriceMonitor } from "./card-price-monitor.js";
import { createCardExternalSink } from "./card-external-sink.js";
import { createBitgetOrderService } from "./bitget-order-service.js";
import { createWeexOrderService } from "./weex-order-service.js";
import { createBitgetManualService } from "./bitget-manual-service.js";
import { registerBitgetRoutes } from "./bitget-api-routes.js";
import { registerWeexRoutes } from "./weex-api-routes.js";
import { getBitgetProxyInUse } from "./bitget-api.js";
import { getWeexProxyInUse } from "./weex-api.js";
import { createTwitterCdpService } from "./twitter-cdp-service.js";
import { registerTwitterCdpRoutes } from "./twitter-cdp-api.js";
import {
  getAutoTradeChannelIds,
  getTradePlatformToggles,
  setTradePlatformToggles,
} from "./trade-platform-toggles.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, "..", "public", "collector-ui");
let PORT = Number.isFinite(config.collectUiPort) ? config.collectUiPort : 3851;

async function main() {
  setLogLevel(config.logLevel);
  setDebugMode(config.debugMode);
  const log = createLogger("ui-server");

  const app = express();
  const server = http.createServer(app);

  // 必须在 express.json 之前：否则 PUT/POST JSON body 已被读走，反代会空包
  registerContentBoardProxy(app, {
    baseUrl: config.contentBoardBaseUrl,
    log: createLogger("content-proxy"),
  });

  const wss = new WebSocketServer({ server, path: "/ws" });
  // 避免 listen EADDRINUSE 时 WSS 再抛未捕获 error 直接把进程打崩（导致端口回退逻辑跑不到）
  wss.on("error", (err) => {
    log.warn(`WebSocketServer: ${err?.message ?? err}`);
  });
  server.on("error", (err) => {
    // listen() Promise 会自行 reject；这里只防未监听阶段的冒泡
    if (/** @type {NodeJS.ErrnoException} */ (err).code !== "EADDRINUSE") {
      log.warn(`HTTP server: ${err?.message ?? err}`);
    }
  });

  /** @type {ReturnType<typeof import("./card-archive-list-cache.js").createCardArchiveListCache> | null} */
  let cardArchiveListCache = null;

  /** @param {string} channel @param {Record<string, unknown>} payload */
  function broadcast(channel, payload) {
    if (channel === "meta" && cardArchiveListCache) {
      const kind = payload.kind;
      if (kind === "card_archived" && payload.card && typeof payload.card === "object") {
        cardArchiveListCache.onClientCardChanged(
          /** @type {ReturnType<typeof import("./card-archive-service.js").archiveCardToClient>} */ (
            payload.card
          )
        );
      } else if (
        (kind === "signal_card_created" || kind === "signal_card_updated") &&
        payload.card &&
        typeof payload.card === "object"
      ) {
        const id = Number(/** @type {Record<string, unknown>} */ (payload.card).id);
        if (Number.isFinite(id) && id > 0) {
          void store.getSignalCardById(id).then((row) => row && cardArchiveListCache?.onRowChanged(row));
        }
      } else if (kind === "signal_card_deleted") {
        const cardId = Number(payload.cardId);
        if (Number.isFinite(cardId) && cardId > 0) cardArchiveListCache.removeFromBuckets(cardId);
      }
    }
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
    const wxProxy = getWeexProxyInUse();
    log.info(
      `WEEX 自动交易 enabled ${wxCfg.dryRun ? "dryRun=模拟" : "LIVE=实盘"}${wxProxy ? ` proxy=${wxProxy}` : "（未配置代理）"}（参数与 Bitget 共用）`
    );
  }
  const cardSink = createCardExternalSink(createLogger("card-sink"));
  cardSink.start();
  const communityFeed = createCommunityFeedService(store, createLogger("community-feed"), broadcast);
  const signalCards = createDiscordSignalCardService(store, createLogger("signal"), broadcast, {
    bitgetOrder,
    weexOrder,
    cardSink,
    communityFeed,
  });
  const cardArchive = createCardArchiveService(store, createLogger("card-archive"), broadcast, {
    cardSink,
    communityFeed,
    telegram: signalCards.telegram,
  });
  const twitterCdp = createTwitterCdpService(store, createLogger("twitter-cdp"), broadcast, {
    communityFeed,
  });
  const cardPriceMonitor = createCardPriceMonitor(
    store,
    createLogger("card-price"),
    systemTelegram,
    broadcast,
    { bitgetOrder, weexOrder }
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
  const { listCache: cardArchiveListCacheRef } = registerCardArchiveRoutes(app, store, cardArchive, broadcast);
  cardArchiveListCache = cardArchiveListCacheRef;
  registerCardEvalRoutes(app, store);
  registerTwitterCdpRoutes(app, twitterCdp);
  registerCommunityRoutes(app, store, createLogger("community"), broadcast, { communityFeed });
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
  startPasteBatchService(config, pasteBatchLog, { archiveService: cardArchive });

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

  /** OI Monitor 模块：探测后端是否在跑，并返回 iframe 嵌入地址 */
  app.get("/api/oi/status", async (_req, res) => {
    const apiBase = config.oiWebBaseUrl;
    const timeoutMs = Number.isFinite(config.oiHealthTimeoutMs) ? config.oiHealthTimeoutMs : 3_000;
    /** 浏览器可访问的嵌入地址（上云时用公网 / frp 口，勿把 127.0.0.1 给访客） */
    const publicEmbed =
      config.oiPublicEmbedUrl || config.oiEmbedUrl || apiBase;
    /** @type {{ ok: boolean, active: boolean, apiBase: string, embedUrl: string, publicEmbedUrl: string, latencyMs?: number, error?: string, hint?: string }} */
    const out = {
      ok: true,
      active: false,
      apiBase,
      embedUrl: publicEmbed,
      publicEmbedUrl: publicEmbed,
      hint: "oi_mornitor 由 collect:ui 自动守护；也可手动：pnpm run oi:start；上云需 OI_PUBLIC_EMBED_URL + frp 映射 8766",
    };

    /** @param {string} url */
    async function probe(url) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) return false;
        // 读一小段即可；避免旧探活拉满 /api/snapshot（数 MB）被超时截断
        const text = await r.text();
        return text.trim().length > 0;
      } catch {
        return false;
      } finally {
        clearTimeout(timer);
      }
    }

    const t0 = Date.now();
    try {
      // 优先轻量 /api/health；旧实例无此路由时回退 /api/patterns
      let up = await probe(`${apiBase}/api/health`);
      if (!up) up = await probe(`${apiBase}/api/patterns`);
      out.latencyMs = Date.now() - t0;
      if (!up) {
        out.error = `无法连接 ${apiBase}（/api/health 或 /api/patterns）`;
        res.json(out);
        return;
      }
      out.active = true;
      out.hint = undefined;
      // 仅本地开发且未配公网嵌入时：优先 Vite 热更新
      if (!config.oiPublicEmbedUrl && !config.oiEmbedUrl) {
        const viteDev = "http://127.0.0.1:5173";
        if (await probe(viteDev + "/")) {
          out.embedUrl = viteDev;
          out.publicEmbedUrl = viteDev;
        }
      }
      res.json(out);
    } catch (e) {
      out.latencyMs = Date.now() - t0;
      out.error = String(/** @type {Error} */ (e).message ?? e);
      res.json(out);
    }
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
          open: "#ORDI 市價空 進場3.958",
          tpsl: "止盈：3.799-3.685\n止损4.13",
        },
        tw_opg: {
          open: "#EPIC 市價進空",
          tpsl: "槓桿建議：穩健10x\n倉位建議：總資金的5%\n第二止盈：0.6294\n第三止盈：0.59\n止損：0.8411",
        },
      },
      hints: [
        "回车提交；Shift+Enter 换行",
        "Debug 模式：跳过去重 / 不走 Ollama，响应更快",
        "第 1 条通常为市价开仓（Bitget + WEEX 同步，BTC/ETH 100x / 山寨 30x）",
        "开仓同时挂市价 -4.3% 初始止损",
        "第 2 条通常为 TP/SL 补充（20 分钟内合并到同币种未完结卡片；山寨之王 / seven）",
        "正式 Discord 信号仍保留 4h 同币种去重",
        "下方勾选控制 Bitget / WEEX 是否下单（localStorage + 服务端同步）；频道须在 BITGET_AUTO_TRADE_CHANNEL_IDS",
        "主流币 BTC/ETH 不自动交易，仅山寨币自动下单",
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

  const showLayoutStore = createShowLayoutStore();

  /** Show 布局（置顶等）：本地前端可写；域名前端仅首读 */
  app.get("/api/show/layout", async (_req, res) => {
    try {
      const { layout, updatedAt } = await showLayoutStore.read();
      res.json({ ok: true, layout, updatedAt, file: showLayoutStore.filePath });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.put("/api/show/layout", async (req, res) => {
    const allowRemote = ["1", "true", "yes", "on"].includes(
      String(process.env.SHOW_LAYOUT_ALLOW_REMOTE_WRITE ?? "0").toLowerCase()
    );
    const ip = String(req.socket?.remoteAddress ?? "");
    const isLoopback =
      ip === "127.0.0.1" ||
      ip === "::1" ||
      ip === "::ffff:127.0.0.1" ||
      ip.endsWith("127.0.0.1");
    if (!allowRemote && !isLoopback) {
      res.status(403).json({
        ok: false,
        error: "仅本机可写入 Show 布局（域名客户端请用 localStorage）",
      });
      return;
    }
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const layoutRaw = body.layout != null ? body.layout : body;
      const { layout, updatedAt } = await showLayoutStore.write(layoutRaw);
      log.info(`[show-layout] 已保存置顶/布局 updatedAt=${updatedAt}`);
      res.json({ ok: true, layout, updatedAt });
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

  /** 部署后多人/连点：同一频道短时间合并为一次 CDP 导航 */
  const CDP_NAV_DEBOUNCE_MS = Math.max(
    3_000,
    Number(process.env.COLLECTOR_CDP_NAV_DEBOUNCE_MS) || 10_000
  );
  let lastCdpNavKey = "";
  let lastCdpNavAt = 0;
  /** @type {Promise<unknown> | null} */
  let cdpNavInFlight = null;

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

    const navKey = `${guildId}/${channelId}`;
    const now = Date.now();
    if (navKey === lastCdpNavKey && now - lastCdpNavAt < CDP_NAV_DEBOUNCE_MS) {
      log.info(
        `[discord-channel] 防抖跳过 guild=${guildId} channel=${channelId}（${CDP_NAV_DEBOUNCE_MS}ms 内）`
      );
      res.json({
        ok: true,
        skipped: true,
        reason: "debounce",
        debounceMs: CDP_NAV_DEBOUNCE_MS,
        ...tracePayload,
      });
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
      // 串行化：避免并发 goto 互相踩
      if (cdpNavInFlight) {
        await cdpNavInFlight.catch(() => {});
        if (navKey === lastCdpNavKey && Date.now() - lastCdpNavAt < CDP_NAV_DEBOUNCE_MS) {
          res.json({
            ok: true,
            skipped: true,
            reason: "debounce_after_wait",
            debounceMs: CDP_NAV_DEBOUNCE_MS,
            ...tracePayload,
          });
          return;
        }
      }
      lastCdpNavKey = navKey;
      lastCdpNavAt = Date.now();
      const run = Promise.resolve(
        navigateDiscordImpl(guildId, channelId, clientTraceId ? { clientTraceId } : {})
      );
      cdpNavInFlight = run.finally(() => {
        if (cdpNavInFlight === run) cdpNavInFlight = null;
      });
      const out = /** @type {{ ok?: boolean, error?: string, finalUrl?: string, skipped?: boolean }} */ (
        await run
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
  /** @type {{ stop: () => void } | null} */
  let channelRotate = null;

  const avatarsDir = path.join(__dirname, "..", "public", "community-avatars");
  app.use("/community-avatars", express.static(avatarsDir, { fallthrough: false, index: false }));

  // Telegram 频道头像：仓库 telegram/avatar/{chatId}.png → GET /telegram-avatars/...
  const telegramAvatarsDir = path.join(__dirname, "..", "..", "telegram", "avatar");
  app.use("/telegram-avatars", express.static(telegramAvatarsDir, { fallthrough: false, index: false }));

  app.use(express.static(publicDir));

  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api")) return next();
    if (req.path.startsWith("/community-avatars")) return next();
    if (req.path.startsWith("/telegram-avatars")) return next();
    if (/\.\w+$/.test(req.path)) return next();
    res.sendFile(path.join(publicDir, "index.html"), (err) => (err ? next(err) : undefined));
  });

  app.use((req, res, next) => {
    if (!req.path.startsWith("/api")) return next();
    res.status(404).json({ ok: false, error: `API 不存在: ${req.method} ${req.path}` });
  });

  const shutdown = async (reason = "shutdown") => {
    log.info(`退出 (${reason})`);
    channelRotate?.stop();
    channelRotate = null;
    cardPriceMonitor.stop();
    twitterCdp.stop();
    cardSink.stop();
    await telegramPush.flushAll().catch((e) => log.warn(String(e?.message ?? e)));
    if (session) await session.close().catch((e) => log.warn(String(e?.message ?? e)));
    await store.close().catch((e) => log.warn(String(e?.message ?? e)));
    server.close(() => process.exit(0));
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));

  await killListenersOnPort(PORT, "collect:ui");

  let listenError = null;
  for (let attempt = 0; attempt < 3; attempt++) {
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
      if (/** @type {NodeJS.ErrnoException} */ (e).code !== "EADDRINUSE") throw e;
      log.warn(`端口 ${PORT} 仍被占用，再次尝试释放…`);
      await killListenersOnPort(PORT, "collect:ui");
      if (attempt === 1) {
        const alt = await findFreePortNear(PORT + 1, 20);
        if (alt != null) {
          log.warn(`改用空闲端口 ${alt}（原 ${PORT} 可能为僵死占用）`);
          PORT = alt;
          continue;
        }
      }
    }
  }
  if (listenError) throw listenError;

  log.info(
    `Discord Collector UI  http://127.0.0.1:${PORT}/  |  /cards  |  /fetch  |  /twitter  |  /archives  |  /debug  |  WS ws://127.0.0.1:${PORT}/ws`
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
  void twitterCdp.start().catch((e) =>
    log.warn(`Twitter CDP 启动: ${/** @type {Error} */ (e).message}`)
  );

  const oiSupervisor = startOiSupervisor({
    log: createLogger("oi-supervisor"),
    apiBase: config.oiWebBaseUrl,
    enabled: config.oiAutoStart,
    checkIntervalMs: config.oiSupervisorIntervalMs,
  });
  const contentSupervisor = startContentSupervisor({
    log: createLogger("content-supervisor"),
    baseUrl: config.contentBoardBaseUrl,
    enabled: config.contentBoardAutoStart,
    checkIntervalMs: config.contentBoardSupervisorIntervalMs,
  });
  process.once("SIGINT", () => {
    oiSupervisor.stop();
    contentSupervisor.stop();
  });
  process.once("SIGTERM", () => {
    oiSupervisor.stop();
    contentSupervisor.stop();
  });

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
          cdpAutoGoto: config.cdpAutoGoto,
          cdpVisibilityKeepalive: config.cdpVisibilityKeepalive,
          networkTrace: config.collectNetworkTrace,
          wsFrameTrace: config.collectWsFrameTrace,
          diagnosticSink,
          onConnectionLost: (info) => systemTelegram.notifyCdpDisconnected(info),
          onReconnected: (info) => systemTelegram.notifyCdpReconnected?.(info),
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
      channelRotate?.stop();
      channelRotate = startCdpChannelRotate({
        enabled: config.cdpChannelRotate,
        intervalMs: config.cdpChannelRotateIntervalMs,
        dwellMs: config.cdpChannelRotateDwellMs,
        startUrl: config.startUrl,
        navigate: (g, c) => session.navigateDiscordChannel(g, c),
        log: createLogger("channel-rotate"),
      });
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
