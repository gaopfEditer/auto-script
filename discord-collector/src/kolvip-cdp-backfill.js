/**
 * 巨鲸 DOM 历史回溯 Job 骨架（分期 + 限速；大批量可 shadow）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { getKolvipChannelMappings, getKolvipMappingByKolvipId } from "./kolvip-cdp-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, "..", "data", "kolvip-backfill.json");

/** @typedef {'idle'|'pending'|'running'|'cooldown'|'insufficient_sample'|'done'|'failed'|'paused'} KolvipBackfillStatus */

/**
 * @typedef {{
 *   status: KolvipBackfillStatus,
 *   backfillCursor: string|null,
 *   sampleCount: number,
 *   lastError: string|null,
 *   updatedAt: string,
 *   batchesDone: number,
 * }} KolvipBackfillChannelState
 */

/**
 * @param {Record<string, KolvipBackfillChannelState>} jobs
 */
function defaultJobs(jobs = {}) {
  /** @type {Record<string, KolvipBackfillChannelState>} */
  const out = { ...jobs };
  for (const m of getKolvipChannelMappings()) {
    if (!out[m.kolvipChannelId]) {
      out[m.kolvipChannelId] = {
        status: "idle",
        backfillCursor: null,
        sampleCount: 0,
        lastError: null,
        updatedAt: new Date(0).toISOString(),
        batchesDone: 0,
      };
    }
  }
  return out;
}

async function loadState() {
  try {
    const raw = await fs.readFile(STATE_PATH, "utf8");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") throw new Error("bad json");
    return {
      version: 1,
      shadow: Boolean(j.shadow),
      globalPaused: Boolean(j.globalPaused),
      jobs: defaultJobs(
        j.jobs && typeof j.jobs === "object"
          ? /** @type {Record<string, KolvipBackfillChannelState>} */ (j.jobs)
          : {}
      ),
    };
  } catch {
    return {
      version: 1,
      shadow: config.kolvipBackfillShadow,
      globalPaused: false,
      jobs: defaultJobs(),
    };
  }
}

/** @param {Awaited<ReturnType<typeof loadState>>} state */
async function saveState(state) {
  await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
  await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
}

/**
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 */
export function createKolvipBackfillService(log) {
  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let ticking = false;

  async function status() {
    const state = await loadState();
    return {
      ok: true,
      enabled: config.kolvipBackfillEnabled,
      shadow: state.shadow ?? config.kolvipBackfillShadow,
      globalPaused: state.globalPaused,
      config: {
        batchSize: config.kolvipBackfillBatchSize,
        daysPerBatch: config.kolvipBackfillDaysPerBatch,
        channelCooldownMs: config.kolvipBackfillChannelCooldownMs,
        batchCooldownMs: config.kolvipBackfillBatchCooldownMs,
        maxRetries: config.kolvipBackfillMaxRetries,
        pilotChannelId: config.kolvipBackfillPilotChannelId || null,
      },
      jobs: state.jobs,
    };
  }

  /**
   * @param {string} kolvipChannelId
   */
  async function startPilot(kolvipChannelId) {
    const kid = String(kolvipChannelId ?? "").trim();
    const map = getKolvipMappingByKolvipId(kid);
    if (!map) {
      throw new Error(`未映射的巨鲸频道 ch=${kid}`);
    }
    const state = await loadState();
    state.jobs[kid] = {
      status: "pending",
      backfillCursor: null,
      sampleCount: 0,
      lastError: null,
      updatedAt: new Date().toISOString(),
      batchesDone: 0,
    };
    state.globalPaused = false;
    await saveState(state);
    log.info(`巨鲸回溯排队 ch=${kid} ${map.logicName} shadow=${state.shadow}`);
    schedule();
    return status();
  }

  async function pauseAll() {
    const state = await loadState();
    state.globalPaused = true;
    for (const kid of Object.keys(state.jobs)) {
      if (state.jobs[kid].status === "running" || state.jobs[kid].status === "pending") {
        state.jobs[kid].status = "paused";
        state.jobs[kid].updatedAt = new Date().toISOString();
      }
    }
    await saveState(state);
    return status();
  }

  async function tick() {
    if (ticking) return;
    if (!config.kolvipBackfillEnabled) return;
    ticking = true;
    try {
      const state = await loadState();
      if (state.globalPaused) return;
      const kid =
        config.kolvipBackfillPilotChannelId ||
        Object.keys(state.jobs).find((id) =>
          ["pending", "running", "cooldown"].includes(state.jobs[id].status)
        );
      if (!kid || !state.jobs[kid]) return;
      const job = state.jobs[kid];
      const map = getKolvipMappingByKolvipId(kid);
      if (!map) return;

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
        log.debug(
          `巨鲸回溯 shadow ch=${kid} batch=${job.batchesDone + 1} size=${config.kolvipBackfillBatchSize}`
        );
        job.batchesDone += 1;
        job.sampleCount += Math.min(config.kolvipBackfillBatchSize, 3);
        job.backfillCursor = `shadow-${job.batchesDone}`;
        job.status = "cooldown";
        job.updatedAt = new Date().toISOString();
        if (job.batchesDone >= 2) {
          job.status = job.sampleCount >= 5 ? "done" : "insufficient_sample";
        }
        await saveState(state);
        return;
      }

      job.status = "failed";
      job.lastError = "DOM 回溯尚未实现（请保持 KOLVIP_BACKFILL_SHADOW=1 试点）";
      job.updatedAt = new Date().toISOString();
      await saveState(state);
    } catch (e) {
      log.warn(`巨鲸回溯 tick: ${/** @type {Error} */ (e).message}`);
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
      `巨鲸回溯骨架已启动 shadow=${config.kolvipBackfillShadow} pilot=${config.kolvipBackfillPilotChannelId || "auto"}`
    );
  }

  return { start, stop, status, startPilot, pauseAll, tick };
}
