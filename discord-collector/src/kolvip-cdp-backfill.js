/**
 * 巨鲸 30 天 DOM 回溯骨架：分期、限速、状态持久化。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { getKolvipChannelMappings, kolvipWebUrl } from "./kolvip-cdp-config.js";
import { fetchKolvipChannelsViaCdp } from "./kolvip-cdp-fetch.js";
import { kolvipMessageToDiscordRow } from "./kolvip-cdp-message.js";
import { runSignalCardPipelineForRows } from "./discord-signal-pipeline.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_PATH = path.join(__dirname, "..", "data", "kolvip-backfill-state.json");

/** @typedef {"pending"|"running"|"cooldown"|"insufficient_sample"|"done"|"failed"|"paused"} KolvipBackfillStatus */

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {{ signalCards?: ReturnType<typeof import("./discord-signal-card-service.js").createDiscordSignalCardService> }} deps
 */
export function createKolvipBackfillService(store, log, deps = {}) {
  const signalCards = deps.signalCards ?? null;
  let running = false;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let cooldownTimer = null;
  /** @type {Record<string, unknown>} */
  let state = {
    enabled: config.kolvipBackfillEnabled,
    targetDays: config.kolvipBackfillTargetDays,
    phaseTotal: 0,
    phaseDone: 0,
    running: false,
    status: /** @type {KolvipBackfillStatus} */ ("pending"),
    lastError: "",
    updatedAt: new Date().toISOString(),
    channels: {},
  };

  async function loadState() {
    try {
      const raw = await fs.readFile(STATE_PATH, "utf8");
      const j = JSON.parse(raw);
      if (j && typeof j === "object") state = { ...state, ...j };
    } catch {
      /* fresh */
    }
    ensureChannelRows();
  }

  async function saveState() {
    state.updatedAt = new Date().toISOString();
    await fs.mkdir(path.dirname(STATE_PATH), { recursive: true });
    await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), "utf8");
  }

  function ensureChannelRows() {
    const mappings = getKolvipChannelMappings();
    /** @type {Record<string, unknown>} */
    const ch = state.channels && typeof state.channels === "object" ? state.channels : {};
    for (const m of mappings) {
      const key = m.kolvipChannelId;
      if (!ch[key]) {
        ch[key] = {
          logicName: m.logicName,
          kolvipChannelId: key,
          discordChannelId: m.discordChannelId,
          status: "pending",
          phasesDone: 0,
          phasesTotal: config.kolvipBackfillPhasesPerChannel,
          scrollPasses: 0,
          lastError: "",
        };
      }
    }
    state.channels = ch;
    state.phaseTotal = mappings.length * config.kolvipBackfillPhasesPerChannel;
  }

  function connectUrl() {
    return (config.kolvipCdpConnectUrl || config.cdpConnectUrl || "").trim();
  }

  function nextWorkItem() {
    ensureChannelRows();
    const mappings = getKolvipChannelMappings();
    for (const m of mappings) {
      const row = /** @type {Record<string, unknown>} */ (state.channels[m.kolvipChannelId]);
      if (!row || row.status === "done" || row.status === "paused") continue;
      const done = Number(row.phasesDone) || 0;
      const total = Number(row.phasesTotal) || config.kolvipBackfillPhasesPerChannel;
      if (done < total) {
        return { mapping: m, phaseIndex: done, row };
      }
      row.status = "done";
    }
    return null;
  }

  async function runPhaseStep() {
    if (!config.kolvipBackfillEnabled || !config.kolvipCdpEnabled) {
      return { ok: false, skipped: "disabled" };
    }
    if (state.status === "paused") {
      return { ok: false, skipped: "paused" };
    }
    if (running) return { ok: false, skipped: "busy" };
    if (!signalCards) return { ok: false, error: "signalCards 未注入" };
    const url = connectUrl();
    if (!url) return { ok: false, error: "无 CDP URL" };

    await loadState();
    const work = nextWorkItem();
    if (!work) {
      state.status = "done";
      state.running = false;
      await saveState();
      return { ok: true, completed: true };
    }

    running = true;
    state.running = true;
    state.status = "running";
    work.row.status = "running";
    work.row.lastError = "";
    await saveState();

    const scrollPasses = Math.min(
      8,
      config.kolvipBackfillScrollPassesBase +
        work.phaseIndex * config.kolvipBackfillScrollPassesStep
    );

    try {
      log.info(
        `巨鲸回溯 ch=${work.mapping.kolvipChannelId} phase=${work.phaseIndex + 1}/${work.row.phasesTotal} scroll=${scrollPasses}`
      );
      const batches = await fetchKolvipChannelsViaCdp({
        connectUrl: url,
        channels: [work.mapping],
        maxPerChannel: config.kolvipBackfillMaxPerPhase,
        webUrl: kolvipWebUrl(),
        scrollPasses,
        log,
      });
      const batch = batches[0];
      if (batch?.error) {
        throw new Error(batch.error);
      }
      const messages = batch?.messages ?? [];
      const rows = messages.map((msg) =>
        kolvipMessageToDiscordRow(msg, {
          kolvipChannelId: work.mapping.kolvipChannelId,
          discordChannelId: work.mapping.discordChannelId,
        })
      );
      if (rows.length) {
        await runSignalCardPipelineForRows(rows, {
          signalCards,
          store,
          log,
          telegramPush: null,
          respectKolvipBypass: false,
        });
      }

      work.row.phasesDone = work.phaseIndex + 1;
      work.row.scrollPasses = scrollPasses;
      work.row.status =
        work.row.phasesDone >= work.row.phasesTotal ? "done" : "cooldown";
      state.phaseDone = Number(state.phaseDone || 0) + 1;
      state.lastError = "";
      state.status = "cooldown";
      await saveState();

      return {
        ok: true,
        channelId: work.mapping.kolvipChannelId,
        phase: work.phaseIndex + 1,
        messages: messages.length,
        cardsProcessed: rows.length,
      };
    } catch (e) {
      const error = /** @type {Error} */ (e).message;
      work.row.status = "failed";
      work.row.lastError = error;
      state.status = "failed";
      state.lastError = error;
      log.warn(`巨鲸回溯失败: ${error}`);
      await saveState();
      return { ok: false, error };
    } finally {
      running = false;
      state.running = false;
      await saveState();
    }
  }

  function scheduleCooldown() {
    if (cooldownTimer) clearTimeout(cooldownTimer);
    if (!config.kolvipBackfillEnabled) return;
    cooldownTimer = setTimeout(() => {
      void runPhaseStep()
        .then(() => scheduleCooldown())
        .catch((e) => log.warn(`kolvip backfill: ${/** @type {Error} */ (e).message}`));
    }, config.kolvipBackfillCooldownMs);
  }

  async function getPublicState() {
    await loadState();
    return {
      ...state,
      enabled: config.kolvipBackfillEnabled && config.kolvipCdpEnabled,
      cooldownMs: config.kolvipBackfillCooldownMs,
      targetDays: config.kolvipBackfillTargetDays,
    };
  }

  async function start() {
    await loadState();
    if (!config.kolvipBackfillEnabled) return;
    if (state.status === "done") state.status = "pending";
    await saveState();
    scheduleCooldown();
    log.info("巨鲸回溯分期任务已调度");
  }

  function stop() {
    if (cooldownTimer) {
      clearTimeout(cooldownTimer);
      cooldownTimer = null;
    }
  }

  async function pause() {
    state.status = "paused";
    await saveState();
  }

  async function resume() {
    state.status = "pending";
    await saveState();
    scheduleCooldown();
  }

  return {
    start,
    stop,
    pause,
    resume,
    runPhaseStep,
    getPublicState,
  };
}
