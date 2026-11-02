/**
 * 巨鲸全站频道 ~30 天 API 回溯：建卡 + 清算（eval 口径），分期防封。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import {
  getKolvipChannelMappings,
  getKolvipMappedKolvipChannelIds,
  getKolvipMappingByKolvipId,
} from "./kolvip-cdp-config.js";
import { kolvipApiFetchChannelMessages, KolvipApiError } from "./kolvip-api-client.js";
import { buildKolvipApiClient } from "./kolvip-api-fetch.js";
import { kolvipApiRawToDomMessage } from "./kolvip-api-message.js";
import {
  loadKolvipCatalogCache,
  listKolvipBrowseChannels,
  syncKolvipChannelCatalog,
} from "./kolvip-api-catalog.js";
import { ingestKolvipMessageBatch, summarizeChannelEvalFromStore } from "./kolvip-ingest.js";
import { kolvipScanVirtualChannelId } from "./kolvip-scan-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, "..", "data", "kolvip-backfill.json");

/** @typedef {'idle'|'pending'|'running'|'cooldown'|'insufficient_sample'|'done'|'failed'|'paused'} KolvipBackfillStatus */

/**
 * @typedef {{
 *   status: KolvipBackfillStatus,
 *   backfillCursor: string|null,
 *   sampleCount: number,
 *   cardsCreated: number,
 *   lastError: string|null,
 *   updatedAt: string,
 *   batchesDone: number,
 *   channelName: string,
 *   curated: boolean,
 *   targetFromMs: number,
 *   oldestMessageMs: number|null,
 * }} KolvipBackfillChannelState
 */

function targetFromMs() {
  return Date.now() - config.kolvipBackfillDays * 86400000;
}

function newJob(/** @type {Partial<KolvipBackfillChannelState>} */ patch) {
  return {
    status: /** @type {KolvipBackfillStatus} */ ("idle"),
    backfillCursor: null,
    sampleCount: 0,
    cardsCreated: 0,
    lastError: null,
    updatedAt: new Date(0).toISOString(),
    batchesDone: 0,
    channelName: "",
    curated: false,
    targetFromMs: targetFromMs(),
    oldestMessageMs: null,
    ...patch,
  };
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") throw new Error("bad json");
    return {
      version: 2,
      shadow: Boolean(j.shadow),
      globalPaused: Boolean(j.globalPaused),
      catalogSyncedAt: String(j.catalogSyncedAt ?? ""),
      jobs:
        j.jobs && typeof j.jobs === "object"
          ? /** @type {Record<string, KolvipBackfillChannelState>} */ (j.jobs)
          : {},
    };
  } catch {
    return {
      version: 2,
      shadow: config.kolvipBackfillShadow,
      globalPaused: false,
      catalogSyncedAt: "",
      jobs: /** @type {Record<string, KolvipBackfillChannelState>} */ ({}),
    };
  }
}

/** @param {Awaited<ReturnType<typeof loadState>>} state */
async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {{
 *   signalCards?: ReturnType<typeof import("./discord-signal-card-service.js").createDiscordSignalCardService>,
 * }} [deps]
 */
export function createKolvipBackfillService(store, log, deps = {}) {
  const signalCards = deps.signalCards ?? null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let ticking = false;

  async function ensureCatalogJobs(state) {
    const catalog = await loadKolvipCatalogCache();
    let list = listKolvipBrowseChannels(catalog);
    if (!list.length && config.kolvipBackfillAllChannels) {
      try {
        await syncKolvipChannelCatalog(log);
        const refreshed = await loadKolvipCatalogCache();
        list = listKolvipBrowseChannels(refreshed);
        state.catalogSyncedAt = refreshed.updatedAt;
      } catch (e) {
        log.warn(`巨鲸目录同步失败: ${/** @type {Error} */ (e).message}`);
      }
    }
    const curated = getKolvipMappedKolvipChannelIds();
    for (const ch of list) {
      if (!state.jobs[ch.kolvipChannelId]) {
        state.jobs[ch.kolvipChannelId] = newJob({
          channelName: ch.name,
          curated: curated.has(ch.kolvipChannelId),
          status: "idle",
        });
      }
    }
  }

  async function status() {
    const state = await loadState();
    return {
      ok: true,
      enabled: config.kolvipBackfillEnabled,
      shadow: state.shadow ?? config.kolvipBackfillShadow,
      globalPaused: state.globalPaused,
      catalogSyncedAt: state.catalogSyncedAt,
      config: {
        days: config.kolvipBackfillDays,
        batchSize: config.kolvipBackfillBatchSize,
        allChannels: config.kolvipBackfillAllChannels,
        channelCooldownMs: config.kolvipBackfillChannelCooldownMs,
        batchCooldownMs: config.kolvipBackfillBatchCooldownMs,
        maxRetries: config.kolvipBackfillMaxRetries,
        pilotChannelId: config.kolvipBackfillPilotChannelId || null,
      },
      jobs: state.jobs,
    };
  }

  async function syncCatalog() {
    const saved = await syncKolvipChannelCatalog(log);
    const state = await loadState();
    state.catalogSyncedAt = saved.updatedAt;
    await ensureCatalogJobs(state);
    await saveState(state);
    return status();
  }

  async function queueAllChannels() {
    const state = await loadState();
    state.globalPaused = false;
    await ensureCatalogJobs(state);
    for (const kid of Object.keys(state.jobs)) {
      if (state.jobs[kid].status === "done") continue;
      state.jobs[kid].status = "pending";
      state.jobs[kid].targetFromMs = targetFromMs();
      state.jobs[kid].updatedAt = new Date().toISOString();
    }
    await saveState(state);
    schedule();
    return status();
  }

  async function startPilot(kolvipChannelId) {
    const kid = String(kolvipChannelId ?? "").trim();
    const map = getKolvipMappingByKolvipId(kid);
    const state = await loadState();
    state.jobs[kid] = newJob({
      status: "pending",
      channelName: map?.logicName ?? `ch-${kid}`,
      curated: Boolean(map),
      targetFromMs: targetFromMs(),
      updatedAt: new Date().toISOString(),
    });
    state.globalPaused = false;
    await saveState(state);
    schedule();
    return status();
  }

  async function pauseAll() {
    const state = await loadState();
    state.globalPaused = true;
    for (const kid of Object.keys(state.jobs)) {
      if (["running", "pending", "cooldown"].includes(state.jobs[kid].status)) {
        state.jobs[kid].status = "paused";
        state.jobs[kid].updatedAt = new Date().toISOString();
      }
    }
    await saveState(state);
    return status();
  }

  function pickNextJob(state) {
    if (config.kolvipBackfillPilotChannelId) {
      return config.kolvipBackfillPilotChannelId;
    }
    return Object.keys(state.jobs).find((id) =>
      ["pending", "running", "cooldown"].includes(state.jobs[id].status)
    );
  }

  async function tick() {
    if (ticking) return;
    if (!config.kolvipBackfillEnabled) return;
    if (!signalCards) return;
    ticking = true;
    try {
      const state = await loadState();
      if (state.globalPaused) return;
      await ensureCatalogJobs(state);
      const kid = pickNextJob(state);
      if (!kid || !state.jobs[kid]) {
        await saveState(state);
        return;
      }
      const job = state.jobs[kid];

      if (job.status === "running") {
        const staleMs = Date.now() - Date.parse(job.updatedAt);
        if (staleMs > 8 * 60 * 1000) {
          log.warn(
            `巨鲸回溯 ${kid} status=running 已 ${Math.round(staleMs / 1000)}s 无进展，重置为 pending`
          );
          job.status = "pending";
          job.updatedAt = new Date().toISOString();
          await saveState(state);
        }
      }

      if (job.status === "cooldown") {
        const elapsed = Date.now() - Date.parse(job.updatedAt);
        if (elapsed < config.kolvipBackfillBatchCooldownMs) return;
        job.status = "pending";
      }
      if (job.status !== "pending" && job.status !== "running") return;

      job.status = "running";
      job.updatedAt = new Date().toISOString();
      await saveState(state);

      if (state.shadow || config.kolvipBackfillShadow) {
        job.batchesDone += 1;
        job.sampleCount += 2;
        job.cardsCreated += 1;
        job.backfillCursor = `shadow-${job.batchesDone}`;
        job.status = "cooldown";
        job.updatedAt = new Date().toISOString();
        if (job.batchesDone >= 3) job.status = "done";
        await saveState(state);
        return;
      }

      const { client } = await buildKolvipApiClient(log);
      const beforeId = job.backfillCursor ? Number(job.backfillCursor) || 0 : 0;
      const raw = await kolvipApiFetchChannelMessages(client, kid, {
        beforeId,
        limit: config.kolvipBackfillBatchSize,
      });
      const dom = raw
        .map((r) => kolvipApiRawToDomMessage(r))
        .filter((m) => m.dataId)
        .sort((a, b) => Number(a.dataId) - Number(b.dataId));

      if (!dom.length) {
        job.status = job.cardsCreated > 0 ? "done" : "insufficient_sample";
        job.updatedAt = new Date().toISOString();
        await saveState(state);
        return;
      }

      const inWindow = dom.filter((m) => {
        const ms = Date.parse(m.timeTitle || "");
        return Number.isFinite(ms) && ms >= job.targetFromMs;
      });

      const ingestResult = await ingestKolvipMessageBatch({
        kolvipChannelId: kid,
        channelName: job.channelName,
        messages: inWindow.length ? inWindow : dom,
        mode: "backfill",
        curated: job.curated,
        signalCards,
        store,
        log,
      });

      job.batchesDone += 1;
      job.cardsCreated += ingestResult.cardsCreated;
      job.sampleCount += ingestResult.fetched;
      const oldest = dom[0];
      const oldestMs = Date.parse(oldest.timeTitle || "");
      job.oldestMessageMs = Number.isFinite(oldestMs) ? oldestMs : job.oldestMessageMs;
      job.backfillCursor = String(oldest.dataId);
      job.lastError = null;

      const evalChannelId = job.curated
        ? getKolvipMappingByKolvipId(kid)?.discordChannelId
        : kolvipScanVirtualChannelId(kid);
      if (evalChannelId) {
        await summarizeChannelEvalFromStore(store, evalChannelId, job.targetFromMs, Date.now());
      }

      job.status = "cooldown";
      job.updatedAt = new Date().toISOString();
      if (
        (Number.isFinite(oldestMs) && oldestMs < job.targetFromMs) ||
        dom.length < config.kolvipBackfillBatchSize
      ) {
        job.status = job.cardsCreated > 0 ? "done" : "insufficient_sample";
      }

      await saveState(state);
    } catch (e) {
      const msg = e instanceof KolvipApiError ? e.message : /** @type {Error} */ (e).message;
      log.warn(`巨鲸回溯 tick: ${msg}`);
      const state = await loadState();
      const kid = pickNextJob(state);
      if (kid && state.jobs[kid]) {
        state.jobs[kid].status = "failed";
        state.jobs[kid].lastError = msg;
        state.jobs[kid].updatedAt = new Date().toISOString();
        await saveState(state);
      }
    } finally {
      ticking = false;
    }
  }

  function schedule() {
    if (timer) clearInterval(timer);
    if (!config.kolvipBackfillEnabled) return;
    const ms = Math.max(5000, config.kolvipBackfillTickMs);
    timer = setInterval(() => {
      void tick().catch(() => {});
    }, ms);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  async function start() {
    if (!config.kolvipBackfillEnabled) return;
    schedule();
    log.info(
      `巨鲸回溯已启动 days=${config.kolvipBackfillDays} shadow=${config.kolvipBackfillShadow} allChannels=${config.kolvipBackfillAllChannels}`
    );
  }

  return { start, stop, status, startPilot, queueAllChannels, syncCatalog, pauseAll, tick };
}
