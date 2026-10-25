#!/usr/bin/env node
/**
 * Discord CDP 采集 + HTTP 静态 UI + WebSocket 实时推送。
 */
import "./load-env.js";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { WebSocketServer } from "ws";

import { buildFrameChannelPayload, jsonWire } from "./collect-ws-decode.js";
import { applyDiscordGroupsChannelList, config } from "./config.js";
import { startCdpWebSocketMonitor } from "./cdp-ws-monitor.js";
import { startCdpChannelRotate } from "./cdp-channel-rotate.js";
import { createShowLayoutStore } from "./show-layout-store.js";
import { createDiscordMessageIngest } from "./discord-message-ingest.js";
import { createDiscordSignalCardService } from "./discord-signal-card-service.js";
import { createDiscordTelegramMessagePush } from "./discord-telegram-message-push.js";
import { createDiscordWebhookForward } from "./discord-webhook-forward.js";
import { createSystemTelegramAlert } from "./discord-system-telegram.js";
import { registerDiscordSignalRoutes } from "./discord-signal-api.js";
import { COIN_ACTION_SIGNAL_CHANNEL_ID, getSignalChannelIds } from "./discord-signal-config.js";
import { getBitgetTradeStatus, loadBitgetTradeConfig } from "./bitget-trade-config.js";
import { getWeexTradeStatus, loadWeexTradeConfig } from "./weex-trade-config.js";
import { parseTelegramTradeTextLite, buildDefaultTelegramExitPlan } from "./telegram-auto-trade.js";
import {
  isCdpSendChannel,
  listTelegramSendChannelsWithNames,
  readTelegramChannelProfiles,
} from "./telegram-channel-profiles.js";
import { getDebugConfig, isDebugMode, setDebugMode } from "./discord-debug.js";
import {
  isBlockedWsPayload,
  isDiscordGatewayPayload,
  isForwardableFramePayload,
} from "./ws-noise-filter.js";
import { createLogger, setLogLevel } from "./logger.js";
import { hashBuffer, tryOpenStore } from "./store.js";
import { findFreePortNear, killListenersOnPort } from "../scripts/kill-port.mjs";
import { startOiSupervisor } from "../scripts/oi-supervisor.mjs";
import { startContentSupervisor } from "../scripts/content-supervisor.mjs";
import { startNewsSupervisor } from "../scripts/news-supervisor.mjs";
import { startTelegramSupervisor } from "../scripts/telegram-supervisor.mjs";
import { registerContentBoardProxy } from "./content-board-proxy.js";
import { registerNewsEmbedProxy, NEWS_EMBED_MOUNT } from "./news-embed-proxy.js";
import {
  registerNewsFeedProxy,
  NEWS_FEED_MOUNT,
  NEWS_FEED_ROUTES_VERSION,
} from "./news-feed-proxy.js";
import { isTrapMainSiteNewsEmbed, sanitizePublicNewsEmbedUrl } from "./news-embed-url.js";
import { registerYoutubeArchiveRoutes } from "./youtube-archives.js";
import { registerYoutubeFetchProxyRoutes } from "./youtube-fetch-proxy.js";
import { registerYoutubePasteParseRoutes } from "./youtube-paste-parse.js";
import { registerYoutubePasteBatchRoutes, startPasteBatchService } from "./youtube-paste-batch.js";
import { createCardArchiveService } from "./card-archive-service.js";
import { registerCardArchiveRoutes, requireOpenApiKey } from "./card-archive-api.js";
import { createCommunityFeedService } from "./community-feed-service.js";
import { registerCardEvalRoutes } from "./card-eval-api.js";
import { registerCardValidateRoutes } from "./card-validate-api.js";
import { registerTelegramPromRoutes } from "./telegram-prom-api.js";
import { registerTelegramLiveRoutes } from "./telegram-live-api.js";
import { registerTelegramBackfillRoutes } from "./telegram-backfill-api.js";
import { registerDiscordBackfillRoutes } from "./discord-backfill-api.js";
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
  getTradeOrderSizeUsdt,
  setTradeOrderSizeUsdt,
  setTradePlatformToggles,
} from "./trade-platform-toggles.js";
import { isChannelShowHistoryFresh } from "./discord-show-history-cache.js";
import { registerDiscordCdnProxyRoutes } from "./discord-cdn-proxy.js";
import { extractAttachmentsForClient } from "./discord-message-format.js";

/** 慢客户端：超过 soft 跳过 diag/frame；超过 hard 断开（防 WS 发送队列撑爆堆） */
const showHistoryWarmInflight = new Map();

/** @param {number} ms */
function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

const WS_SEND_BUFFER_SOFT = 2 * 1024 * 1024;
const WS_SEND_BUFFER_HARD = 16 * 1024 * 1024;

/**
 * Debug 页只需要摘要；完整对象走 ingest，勿经 WS 扇出。
 * @param {Record<string, unknown>} evt
 */
function summarizeDiagForBroadcast(evt) {
  /** @type {Record<string, unknown>} */
  const out = { ...evt, debugMode: isDebugMode() };
  if (out.parsedJson != null) {
    const w = jsonWire(out.parsedJson, 32_000);
    if (w.truncated) {
      out.parsedJson = null;
      out.parsedSnippet = w.snippet ?? null;
      out.parsedJsonTruncated = true;
    } else {
      out.parsedJson = w.json;
    }
  }
  if (out.bodyJson != null) {
    const w = jsonWire(out.bodyJson, 48_000);
    if (w.truncated) {
      out.bodyJson = null;
      out.bodySnippet = w.snippet ?? null;
      out.responseBodyTruncated = true;
    } else {
      out.bodyJson = w.json;
    }
  }
  if (typeof out.bodyRawText === "string" && out.bodyRawText.length > 8_000) {
    out.bodyRawText = `${out.bodyRawText.slice(0, 8_000)}…`;
    out.responseBodyTruncated = true;
  }
  return out;
}

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
  registerNewsEmbedProxy(app, {
    baseUrl: config.newsWebBaseUrl,
    log: createLogger("news-embed-proxy"),
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
    const dropHeavy = channel === "diag" || channel === "frame";
    for (const client of wss.clients) {
      if (client.readyState !== 1) continue;
      const buffered = Number(client.bufferedAmount) || 0;
      if (buffered > WS_SEND_BUFFER_HARD) {
        try {
          client.terminate();
        } catch {
          /* ignore */
        }
        continue;
      }
      if (dropHeavy && buffered > WS_SEND_BUFFER_SOFT) continue;
      try {
        client.send(msg);
      } catch {
        /* ignore broken socket */
      }
    }
  }

  const storeLog = createLogger("store");
  const { store, offline: mysqlOffline, hint: mysqlHint } = await tryOpenStore(config.mysql, storeLog);
  const telegramPush = createDiscordTelegramMessagePush(createLogger("telegram-push"));
  const webhookForward = createDiscordWebhookForward(createLogger("webhook-forward"));
  const systemTelegram = createSystemTelegramAlert(createLogger("system-telegram"), {
    cdpNotifyDisconnect: config.cdpTelegramNotifyDisconnect,
    cdpNotifyConnect: config.cdpTelegramNotifyConnect,
    cdpDisconnectNotifyAfterMs: config.cdpTelegramDisconnectAfterMs,
  });
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
    bitgetOrder,
    weexOrder,
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
    // 采集路径始终走 ingest；WS diag 仅 debug 模式，且做体积截断 + 背压
    void discordIngest.onDiag(evt).catch((e) => {
      log.warn(`discord ingest diag: ${/** @type {Error} */ (e).message}`);
    });
    if (!isDebugMode()) return;
    if (
      evt.kind === "ws_frame_parsed" &&
      evt.parsedJson != null &&
      !isDiscordGatewayPayload(evt.parsedJson)
    ) {
      return;
    }
    broadcast("diag", summarizeDiagForBroadcast(evt));
  };

  app.use(express.json({ limit: "512kb" }));

  registerDiscordCdnProxyRoutes(app, createLogger("discord-cdn"));

  registerDiscordSignalRoutes(app, store, signalCards, broadcast);
  registerBitgetRoutes(app, bitgetOrder, bitgetManual);
  registerWeexRoutes(app, weexOrder);
  const { listCache: cardArchiveListCacheRef } = registerCardArchiveRoutes(app, store, cardArchive, broadcast);
  cardArchiveListCache = cardArchiveListCacheRef;
  registerCardEvalRoutes(app, store, { requireOpenApiKey });
  registerCardValidateRoutes(app, store, cardArchiveListCacheRef, broadcast, { requireOpenApiKey });
  registerTelegramPromRoutes(app, store, cardArchiveListCacheRef, broadcast, { requireOpenApiKey });
  /** @type {() => Record<string, unknown>} */
  let getTelegramListenStatus = () => ({ running: null, managed: false });
  registerTelegramLiveRoutes(app, broadcast, { getListenStatus: () => getTelegramListenStatus() });
  registerTelegramBackfillRoutes(app);
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
  /** @type {((guildId: string, channelId: string, traceCtx?: { clientTraceId?: string }) => Promise<unknown>) | null} */
  let scrollDiscordHistoryImpl = null;
  registerDiscordBackfillRoutes(app, {
    store,
    getScrollImpl: () => scrollDiscordHistoryImpl,
    getNavigateImpl: () => navigateDiscordImpl,
  });
  /** @type {{ state: 'disabled' | 'pending' | 'ready' | 'error', attempt: number, error?: string }} */
  let cdpBoot = { state: config.cdpConnectUrl ? "pending" : "disabled", attempt: 0 };

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

  /** @type {Awaited<ReturnType<typeof startCdpWebSocketMonitor>> | null} */
  let session = null;

  function countDiscordMountedTabs() {
    const mounted = session?.mounted;
    if (!Array.isArray(mounted)) return 0;
    let n = 0;
    for (const entry of mounted) {
      try {
        const u = String(entry?.page?.url?.() ?? "");
        if (/discord\.com/i.test(u)) n += 1;
      } catch {
        /* page disposed */
      }
    }
    return n;
  }

  function cdpStatusSnapshot() {
    const ready = typeof navigateDiscordImpl === "function" && Boolean(session);
    const mountedTabs = Array.isArray(session?.mounted)
      ? session.mounted.length
      : Number(session?.mounted) || 0;
    const discordTabs = ready ? countDiscordMountedTabs() : 0;
    let hint = null;
    if (!config.cdpConnectUrl) {
      hint = "未配置 CDP_CONNECT_URL，Gateway 不会采集";
    } else if (!ready) {
      hint =
        "CDP 未就绪：请确认 Chrome 已 --remote-debugging-port=9222 且已登录 Discord；collect:ui 会自动重试";
    } else if (discordTabs <= 0) {
      hint =
        `CDP 已连接但未检测到 discord.com 标签：将自动打开 ${config.cdpDiscordUrl}（需 COLLECTOR_CDP_AUTO_GOTO≠0）。请确保 Chrome 已登录 Discord。`;
    }
    return {
      state: cdpBoot.state,
      ready,
      connectUrl: config.cdpConnectUrl || null,
      mountedTabs,
      discordTabs,
      bootAttempt: cdpBoot.attempt,
      bootError: cdpBoot.error || null,
      hint,
    };
  }

  app.get("/api/health", (_req, res) => {
    res.json({
      ok: true,
      mysql: !mysqlOffline,
      mysqlHint: mysqlOffline ? mysqlHint : undefined,
      mysqlHost: config.mysql.host,
      mysqlPort: config.mysql.port,
      mysqlDatabase: config.mysql.database,
      cdp: cdpStatusSnapshot(),
    });
  });

  /** OI Monitor 模块：探测后端是否在跑，并返回 iframe 嵌入地址 */
  app.get("/api/oi/status", async (_req, res) => {
    const apiBase = config.oiWebBaseUrl;
    const timeoutMs = Number.isFinite(config.oiHealthTimeoutMs) ? config.oiHealthTimeoutMs : 3_000;
    /** 浏览器 iframe 用公网 OI 站；勿回落到 127.0.0.1（访客浏览器不可达） */
    const publicEmbed = (config.oiPublicEmbedUrl || config.oiEmbedUrl || "").replace(/\/$/, "");
    const devEmbed = (config.oiEmbedUrl || apiBase).replace(/\/$/, "");
    /** @type {{ ok: boolean, active: boolean, apiBase: string, embedUrl: string, publicEmbedUrl: string, localEmbedUrl: string, latencyMs?: number, error?: string, hint?: string, uiBuild?: string }} */
    const out = {
      ok: true,
      active: false,
      apiBase,
      embedUrl: publicEmbed,
      publicEmbedUrl: publicEmbed,
      localEmbedUrl: "",
      hint: publicEmbed
        ? undefined
        : "主站 /oi 需 OI_PUBLIC_EMBED_URL（如 https://op.b.ezcoin.ink）；本机健康检查仍用 OI_WEB_BASE_URL",
    };

    /** @param {string} url */
    async function probe(url) {
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(url, { signal: ctrl.signal });
        if (!r.ok) return { ok: false, uiBuild: "" };
        const text = await r.text();
        if (!text.trim()) return { ok: false, uiBuild: "" };
        let uiBuild = "";
        try {
          const j = JSON.parse(text);
          if (j && typeof j.ui_build === "string") uiBuild = j.ui_build;
        } catch {
          /* patterns 等非 JSON 探活 */
        }
        return { ok: true, uiBuild };
      } catch {
        return { ok: false, uiBuild: "" };
      } finally {
        clearTimeout(timer);
      }
    }

    /**
     * 拉公网 OI 嵌入站首页，判断是否误部署了 collector-ui 主站。
     * @param {string} base
     */
    async function peekPublicEmbedPage(base) {
      const root = String(base || "").replace(/\/$/, "");
      if (!root) return { asset: "", isCollectorUi: false };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(`${root}/?_=${Date.now()}`, {
          signal: ctrl.signal,
          headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
        });
        if (!r.ok) return { asset: "", isCollectorUi: false };
        const html = await r.text();
        const isCollectorUi = /<title>\s*discord-collector\s*<\/title>/i.test(html);
        const m = html.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/);
        return { asset: m ? m[1] : "", isCollectorUi };
      } catch {
        return { asset: "", isCollectorUi: false };
      } finally {
        clearTimeout(timer);
      }
    }

    /** @param {string} base */
    async function peekIndexAssetBuild(base) {
      const { asset } = await peekPublicEmbedPage(base);
      return asset;
    }

    const t0 = Date.now();
    try {
      // 优先轻量 /api/health；旧实例无此路由时回退 /api/patterns
      let up = await probe(`${apiBase}/api/health`);
      if (!up.ok) up = await probe(`${apiBase}/api/patterns`);
      out.latencyMs = Date.now() - t0;
      if (!up.ok) {
        out.error = `无法连接 ${apiBase}（/api/health 或 /api/patterns）`;
        res.json(out);
        return;
      }
      out.active = true;
      out.hint = undefined;
      const assetBuild = await peekIndexAssetBuild(apiBase);
      const uiBuild = assetBuild || up.uiBuild || "";
      if (uiBuild) out.uiBuild = uiBuild;
      const localBase = (config.oiEmbedUrl || devEmbed).replace(/\/$/, "");
      const localWithCache = uiBuild
        ? `${localBase}/?v=${encodeURIComponent(uiBuild)}`
        : `${localBase}/`;
      out.localEmbedUrl = localWithCache;

      if (publicEmbed) {
        const publicPage = await peekPublicEmbedPage(publicEmbed);
        if (publicPage.isCollectorUi) {
          out.embedDeployError = `公网 OI 地址 ${publicEmbed} 当前是 discord-collector 主站（title=discord-collector），不是 OI React。请在 op.b 仅部署 oi_mornitor/public/oi-dist，勿上传 public/collector-ui。`;
          out.embedUrl = "";
          out.publicEmbedUrl = "";
          out.hint = out.embedDeployError;
        } else {
          const assetForPublic = publicPage.asset || uiBuild;
          const withCacheBust = assetForPublic
            ? `${publicEmbed}/?v=${encodeURIComponent(assetForPublic)}`
            : `${publicEmbed}/`;
          out.embedUrl = withCacheBust;
          out.publicEmbedUrl = withCacheBust;
        }
      } else {
        out.embedUrl = "";
        out.publicEmbedUrl = "";
        out.hint =
          "未配置 OI_PUBLIC_EMBED_URL；访客浏览器请设为主站独立 OI 域名（如 https://op.b.ezcoin.ink）";
      }
      res.json(out);
    } catch (e) {
      out.latencyMs = Date.now() - t0;
      out.error = String(/** @type {Error} */ (e).message ?? e);
      res.json(out);
    }
  });

  // 与 /api/news/status 同区注册，避免线上只更 status 漏掉 feed
  registerNewsFeedProxy(app, {
    baseUrl: config.newsWebBaseUrl,
    log: createLogger("news-feed-proxy"),
  });

  /** 平台热点（news_mornitor）：探测后端并返回 iframe 嵌入地址 */
  app.get("/api/news/status", async (req, res) => {
    const apiBase = config.newsWebBaseUrl;
    const timeoutMs = Number.isFinite(config.newsHealthTimeoutMs)
      ? config.newsHealthTimeoutMs
      : 3_000;
    const configuredRaw = String(
      config.newsPublicEmbedUrl || config.newsEmbedUrl || "",
    ).trim();
    const localProxyEmbed = `${NEWS_EMBED_MOUNT}/`;
    const configuredPublic = configuredRaw
      ? sanitizePublicNewsEmbedUrl(configuredRaw, localProxyEmbed).replace(/\/$/, "")
      : "";
    if (configuredRaw && isTrapMainSiteNewsEmbed(configuredRaw)) {
      /** @type {{ ok: boolean, active: boolean, embedDeployError: string, hint: string }} */
      const bad = {
        ok: true,
        active: false,
        embedDeployError: `NEWS_PUBLIC_EMBED_URL 指向主站路由（${configuredRaw}），已忽略；请留空或改为 ${NEWS_EMBED_MOUNT}/`,
        hint: `生产 iframe 只用 ${NEWS_EMBED_MOUNT}/ 或独立域名，勿填 /show、/news`,
      };
      res.json({
        ...bad,
        apiBase,
        embedUrl: localProxyEmbed,
        publicEmbedUrl: localProxyEmbed,
        localEmbedUrl: `${String(apiBase).replace(/\/$/, "")}/`,
      });
      return;
    }
    /** @type {{ ok: boolean, active: boolean, apiBase: string, embedUrl: string, publicEmbedUrl: string, localEmbedUrl?: string, latencyMs?: number, error?: string, hint?: string, uiBuild?: string, service?: string, embedDeployError?: string }} */
    const out = {
      ok: true,
      active: false,
      apiBase,
      embedUrl: configuredPublic || localProxyEmbed,
      publicEmbedUrl: configuredPublic || localProxyEmbed,
      localEmbedUrl: `${String(apiBase).replace(/\/$/, "")}/`,
      hint: "news_mornitor（金十+PANews）由 collect:ui 自动守护；也可：pnpm run news:start",
    };

    /**
     * @param {string} root 可访问的 news 首页（本机 :8770 或公网独立站）
     * @returns {Promise<{ uiBuild: string, isCollectorUi: boolean, wrongService: boolean }>}
     */
    async function peekNewsPage(root) {
      const base = String(root || "").replace(/\/$/, "");
      if (!base) return { uiBuild: "", isCollectorUi: false, wrongService: false };
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      try {
        const r = await fetch(`${base}/?_=${Date.now()}`, {
          signal: ctrl.signal,
          headers: { "Cache-Control": "no-cache", Pragma: "no-cache" },
        });
        if (!r.ok) return { uiBuild: "", isCollectorUi: false, wrongService: false };
        const html = await r.text();
        if (/<title>\s*discord-collector\s*<\/title>/i.test(html)) {
          return { uiBuild: "", isCollectorUi: true, wrongService: false };
        }
        if (/华尔街见闻|CryptoPulse|AkShare/i.test(html)) {
          return { uiBuild: "", isCollectorUi: false, wrongService: true };
        }
        const m =
          html.match(/static\/app\.js\?v=([^"'&\s]+)/) ||
          html.match(/\/static\/app\.js\?v=([^"'&\s]+)/);
        return {
          uiBuild: m ? m[1] : "",
          isCollectorUi: false,
          wrongService: false,
        };
      } catch {
        return { uiBuild: "", isCollectorUi: false, wrongService: false };
      } finally {
        clearTimeout(timer);
      }
    }

    const t0 = Date.now();
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${apiBase}/api/v1/health`, { signal: ctrl.signal });
      out.latencyMs = Date.now() - t0;
      if (!r.ok) {
        out.error = `无法连接 ${apiBase}/api/v1/health (HTTP ${r.status})`;
        res.json(out);
        return;
      }
      const health = await r.json().catch(() => null);
      const service = health && typeof health.service === "string" ? health.service : "";
      out.service = service || undefined;
      if (service && service !== "news_mornitor") {
        out.error = `:8770 当前是 ${service}（华尔街见闻/AkShare），不是金十/PANews 版；请停掉 auto-deal-eth CryptoPulse，或等 collect:ui 守护替换`;
        out.hint =
          "两端都默认占用 8770。保留 discord-collector 的 news:start；不要同时跑 auto-deal-eth news_mornitor";
        res.json(out);
        return;
      }
      const backendPage = await peekNewsPage(apiBase);
      if (backendPage.wrongService) {
        out.error =
          "嵌入页仍是 CryptoPulse（华尔街见闻），币圈日历 tab 不会出现；请重启 collect:ui 让守护换回本仓 news_mornitor";
        res.json(out);
        return;
      }

      let browserBase = configuredPublic || localProxyEmbed;
      if (!configuredPublic) {
        const host = String(req.get("x-forwarded-host") || req.get("host") || "").split(",")[0].trim();
        const proto = String(req.get("x-forwarded-proto") || req.protocol || "https").split(",")[0].trim();
        if (host) {
          const probeRoot = `${proto}://${host}${NEWS_EMBED_MOUNT}`;
          const edgePage = await peekNewsPage(probeRoot);
          if (edgePage.isCollectorUi) {
            out.embedDeployError = `${NEWS_EMBED_MOUNT} 仍落到主站 SPA（iframe 会跳到 /show）。请 ui:build 同步 news-embed 静态，且 Nginx 勿对 ${NEWS_EMBED_MOUNT} 单独 try_files 到 index.html`;
            out.error = out.embedDeployError;
            out.active = false;
            out.embedUrl = localProxyEmbed;
            out.publicEmbedUrl = localProxyEmbed;
            res.json(out);
            return;
          }
        }
      }
      if (configuredPublic) {
        const publicPage = await peekNewsPage(configuredPublic);
        if (publicPage.isCollectorUi) {
          out.embedDeployError = `NEWS_PUBLIC_EMBED_URL（${configuredPublic}）当前是 discord-collector 主站，不是平台热点页；请改为独立域名或删除该配置以使用 ${NEWS_EMBED_MOUNT}/ 反代`;
          out.error = out.embedDeployError;
          out.embedUrl = "";
          out.publicEmbedUrl = "";
          res.json(out);
          return;
        }
        if (publicPage.wrongService) {
          out.error = "公网嵌入地址仍是 CryptoPulse，不是本仓 news_mornitor";
          res.json(out);
          return;
        }
      }

      out.active = true;
      out.hint = undefined;
      const uiBuild = backendPage.uiBuild || "";
      if (uiBuild) out.uiBuild = uiBuild;
      const withCache = uiBuild
        ? `${browserBase.replace(/\/$/, "")}/?v=${encodeURIComponent(uiBuild)}`
        : browserBase.endsWith("/")
          ? browserBase
          : `${browserBase}/`;
      out.embedUrl = withCache;
      out.publicEmbedUrl = withCache;
      out.feedApiPrefix = NEWS_FEED_MOUNT;
      out.feedHotlistsPath = `${NEWS_FEED_MOUNT}/hotlists`;
      out.feedRoutesVersion = NEWS_FEED_ROUTES_VERSION;
      res.json(out);
    } catch (e) {
      out.latencyMs = Date.now() - t0;
      out.error = String(/** @type {Error} */ (e).message ?? e);
      res.json(out);
    } finally {
      clearTimeout(timer);
    }
  });

  // POST /api/news/restart — 强制重启 news_mornitor 进程
  app.post("/api/news/restart", async (_req, res) => {
    const sup = newsSupervisor;
    if (!sup) { res.json({ ok: false, error: "news-supervisor 未初始化" }); return; }
    try {
      if (typeof sup.ensureOnce === "function") {
        const ok = await sup.ensureOnce();
        res.json({ ok, message: ok ? "news_mornitor 已就绪" : "已触发重启，请稍后刷新" });
      } else {
        res.json({ ok: false, error: "supervisor 不支持 ensureOnce" });
      }
    } catch (e) {
      res.json({ ok: false, error: String(/** @type {Error} */(e).message ?? e) });
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
      botTokenConfigured: Boolean(config.telegramBotToken),
      hint:
        "Discord→TG 走 TELEGRAM_SEND_URL；网关不通时 collect:ui 会回退 TELEGRAM_BOT_TOKEN。8000 被其它服务占用时请改端口或清空 SEND_URL 仅用 Bot。",
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

  app.get("/api/debug/trade-platforms", (_req, res) => {
    const telegramSendChannels = listTelegramSendChannelsWithNames();
    const profiles = readTelegramChannelProfiles();
    res.json({
      ok: true,
      platforms: getTradePlatformToggles(),
      orderSizeUsdt: getTradeOrderSizeUsdt(),
      requiredChannelIds: getAutoTradeChannelIds(),
      telegramSendChannels,
      channelProfilesFile: profiles.file,
      channelProfilesOk: profiles.ok,
      channelProfilesError: profiles.error ?? null,
    });
  });

  app.post("/api/debug/trade-platforms", (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const platforms = setTradePlatformToggles({
      bitget: typeof body.bitget === "boolean" ? body.bitget : undefined,
      weex: typeof body.weex === "boolean" ? body.weex : undefined,
    });
    if (body.orderSizeUsdt != null) {
      setTradeOrderSizeUsdt(body.orderSizeUsdt);
    }
    log.info(
      `[debug] trade platforms bitget=${platforms.bitget} weex=${platforms.weex} orderSizeUsdt=${getTradeOrderSizeUsdt()}`
    );
    res.json({
      ok: true,
      platforms,
      orderSizeUsdt: getTradeOrderSizeUsdt(),
      requiredChannelIds: getAutoTradeChannelIds(),
    });
  });

  /** OI 形态卡片 Telegram 推送开关（代理到 oi_mornitor） */
  async function proxyOiJson(path, opts = {}) {
    const base = config.oiWebBaseUrl;
    const timeoutMs = Number.isFinite(config.oiHealthTimeoutMs) ? config.oiHealthTimeoutMs : 3_000;
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const r = await fetch(`${base}${path}`, {
        ...opts,
        signal: ctrl.signal,
        headers: {
          Accept: "application/json",
          ...(opts.body ? { "Content-Type": "application/json" } : {}),
          ...(opts.headers || {}),
        },
      });
      const text = await r.text();
      let data = null;
      try {
        data = text ? JSON.parse(text) : null;
      } catch {
        data = { ok: false, error: text.slice(0, 200) };
      }
      return { status: r.status, data, online: true };
    } catch (e) {
      return {
        status: 503,
        online: false,
        data: {
          ok: false,
          error: String(/** @type {Error} */ (e).message ?? e),
          hint: "oi_mornitor 未启动；collect:ui 会自动守护，或手动 pnpm run oi:start",
          oiBase: base,
        },
      };
    } finally {
      clearTimeout(timer);
    }
  }

  app.get("/api/debug/oi-telegram-push", async (_req, res) => {
    const { status, data, online } = await proxyOiJson("/api/telegram-push-toggles");
    res.status(online ? status : 200).json({
      ...(data && typeof data === "object" ? data : {}),
      oiOnline: online,
      oiBase: config.oiWebBaseUrl,
    });
  });

  app.post("/api/debug/oi-telegram-push", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { status, data, online } = await proxyOiJson("/api/telegram-push-toggles", {
      method: "POST",
      body: JSON.stringify(body),
    });
    if (online && data?.ok !== false) {
      const t = data?.toggles ?? body;
      log.info(
        `[debug] oi telegram push candle=${t?.candle} structure=${t?.structure} main=${t?.main}`
      );
    }
    res.status(online ? status : 200).json({
      ...(data && typeof data === "object" ? data : {}),
      oiOnline: online,
      oiBase: config.oiWebBaseUrl,
    });
  });

  app.post("/api/debug/oi-telegram-push-test", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const { status, data, online } = await proxyOiJson("/api/telegram-push-test", {
      method: "POST",
      body: JSON.stringify(body),
    });
    res.status(online ? status : 200).json({
      ...(data && typeof data === "object" ? data : {}),
      oiOnline: online,
      oiBase: config.oiWebBaseUrl,
    });
  });

  app.get("/api/debug/simulate-signal", (_req, res) => {
    const telegramSendChannels = listTelegramSendChannelsWithNames();
    const profiles = readTelegramChannelProfiles();
    res.json({
      ok: true,
      telegramSendChannels,
      channelProfilesFile: profiles.file,
      channelProfilesOk: profiles.ok,
      channelProfilesError: profiles.error ?? null,
      tradePlatforms: getTradePlatformToggles(),
      orderSizeUsdt: getTradeOrderSizeUsdt(),
      bitget: getBitgetTradeStatus(),
      weex: getWeexTradeStatus(),
      exampleSignal: `币種：ETH/USDT
方向：🚀📈
📌进场点：2570—2530
✔️获利目标：2625—2690—2790
❌止损位置：2490`,
      hints: [
        "白名单来源：telegram/channel_profiles.json 的 send 数组（下方群名）",
        "listen.py 监听到上述群的结构化信号 → 建卡 + 推 TELEGRAM_PUSH_CHAT_ID + 按勾选平台开单",
        "Bitget / WEEX 勾选与单笔保证金会同步到服务端（localStorage 备份）",
        "Telegram 开单：20x · 市价 · 必须挂止损（缺省 5%）；止盈缺省 5/8/12%（分批 30/30/40）；无有效止损不会下单",
        "TP1 后止损移至开仓价，TP2 后移至 TP1；清算/回溯与 exitPlan 一致",
        "BTC / ETH 主流币不自动开单；无数字入场且无法补默认 TP/SL 时跳过下单",
        "下方可粘贴 Telegram 信号正文做本地模拟（Enter 提交，Shift+Enter 换行）",
      ],
    });
  });

  app.post("/api/debug/simulate-signal", async (req, res) => {
    const content = String(req.body?.content ?? "").trim();
    if (!content) {
      res.status(400).json({ ok: false, error: "content_required" });
      return;
    }
    const sendList = listTelegramSendChannelsWithNames();
    if (!sendList.length) {
      res.status(400).json({ ok: false, error: "send_list_empty", hint: "channel_profiles.json send 为空" });
      return;
    }
    const reqChannelId = String(req.body?.channelId ?? "").trim();
    const picked = sendList.find((c) => c.id === reqChannelId && isCdpSendChannel(c.id)) ?? sendList[0];
    const channelId = picked.id;
    const channelName = picked.name;

    const parsedLite = parseTelegramTradeTextLite(content);
    if (!parsedLite) {
      res.status(400).json({
        ok: false,
        error: "parse_failed",
        hint: "需含币种、方向及进场/止盈/止损等结构化字段",
      });
      return;
    }

    const bodyPlatforms =
      req.body?.tradePlatforms && typeof req.body.tradePlatforms === "object" ? req.body.tradePlatforms : null;
    if (bodyPlatforms) {
      setTradePlatformToggles({
        bitget: bodyPlatforms.bitget !== false,
        weex: bodyPlatforms.weex !== false,
      });
    }
    if (req.body?.orderSizeUsdt != null) {
      setTradeOrderSizeUsdt(req.body.orderSizeUsdt);
    }

    const exitPlan = buildDefaultTelegramExitPlan();
    /** @type {Record<string, unknown>} */
    const parsedJson = {
      parser: "telegram",
      signalPhase: "full",
      orderMode: "market",
      symbol: parsedLite.symbol,
      direction: parsedLite.direction,
      entry: parsedLite.entry,
      takeProfits: parsedLite.takeProfits,
      stopLoss: parsedLite.stopLoss,
      exitPlan,
      defaultTpsl: !parsedLite.takeProfits.length || !parsedLite.stopLoss,
    };

    try {
      const card = await cardArchive.archiveCard({
        channelId,
        channelName,
        guildId: "telegram",
        sourceType: "telegram",
        sourceRef: `tg:debug:${Date.now()}`,
        rawContent: content,
        symbol: parsedLite.symbol,
        direction: parsedLite.direction,
        entry: parsedLite.entry,
        targets: parsedLite.takeProfits,
        stopLoss: parsedLite.stopLoss,
        parsedJson,
        note: "Debug 模拟 · 来源:telegram",
        signalAt: new Date().toISOString(),
        tradePlatforms: bodyPlatforms
          ? { bitget: bodyPlatforms.bitget !== false, weex: bodyPlatforms.weex !== false }
          : getTradePlatformToggles(),
      });
      const cardId = card?.id;
      log.info(
        `[debug-tg-simulate] channel=${channelId} symbol=${parsedLite.symbol} card=#${cardId ?? "-"}`
      );
      res.json({
        ok: true,
        channelId,
        channelName,
        content,
        card,
        parsed: parsedJson,
        bitget: getBitgetTradeStatus(),
        weex: getWeexTradeStatus(),
        tradePlatforms: getTradePlatformToggles(),
        orderSizeUsdt: getTradeOrderSizeUsdt(),
        telegramSendChannels: sendList,
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

  app.get("/api/show/discord-groups", (_req, res) => {
    const { channelIds, namesByChannelId } = config.discordGroups;
    res.json({
      ok: true,
      filterEnabled: channelIds.length > 0,
      channelIds,
      namesByChannelId,
      groupsFile: config.discordGroupsFile?.filePath ?? null,
    });
  });

  app.get("/api/discord/cdp-active", (_req, res) => {
    res.json({ ok: true, ...discordIngest.getCdpPage() });
  });

  app.get("/api/discord/cdp-status", (_req, res) => {
    res.json({ ok: true, ...cdpStatusSnapshot() });
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
      let channels = rows.map((row) => ({
        channelId: row.channel_id,
        guildId: row.guild_id,
        name: row.name,
        type: row.channel_type,
        lastMessagePreview: row.last_message_preview,
        lastMessageAtMs: row.last_message_at_ms,
        updatedAt: row.updated_at,
      }));
      channels = applyDiscordGroupsChannelList(channels, guildId, config.discordGroups);
      res.json({ ok: true, guildId, channels });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  /** @param {Record<string, unknown>[]} rows */
  function discordMessageRowsForClient(rows) {
    return rows.map((row) => {
      const enriched = discordIngest.enrichForApi(row);
      enriched.rawJson = undefined;
      return enriched;
    });
  }

  /**
   * 按 channel 查库；带 guildId 无结果时去掉 guild 条件再查（历史行可能 guild_id 为空或与 Show 默认服不一致）。
   * @param {number} limit
   * @param {Record<string, unknown>} filters
   * @param {{ includeRaw?: boolean }} [options]
   */
  async function listRecentMessagesRelaxed(limit, filters, options) {
    let rows = await store.listRecentMessages(limit, filters, options);
    const ch = String(filters.channelId ?? "").trim();
    const gid = String(filters.guildId ?? "").trim();
    if (rows.length > 0 || !ch || !gid) return rows;
    return store.listRecentMessages(limit, { ...filters, guildId: "" }, options);
  }

  /** @param {import("express").Request} req */
  function parseMessageDaysFromMs(req) {
    const daysRaw = Number(req.query.days);
    if (Number.isFinite(daysRaw) && daysRaw > 0) {
      return Date.now() - Math.min(14, daysRaw) * 86400000;
    }
    const fromRaw = String(req.query.from_ms ?? req.query.fromMs ?? "").trim();
    if (fromRaw) {
      const n = Number(fromRaw);
      if (Number.isFinite(n) && n > 0) return n;
    }
    return undefined;
  }

  /**
   * @param {string} channelId
   * @param {string} [beforeMessageId]
   */
  async function showHistoryCachePayload(channelId, beforeMessageId = "") {
    const cid = String(channelId ?? "").trim();
    if (!cid || typeof store.getDiscordChannelShowHistoryCache !== "function") return null;
    const cache = await store.getDiscordChannelShowHistoryCache(cid);
    const ttlMs = config.discordShowHistoryWarmTtlMs;
    const before = String(beforeMessageId ?? "").trim();
    const fresh = isChannelShowHistoryFresh(cache, { ttlMs, beforeMessageId: before });
    return {
      warmedAtMs: cache.warmedAtMs > 0 ? cache.warmedAtMs : null,
      oldestMessageId: cache.oldestMessageId || null,
      fresh,
      ttlMs,
    };
  }

  /**
   * @param {string} guildId
   * @param {string} channelId
   * @param {number} maxPages
   */
  async function runDiscordShowHistoryWarm(guildId, channelId, maxPages) {
    if (typeof scrollDiscordHistoryImpl !== "function") {
      return { ok: false, error: "CDP 尚未就绪", pagesDone: 0 };
    }
    const fromMs = Date.now() - config.discordShowSnapshotDays * 86400000;
    let pagesDone = 0;
    for (let i = 0; i < maxPages; i += 1) {
      const cache = await store.getDiscordChannelShowHistoryCache(channelId);
      const oldest = await store.getOldestDiscordMessageIdForChannel(channelId, { fromMs });
      if (
        isChannelShowHistoryFresh(cache, {
          ttlMs: config.discordShowHistoryWarmTtlMs,
          beforeMessageId: oldest,
        })
      ) {
        break;
      }
      const out = /** @type {{ ok?: boolean, error?: string }} */ (
        await scrollDiscordHistoryImpl(guildId, channelId, {
          beforeMessageId: oldest || undefined,
        })
      );
      if (!out?.ok) {
        return { ok: false, error: out?.error ?? "CDP 上滚失败", pagesDone };
      }
      pagesDone += 1;
      await sleepMs(650);
    }
    return { ok: true, pagesDone };
  }

  app.get("/api/discord/messages/:messageId/attachments", async (req, res) => {
    try {
      const messageId = String(req.params.messageId ?? "").trim();
      if (!messageId) {
        res.status(400).json({ ok: false, error: "messageId required" });
        return;
      }
      if (typeof store.getDiscordMessageRawJson !== "function") {
        res.status(503).json({ ok: false, error: "store unavailable" });
        return;
      }
      const rawJson = await store.getDiscordMessageRawJson(messageId);
      if (!rawJson) {
        res.status(404).json({ ok: false, error: "message not found" });
        return;
      }
      res.json({
        ok: true,
        messageId,
        attachments: extractAttachmentsForClient(rawJson),
      });
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
      const beforeMessageId = String(req.query.before ?? req.query.before_message_id ?? "").trim();
      const fromMs = beforeMessageId ? undefined : parseMessageDaysFromMs(req);
      let rows = await listRecentMessagesRelaxed(
        limit,
        {
          channelId,
          guildId,
          order: "desc",
          fromMs,
          beforeMessageId: beforeMessageId || undefined,
        },
        { includeRaw: true }
      );
      let fallbackOlder = false;
      if (channelId && !beforeMessageId && fromMs != null && rows.length === 0) {
        rows = await listRecentMessagesRelaxed(
          limit,
          { channelId, guildId, order: "desc" },
          { includeRaw: true }
        );
        fallbackOlder = rows.length > 0;
      }
      let clientRows = discordMessageRowsForClient(rows);
      if (wantChronological) clientRows = clientRows.reverse();
      const showHistory = channelId
        ? await showHistoryCachePayload(channelId, beforeMessageId)
        : null;
      res.json({
        ok: true,
        debugMode: isDebugMode(),
        rows: clientRows,
        fromMs: fallbackOlder ? null : fromMs ?? null,
        fallbackOlder,
        showHistory,
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.get("/api/discord/guilds/:guildId/messages-snapshot", async (req, res) => {
    try {
      const guildId = String(req.params.guildId ?? "").trim();
      if (!guildId) {
        res.status(400).json({ ok: false, error: "guildId required" });
        return;
      }
      const days = Math.min(
        14,
        Math.max(1, Number(req.query.days) || config.discordShowSnapshotDays || 7)
      );
      const perChannel = Math.min(
        300,
        Math.max(20, Number(req.query.per_channel) || config.discordShowSnapshotPerChannel || 120)
      );
      const fromMs = Date.now() - days * 86400000;
      const channels = await store.listDiscordChannelsByGuild(guildId);
      let channelIds = channels
        .map((c) => String(c.channel_id ?? c.channelId ?? "").trim())
        .filter(Boolean);
      if (config.discordGroups.channelIds.length) {
        channelIds = config.discordGroups.channelIds;
      }
      /** @type {Record<string, Record<string, unknown>[]>} */
      const byChannel = {};
      const concurrency = 6;
      for (let i = 0; i < channelIds.length; i += concurrency) {
        const batch = channelIds.slice(i, i + concurrency);
        await Promise.all(
          batch.map(async (channelId) => {
            let rows = await listRecentMessagesRelaxed(
              perChannel,
              { channelId, guildId, order: "desc", fromMs },
              { includeRaw: true }
            );
            if (!rows.length) {
              rows = await listRecentMessagesRelaxed(
                perChannel,
                { channelId, guildId, order: "desc" },
                { includeRaw: true }
              );
            }
            byChannel[channelId] = discordMessageRowsForClient(rows).reverse();
          })
        );
      }
      res.json({
        ok: true,
        guildId,
        fromMs,
        days,
        perChannel,
        channelCount: channelIds.length,
        byChannel,
      });
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

  /**
   * Show 切频道：服务端按库内缓存决定是否 CDP 上滚（多前端共享，已刷新则只读 MySQL）。
   */
  app.post("/api/discord/channels/show-history-warm", async (req, res) => {
    const guildId = String(req.body?.guildId ?? "").trim();
    const channelId = String(req.body?.channelId ?? "").trim();
    const maxPages = Math.min(
      8,
      Math.max(1, Number(req.body?.maxPages) || config.discordShowHistoryWarmPages)
    );
    if (!guildId || !channelId) {
      res.status(400).json({ ok: false, error: "缺少 guildId 或 channelId" });
      return;
    }
    try {
      const fromMs = Date.now() - config.discordShowSnapshotDays * 86400000;
      const oldest = await store.getOldestDiscordMessageIdForChannel(channelId, { fromMs });
      const showHistory = await showHistoryCachePayload(channelId, oldest);
      if (showHistory?.fresh) {
        res.json({
          ok: true,
          skipped: true,
          reason: "cache_fresh",
          pagesDone: 0,
          showHistory,
        });
        return;
      }

      let inflight = showHistoryWarmInflight.get(channelId);
      if (!inflight) {
        inflight = runDiscordShowHistoryWarm(guildId, channelId, maxPages).finally(() => {
          showHistoryWarmInflight.delete(channelId);
        });
        showHistoryWarmInflight.set(channelId, inflight);
      }
      const result = await inflight;
      const showHistoryAfter = await showHistoryCachePayload(channelId, oldest);
      if (result.ok) {
        res.json({
          ok: true,
          skipped: result.pagesDone === 0 && showHistoryAfter?.fresh,
          reason: result.pagesDone === 0 ? "cache_fresh" : "warmed",
          pagesDone: result.pagesDone,
          showHistory: showHistoryAfter,
        });
      } else {
        res.status(500).json({
          ok: false,
          error: result.error ?? "预热失败",
          pagesDone: result.pagesDone ?? 0,
          showHistory: showHistoryAfter,
        });
      }
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  /** Show 向上翻页：驱动 CDP 内 Discord 消息列表上滚，触发 /messages?before= 采集 */
  app.post("/api/cdp/discord-channel-scroll-up", async (req, res) => {
    const guildId = String(req.body?.guildId ?? req.query?.guild_id ?? "").trim();
    const channelId = String(req.body?.channelId ?? req.query?.channel_id ?? "").trim();
    const beforeMessageId = String(req.body?.beforeMessageId ?? req.body?.before ?? "").trim() || undefined;
    const clientTraceId = String(req.body?.clientTraceId ?? "").trim() || undefined;
    const tracePayload = clientTraceId ? { clientTraceId } : {};

    if (!guildId || !channelId) {
      res.status(400).json({ ok: false, error: "缺少 guildId 或 channelId" });
      return;
    }
    if (typeof store.getDiscordChannelShowHistoryCache === "function" && beforeMessageId) {
      const cache = await store.getDiscordChannelShowHistoryCache(channelId);
      if (
        isChannelShowHistoryFresh(cache, {
          ttlMs: config.discordShowHistoryWarmTtlMs,
          beforeMessageId,
        })
      ) {
        res.json({
          ok: true,
          skipped: true,
          reason: "cache_fresh",
          cdpSkipped: true,
          ...tracePayload,
        });
        return;
      }
    }
    if (typeof scrollDiscordHistoryImpl !== "function") {
      res.status(503).json({ ok: false, error: "CDP 尚未就绪" });
      return;
    }

    log.info(
      `[discord-scroll-up] POST guild=${guildId} channel=${channelId}${beforeMessageId ? ` before=${beforeMessageId}` : ""}`
    );
    try {
      const out = /** @type {{ ok?: boolean, error?: string }} */ (
        await scrollDiscordHistoryImpl(guildId, channelId, {
          beforeMessageId,
          clientTraceId,
        })
      );
      if (out?.ok) {
        res.json({ ok: true, ...out, ...tracePayload });
      } else {
        res.status(500).json({ ok: false, error: out?.error ?? "CDP 上滚失败", ...tracePayload });
      }
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e), ...tracePayload });
    }
  });

  /** @type {{ stop: () => void } | null} */
  let channelRotate = null;

  const avatarsDir = path.join(__dirname, "..", "public", "community-avatars");
  app.use("/community-avatars", express.static(avatarsDir, { fallthrough: false, index: false }));

  // Telegram 频道头像：仓库 telegram/avatar/{chatId}.png → GET /telegram-avatars/...
  const telegramAvatarsDir = path.join(__dirname, "..", "..", "telegram", "avatar");
  app.use("/telegram-avatars", express.static(telegramAvatarsDir, { fallthrough: false, index: false }));

  // Telegram 消息图片：telegram/media/{chatId}_{msgId}.jpg → GET /telegram-media/...
  const telegramMediaDir = path.join(__dirname, "..", "..", "telegram", "media");
  fs.mkdirSync(telegramMediaDir, { recursive: true });
  app.use("/telegram-media", express.static(telegramMediaDir, { fallthrough: false, index: false }));

  app.use(express.static(publicDir));

  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    if (req.path.startsWith("/api")) return next();
    if (req.path.startsWith("/community-avatars")) return next();
    if (req.path.startsWith("/telegram-avatars")) return next();
    if (req.path.startsWith("/telegram-media")) return next();
    if (req.path.startsWith(NEWS_EMBED_MOUNT)) return next();
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
    log.warn(
      "MySQL 离线 — 信号卡不入库、卡片页/评估不可用；识别成功的 Discord 信号仍会尝试推 TELEGRAM_PUSH_CHAT_ID（无 cardId）。请修复 MYSQL_* 后重启 collect:ui"
    );
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
    restartWithUi: config.oiRestartWithUi,
  });
  const newsSupervisor = startNewsSupervisor({
    log: createLogger("news-supervisor"),
    baseUrl: config.newsWebBaseUrl,
    enabled: config.newsAutoStart,
    checkIntervalMs: config.newsSupervisorIntervalMs,
  });
  const contentSupervisor = startContentSupervisor({
    log: createLogger("content-supervisor"),
    baseUrl: config.contentBoardBaseUrl,
    enabled: config.contentBoardAutoStart,
    checkIntervalMs: config.contentBoardSupervisorIntervalMs,
  });
  const telegramSupervisor = startTelegramSupervisor({
    log: createLogger("telegram-supervisor"),
    enabled: config.telegramListenAutoStart,
    checkIntervalMs: config.telegramSupervisorIntervalMs,
  });
  getTelegramListenStatus = () => telegramSupervisor.getStatus();
  process.once("SIGINT", () => {
    oiSupervisor.stop();
    newsSupervisor.stop();
    contentSupervisor.stop();
    telegramSupervisor.stop();
  });
  process.once("SIGTERM", () => {
    oiSupervisor.stop();
    newsSupervisor.stop();
    contentSupervisor.stop();
    telegramSupervisor.stop();
  });

  log.info(
    `[api] /api/cards /api/v1/cards /api/discord/signal-cards（debugMode=${isDebugMode()}）`
  );
  log.info(`信号卡片监听 ${getSignalChannelIds().size} 个 Discord 频道（DISCORD_SIGNAL_CHANNEL_IDS 非空则覆盖内置列表）`);
  const cdpMonitorOpts = {
    startUrl: config.startUrl,
    cdpDiscordUrl: config.cdpDiscordUrl,
    cdpConnectUrl: config.cdpConnectUrl,
    pageReloadIntervalMs: config.pageReloadIntervalMs,
    cdpAutoGoto: config.cdpAutoGoto,
    cdpVisibilityKeepalive: config.cdpVisibilityKeepalive,
    cdpSilentNavigation: config.cdpSilentNavigation,
    cdpMaxBrowserTabs: config.cdpMaxBrowserTabs,
    networkTrace: config.collectNetworkTrace,
    wsFrameTrace: config.collectWsFrameTrace,
    diagnosticSink,
    onConnectionLost: (info) => systemTelegram.notifyCdpDisconnected(info),
    onConnected: (info) => systemTelegram.notifyCdpConnected(info),
    onReconnected: (info) => systemTelegram.notifyCdpReconnected(info),
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
        if (config.framePersist) {
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
      }
    },
  };

  async function bootCdpMonitor() {
    if (!config.cdpConnectUrl) {
      cdpBoot = { state: "disabled", attempt: 0 };
      log.warn("未配置 CDP_CONNECT_URL — Discord Gateway 采集未启动（仅 REST/历史消息可用）");
      return;
    }
    log.info(
      `CDP 附加: ${config.cdpConnectUrl} — 保活/断页恢复频道 ${config.cdpDiscordUrl}${config.startUrl !== config.cdpDiscordUrl ? `（START_URL=${config.startUrl}）` : ""}`
    );
    const cdpLog = createLogger("cdp");
    for (;;) {
      cdpBoot = { state: "pending", attempt: cdpBoot.attempt + 1 };
      try {
        if (session) {
          await session.close().catch(() => {});
          session = null;
        }
        navigateDiscordImpl = null;
        scrollDiscordHistoryImpl = null;
        session = await startCdpWebSocketMonitor(cdpMonitorOpts, cdpLog);
        navigateDiscordImpl = (g, c, t) => session.navigateDiscordChannel(g, c, t);
        scrollDiscordHistoryImpl = (g, c, t) => session.scrollDiscordChannelHistory(g, c, t);
        webhookForward.setBrowserPost((url, payload) => session.postWebhookViaBrowser(url, payload));
        channelRotate?.stop();
        channelRotate = startCdpChannelRotate({
          enabled: config.cdpChannelRotate,
          intervalMs: config.cdpChannelRotateIntervalMs,
          dwellMs: config.cdpChannelRotateDwellMs,
          startUrl: config.cdpDiscordUrl,
          navigate: (g, c) => session.navigateDiscordChannel(g, c),
          log: createLogger("channel-rotate"),
        });
        cdpBoot = { state: "ready", attempt: cdpBoot.attempt };
        log.info(`CDP 就绪（#${cdpBoot.attempt}），已挂载 ${session.mounted} 个标签页`);
        return;
      } catch (e) {
        const msg = String(/** @type {Error} */ (e).message ?? e);
        cdpBoot = { state: "error", attempt: cdpBoot.attempt, error: msg };
        const delay = Math.min(30_000, 1500 * 2 ** Math.min(cdpBoot.attempt - 1, 4));
        log.error(`CDP 启动失败 #${cdpBoot.attempt}: ${msg} — ${Math.round(delay / 1000)}s 后重试`);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
  }

  void bootCdpMonitor();
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
