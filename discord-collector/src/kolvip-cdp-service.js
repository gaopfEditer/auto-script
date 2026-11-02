/**
 * 巨鲸 kolvip **临时** CDP 轮询 → 现有 signal card ingest（Telegram 推送逻辑不变）。
 * 关闭 KOLVIP_CDP_ENABLED 即可切回纯 Discord 出卡；不修改 Discord Gateway/CDP 代码路径。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { runSignalCardPipelineForRows } from "./discord-signal-pipeline.js";
import { fetchKolvipChannelsViaCdp, probeKolvipCdp } from "./kolvip-cdp-fetch.js";
import { kolvipMessageToDiscordRow } from "./kolvip-cdp-message.js";
import { getKolvipChannelMappings, kolvipWebUrl } from "./kolvip-cdp-config.js";

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

  /** @param {string} msg */
  function pushLog(msg) {
    const line = `${new Date().toISOString()} ${msg}`;
    logs.unshift(line);
    if (logs.length > 80) logs.length = 80;
    log.info(msg);
  }

  function connectUrl() {
    return (config.kolvipCdpConnectUrl || config.cdpConnectUrl || "").trim();
  }

  async function loadSeen() {
    try {
      const raw = await fs.readFile(SEEN_PATH, "utf8");
      const j = JSON.parse(raw);
      return j && typeof j === "object" ? j : {};
    } catch {
      return {};
    }
  }

  /** @param {Record<string, unknown>} data */
  async function saveSeen(data) {
    await fs.mkdir(path.dirname(SEEN_PATH), { recursive: true });
    await fs.writeFile(SEEN_PATH, JSON.stringify(data), "utf8");
  }

  /**
   * @param {string} kolvipChannelId
   * @param {string[]} dataIds
   */
  async function filterNewDataIds(kolvipChannelId, dataIds) {
    const all = await loadSeen();
    const bucket =
      all[kolvipChannelId] && typeof all[kolvipChannelId] === "object"
        ? /** @type {{ ids: string[] }} */ (all[kolvipChannelId])
        : { ids: [] };
    const set = new Set(Array.isArray(bucket.ids) ? bucket.ids.map(String) : []);
    return dataIds.filter((id) => id && !set.has(id));
  }

  /**
   * @param {string} kolvipChannelId
   */
  async function channelHasSeenHistory(kolvipChannelId) {
    const all = await loadSeen();
    const bucket = all[kolvipChannelId];
    if (!bucket || typeof bucket !== "object") return false;
    const ids = /** @type {{ ids?: unknown }} */ (bucket).ids;
    return Array.isArray(ids) && ids.length > 0;
  }

  /**
   * @param {string} kolvipChannelId
   * @param {string[]} dataIds
   */
  async function rememberDataIds(kolvipChannelId, dataIds) {
    if (!dataIds.length) return;
    const all = await loadSeen();
    const bucket =
      all[kolvipChannelId] && typeof all[kolvipChannelId] === "object"
        ? /** @type {{ ids: string[] }} */ (all[kolvipChannelId])
        : { ids: [] };
    if (!Array.isArray(bucket.ids)) bucket.ids = [];
    for (const id of dataIds) {
      if (!id || bucket.ids.includes(id)) continue;
      bucket.ids.push(id);
    }
    if (bucket.ids.length > 500) bucket.ids = bucket.ids.slice(-500);
    all[kolvipChannelId] = bucket;
    await saveSeen(all);
  }

  async function probe() {
    return probeKolvipCdp(connectUrl());
  }

  async function runOnce() {
    if (running) return { ok: false, skipped: "busy", lastRun };
    if (!config.kolvipCdpEnabled) {
      return { ok: false, skipped: "disabled" };
    }
    if (!signalCards) {
      return { ok: false, error: "signalCards 未注入" };
    }
    const url = connectUrl();
    if (!url) {
      const msg = "未配置 CDP（KOLVIP_CDP_CONNECT_URL 或 CDP_CONNECT_URL）";
      lastRun = { at: new Date().toISOString(), ok: false, error: msg };
      return { ok: false, error: msg };
    }

    const channels = getKolvipChannelMappings();
    if (!channels.length) {
      const msg = "未配置巨鲸频道映射（KOLVIP_CHANNEL_IDS 或默认表）";
      lastRun = { at: new Date().toISOString(), ok: false, error: msg };
      return { ok: false, error: msg };
    }

    running = true;
    const started = Date.now();
    /** @type {Array<Record<string, unknown>>} */
    const summaries = [];
    let cardRowsProcessed = 0;

    try {
      pushLog(`巨鲸 CDP 抓取 ${channels.length} 频道 bypassDiscord=${config.kolvipCdpBypassDiscordSignals}`);
      const batches = await fetchKolvipChannelsViaCdp({
        connectUrl: url,
        channels,
        maxPerChannel: config.kolvipCdpMaxPerChannel,
        webUrl: kolvipWebUrl(),
        log,
      });

      for (const batch of batches) {
        const chId = batch.channel.kolvipChannelId;
        if (batch.error) {
          summaries.push({
            kolvipChannelId: chId,
            logicName: batch.channel.logicName,
            error: batch.error,
            fetched: 0,
            newCount: 0,
            seeded: false,
          });
          continue;
        }
        const messages = batch.messages ?? [];
        const allIds = messages.map((m) => m.dataId).filter(Boolean);
        const hadHistory = await channelHasSeenHistory(chId);
        const seedAll = !hadHistory;
        const newIds = seedAll ? [] : await filterNewDataIds(chId, allIds);
        const newSet = new Set(newIds);
        const toRemember = seedAll ? allIds : allIds;
        await rememberDataIds(chId, toRemember);

        /** @type {Record<string, unknown>[]} */
        const rows = [];
        let rowsQueued = 0;
        if (!seedAll) {
          for (const msg of messages) {
            if (!newSet.has(msg.dataId)) continue;
            rows.push(
              kolvipMessageToDiscordRow(msg, {
                kolvipChannelId: chId,
                discordChannelId: batch.channel.discordChannelId,
              })
            );
          }
          rowsQueued = rows.length;
          if (rows.length) {
            await runSignalCardPipelineForRows(rows, {
              signalCards,
              store,
              log,
              telegramPush: null,
              respectKolvipBypass: false,
            });
            cardRowsProcessed += rows.length;
          }
        } else {
          pushLog(
            `巨鲸 ${batch.channel.logicName} 首次记档 ${messages.length} 条（不推历史，与 Twitter CDP 一致）`
          );
        }

        summaries.push({
          kolvipChannelId: chId,
          logicName: batch.channel.logicName,
          fetched: messages.length,
          newCount: seedAll ? 0 : newIds.length,
          cardsQueued: seedAll ? 0 : rowsQueued,
          seeded: seedAll,
        });
      }

      lastRun = {
        at: new Date().toISOString(),
        ok: true,
        ms: Date.now() - started,
        channels: summaries,
        cardsQueued: cardRowsProcessed,
        bypassDiscordSignals: config.kolvipCdpBypassDiscordSignals,
      };
      broadcast?.("meta", { kind: "kolvip_cdp_run", ...lastRun });
      return { ok: true, ...lastRun };
    } catch (e) {
      const error = /** @type {Error} */ (e).message;
      lastRun = { at: new Date().toISOString(), ok: false, error };
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
    if (!config.kolvipCdpEnabled) return;
    timer = setInterval(() => {
      void runOnce().catch((e) =>
        log.warn(`Kolvip CDP tick: ${/** @type {Error} */ (e).message}`)
      );
    }, config.kolvipCdpIntervalMs);
  }

  async function status() {
    const cdp = await probe();
    return {
      ok: true,
      enabled: config.kolvipCdpEnabled,
      bypassDiscordSignals: config.kolvipCdpBypassDiscordSignals,
      running,
      lastRun,
      logs: logs.slice(0, 30),
      connectUrl: connectUrl() || null,
      webUrl: kolvipWebUrl(),
      channels: getKolvipChannelMappings(),
      cdp,
    };
  }

  async function start() {
    if (!config.kolvipCdpEnabled) {
      pushLog("巨鲸 CDP 未启用（KOLVIP_CDP_ENABLED=0，仍走 Discord 出卡）");
      return;
    }
    schedule();
    pushLog(
      `巨鲸 CDP 已启动 interval=${Math.round(config.kolvipCdpIntervalMs / 1000)}s channels=${getKolvipChannelMappings().length}`
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
