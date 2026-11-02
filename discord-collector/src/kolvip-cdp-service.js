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

  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  let running = false;
  /** @type {Record<string, unknown> | null} */
  let lastRun = null;
  /** @type {string[]} */
  const logs = [];

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
      const seen = await loadKolvipSeen(fs, SEEN_PATH);
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
      ...probeResult,
    };
  }

  async function start() {
    if (!config.kolvipSignalEnabled) {
      pushLog("巨鲸信号源未启用（KOLVIP_ENABLED / KOLVIP_API_ENABLED / KOLVIP_CDP_ENABLED=0）");
      return;
    }
    schedule();
    pushLog(
      `巨鲸已启动 mode=${config.kolvipFetchMode} interval=${Math.round(config.kolvipPollIntervalMs / 1000)}s 精选=${getKolvipChannelMappings().length}`
    );
    void runOnce().catch((e) => pushLog(`首次抓取: ${/** @type {Error} */ (e).message}`));
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return { start, stop, runOnce, probe, status };
}
