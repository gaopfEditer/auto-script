/**
 * 巨鲸 kolvip 信号轮询：优先 HTTP API，CDP DOM 可关或 auto 兜底。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { fetchKolvipChannelsViaCdp, probeKolvipCdp } from "./kolvip-cdp-fetch.js";
import { fetchKolvipChannelsViaApi } from "./kolvip-api-fetch.js";
import { getKolvipChannelMappings, kolvipWebUrl } from "./kolvip-cdp-config.js";
import { resolveKolvipApiWtoken } from "./kolvip-api-auth.js";
import {
  ingestKolvipMessageBatch,
  loadKolvipSeen,
  saveKolvipSeen,
} from "./kolvip-ingest.js";
import { createKolvipWsService } from "./kolvip-ws-service.js";
import {
  catchupKolvipChannelMessages,
  kolvipBeforeIdFromMessageId,
  resolveKolvipChannelIdForShow,
  listKolvipShowScanCatchupIds,
} from "./kolvip-channel-catchup.js";
import { kolvipScanVirtualChannelId } from "./kolvip-scan-config.js";
import { shouldSkipKolvipShowTailCatchup } from "./kolvip-show-catchup-cache.js";
import { syncKolvipChannelCatalog } from "./kolvip-api-catalog.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEEN_PATH = path.join(__dirname, "..", "data", "kolvip-cdp-seen.json");

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {(channel: string, payload: Record<string, unknown>) => void} [broadcast]
 * @param {{
 *   signalCards?: ReturnType<typeof import("./discord-signal-card-service.js").createDiscordSignalCardService>,
 * }} [deps]
 */
export function createKolvipCdpService(store, log, broadcast, deps = {}) {
  const signalCards = deps.signalCards ?? null;

  /** @type {Record<string, unknown> | null} */
  let seenShared = null;

  /** @type {ReturnType<typeof createKolvipWsService> | null} */
  let wsService = null;
  if (signalCards) {
    wsService = createKolvipWsService({
      store,
      log,
      broadcast,
      signalCards,
      getSeen: async () => {
        if (!seenShared) seenShared = await loadKolvipSeen(fs, SEEN_PATH);
        return seenShared;
      },
      saveSeen: async (seen) => {
        seenShared = seen;
        await saveKolvipSeen(fs, SEEN_PATH, seen);
      },
      onReconnect: () => {
        log.info("巨鲸 WS 重连 — HTTP 补拉精选频道 + Show 榜单频道");
        void runOnce().catch((e) =>
          log.warn(`巨鲸重连补拉: ${/** @type {Error} */ (e).message}`)
        );
      },
    });
  }

  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  let running = false;
  /** @type {Record<string, unknown> | null} */
  let lastRun = null;
  /** @type {string[]} */
  const logs = [];
  let showScanPollCursor = 0;
  let showScanPollRunning = false;

  /** @returns {string[]} */
  function listShowScanKolvipIds() {
    return listKolvipShowScanCatchupIds(config.discordShowSidebar?.channelIds ?? []);
  }

  /**
   * Show 侧栏 kolvip-scan-*（榜单频道）不在精选 8 路 HTTP/WS 全覆盖内，按批 HTTP 补拉。
   * @param {{ batchSize?: number, limit?: number }} [opts]
   */
  async function catchupShowScanChannelsRoundRobin(opts = {}) {
    if (!config.kolvipSignalEnabled || !signalCards) return { ok: false, skipped: "disabled" };
    const kids = listShowScanKolvipIds();
    if (!kids.length) return { ok: true, skipped: "no_show_scan", kids: 0 };
    if (showScanPollRunning) return { ok: false, skipped: "busy" };

    const batchSize = Math.min(kids.length, Math.max(1, Number(opts.batchSize) || 3));
    const limit = Math.min(80, Math.max(10, Number(opts.limit) || 30));
    showScanPollRunning = true;
    /** @type {Array<Record<string, unknown>>} */
    const summaries = [];
    try {
      for (let i = 0; i < batchSize; i += 1) {
        const idx = (showScanPollCursor + i) % kids.length;
        const kid = kids[idx];
        const showChannelId = kolvipScanVirtualChannelId(kid);
        try {
          const out = await catchupShowChannel(showChannelId, { limit });
          summaries.push({
            kolvipChannelId: kid,
            ...out,
          });
        } catch (e) {
          summaries.push({
            kolvipChannelId: kid,
            ok: false,
            error: /** @type {Error} */ (e).message,
          });
        }
      }
      showScanPollCursor = (showScanPollCursor + batchSize) % kids.length;
      return { ok: true, batchSize, kidsTotal: kids.length, channels: summaries };
    } finally {
      showScanPollRunning = false;
    }
  }

  function pushLog(msg) {
    const line = `${new Date().toISOString()} ${msg}`;
    logs.unshift(line);
    if (logs.length > 80) logs.length = 80;
    log.info(msg);
  }

  function connectUrl() {
    return (config.kolvipCdpConnectUrl || config.cdpConnectUrl || "").trim();
  }

  function shouldUseApi() {
    const mode = config.kolvipFetchMode;
    if (mode === "api") return true;
    if (mode === "cdp") return false;
    return config.kolvipApiEnabled || config.kolvipFetchMode === "auto";
  }

  async function probe() {
    const token = await resolveKolvipApiWtoken(log);
    return {
      api: { configured: Boolean(token.wtoken), source: token.source },
      cdp: await probeKolvipCdp(connectUrl()),
    };
  }

  async function runOnce() {
    if (running) return { ok: false, skipped: "busy", lastRun };
    if (!config.kolvipSignalEnabled) {
      return { ok: false, skipped: "disabled" };
    }
    if (!signalCards) {
      return { ok: false, error: "signalCards 未注入" };
    }

    const channels = getKolvipChannelMappings();
    if (!channels.length) {
      const msg = "未配置巨鲸精选频道（KOLVIP_CHANNEL_IDS 或默认表）";
      lastRun = { at: new Date().toISOString(), ok: false, error: msg };
      return { ok: false, error: msg };
    }

    running = true;
    const started = Date.now();
    /** @type {Array<Record<string, unknown>>} */
    const summaries = [];
    let cardRowsProcessed = 0;
    let fetchMode = "api";

    try {
      const seen = seenShared ?? (await loadKolvipSeen(fs, SEEN_PATH));
      seenShared = seen;
      /** @type {Array<{ channel: typeof channels[number], messages: import('./kolvip-cdp-message.js').KolvipDomMessage[], error?: string }>} */
      let batches = [];

      if (shouldUseApi()) {
        fetchMode = "api";
        try {
          const apiResult = await fetchKolvipChannelsViaApi({
            channels,
            maxPerChannel: config.kolvipApiMaxPerChannel,
            log,
          });
          batches = apiResult.results;
        } catch (e) {
          if (config.kolvipFetchMode === "api" || !config.kolvipCdpEnabled) {
            throw e;
          }
          fetchMode = "cdp-fallback";
        }
      }

      if (!batches.length && (config.kolvipFetchMode === "cdp" || fetchMode === "cdp-fallback")) {
        fetchMode = "cdp";
        const url = connectUrl();
        if (!url) {
          throw new Error("CDP 未配置且 API 不可用");
        }
        pushLog(`巨鲸 CDP 兜底抓取 ${channels.length} 频道`);
        batches = await fetchKolvipChannelsViaCdp({
          connectUrl: url,
          channels,
          maxPerChannel: config.kolvipCdpMaxPerChannel,
          webUrl: kolvipWebUrl(),
          log,
        });
      }

      for (const batch of batches) {
        const chId = batch.channel.kolvipChannelId;
        if (batch.error) {
          summaries.push({
            kolvipChannelId: chId,
            logicName: batch.channel.logicName,
            error: batch.error,
            fetched: 0,
            cardsQueued: 0,
          });
          continue;
        }
        const result = await ingestKolvipMessageBatch({
          kolvipChannelId: chId,
          channelName: batch.channel.logicName,
          messages: batch.messages ?? [],
          mode: "live",
          curated: true,
          seen,
          signalCards,
          store,
          log,
          broadcast,
        });
        if (result.seeded) {
          pushLog(
            `巨鲸 ${batch.channel.logicName} 首次记档 ${result.fetched} 条（不推历史，与 Twitter CDP 一致）`
          );
        }
        cardRowsProcessed += result.cardsCreated;
        summaries.push({
          kolvipChannelId: chId,
          logicName: batch.channel.logicName,
          fetched: result.fetched,
          newCount: result.cardsCreated,
          cardsQueued: result.rowsQueued,
          cardsCreated: result.cardsCreated,
          seeded: result.seeded,
        });
      }

      await saveKolvipSeen(fs, SEEN_PATH, seen);
      seenShared = seen;

      lastRun = {
        at: new Date().toISOString(),
        ok: true,
        ms: Date.now() - started,
        fetchMode,
        channels: summaries,
        cardsQueued: cardRowsProcessed,
        cardsCreated: summaries.reduce((n, s) => n + (Number(s.cardsCreated) || 0), 0),
        bypassDiscordSignals: config.kolvipBypassDiscordSignals,
      };
      void catchupShowScanChannelsRoundRobin().catch((e) =>
        log.warn(`巨鲸榜单批补: ${/** @type {Error} */ (e).message}`)
      );
      broadcast?.("meta", { kind: "kolvip_run", ...lastRun });
      return { ok: true, ...lastRun };
    } catch (e) {
      const error = /** @type {Error} */ (e).message;
      lastRun = { at: new Date().toISOString(), ok: false, error, fetchMode };
      pushLog(`巨鲸抓取失败: ${error}`);
      return { ok: false, error, lastRun };
    } finally {
      running = false;
    }
  }

  function schedule() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
    if (!config.kolvipSignalEnabled) return;
    timer = setInterval(() => {
      void catchupShowScanChannelsRoundRobin().catch((e) =>
        log.warn(`巨鲸榜单 tick: ${/** @type {Error} */ (e).message}`)
      );
      if (
        config.kolvipWsEnabled &&
        config.kolvipPollDeferWhenWs &&
        wsService?.isConnected()
      ) {
        const lastAt = lastRun?.at ? Date.parse(String(lastRun.at)) : 0;
        if (Number.isFinite(lastAt) && Date.now() - lastAt < config.kolvipPollFallbackMs) {
          return;
        }
      }
      void runOnce().catch((e) => log.warn(`Kolvip tick: ${/** @type {Error} */ (e).message}`));
    }, config.kolvipPollIntervalMs);
  }

  async function status() {
    const probeResult = await probe();
    return {
      ok: true,
      enabled: config.kolvipSignalEnabled,
      fetchMode: config.kolvipFetchMode,
      apiEnabled: config.kolvipApiEnabled,
      cdpEnabled: config.kolvipCdpEnabled,
      bypassDiscordSignals: config.kolvipBypassDiscordSignals,
      running,
      lastRun,
      logs: logs.slice(0, 30),
      connectUrl: connectUrl() || null,
      webUrl: kolvipWebUrl(),
      apiBaseUrl: config.kolvipApiBaseUrl,
      channels: getKolvipChannelMappings(),
      ws: wsService?.status?.() ?? { enabled: config.kolvipWsEnabled, connected: false },
      pollDeferWhenWs: config.kolvipPollDeferWhenWs,
      pollFallbackMs: config.kolvipPollFallbackMs,
      ...probeResult,
    };
  }

  async function start() {
    if (!config.kolvipSignalEnabled) {
      pushLog("巨鲸信号源未启用（KOLVIP_ENABLED / KOLVIP_API_ENABLED / KOLVIP_CDP_ENABLED=0）");
      return;
    }
    schedule();
    if (config.kolvipWsEnabled) wsService?.start();
    pushLog(
      `巨鲸已启动 mode=${config.kolvipFetchMode} ws=${config.kolvipWsEnabled ? "on" : "off"} poll=${Math.round(config.kolvipPollIntervalMs / 1000)}s 精选=${getKolvipChannelMappings().length}`
    );
    void runOnce().catch((e) => pushLog(`首次抓取: ${/** @type {Error} */ (e).message}`));
    void catchupShowScanChannelsRoundRobin({ batchSize: 5, limit: 40 }).catch((e) =>
      pushLog(`首次榜单补拉: ${/** @type {Error} */ (e).message}`)
    );
    void syncKolvipChannelCatalog(log, store).catch((e) =>
      pushLog(`频道目录/头像: ${/** @type {Error} */ (e).message}`)
    );
  }

  function stop() {
    wsService?.stop();
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  /**
   * @param {string} showChannelId Discord / kolvip-scan 虚拟 id
   * @param {{ beforeId?: number, limit?: number, beforeMessageId?: string }} [opts]
   */
  async function catchupShowChannel(showChannelId, opts = {}) {
    if (!signalCards) return { ok: false, error: "signalCards 未注入" };
    const showId = String(showChannelId ?? "").trim();
    const kid =
      resolveKolvipChannelIdForShow(showId) ||
      String(opts.kolvipChannelId ?? "").trim();
    if (!kid) return { ok: false, error: "非 kolvip Show 频道" };
    let beforeId = Math.max(0, Number(opts.beforeId) || 0);
    if (!beforeId && opts.beforeMessageId) {
      beforeId = kolvipBeforeIdFromMessageId(String(opts.beforeMessageId), kid);
    }
    const forceCatchup = ["1", "true", "yes", "on"].includes(String(opts.force ?? "").toLowerCase());
    if (
      await shouldSkipKolvipShowTailCatchup(store, showId, {
        beforeId,
        beforeMessageId: opts.beforeMessageId,
        force: forceCatchup,
      })
    ) {
      const cache =
        typeof store.getDiscordChannelShowHistoryCache === "function"
          ? await store.getDiscordChannelShowHistoryCache(showId)
          : null;
      return {
        ok: true,
        skipped: true,
        reason: "cache_fresh",
        kolvipChannelId: kid,
        discordChannelId: showId,
        cache,
      };
    }
    const seen = seenShared ?? (await loadKolvipSeen(fs, SEEN_PATH));
    const out = await catchupKolvipChannelMessages({
      kolvipChannelId: kid,
      store,
      signalCards,
      log,
      broadcast,
      limit: opts.limit,
      beforeId,
      seen,
    });
    seenShared = seen;
    return out;
  }

  return { start, stop, runOnce, probe, status, catchupShowChannel };
}
