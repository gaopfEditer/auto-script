/**
 * 巨鲸消息批次 → Show 消息行 + 建卡（实时 / 回溯共用）。
 * 消息 upsert 进 discord_messages（Show 读取的同一张表）；建卡/Telegram 仍走原管道。
 */
import { runSignalCardPipelineForRows } from "./discord-signal-pipeline.js";
import { kolvipMessageToDiscordRow } from "./kolvip-cdp-message.js";
import { getKolvipMappingByKolvipId } from "./kolvip-cdp-config.js";
import { kolvipScanVirtualChannelId } from "./kolvip-scan-config.js";
import { runBatchLiquidation } from "./card-liquidation-engine.js";
import { archiveCardToClient } from "./card-archive-service.js";
import { summarizeKolvipChannelEval } from "./kolvip-cdp-eval.js";
import { messageRowToClientForPush } from "./discord-message-format.js";
import { messageVisibleForKolvipShow } from "./discord-message-source-isolation.js";

export async function loadKolvipSeen(fs, seenPath) {
  try {
    const raw = await fs.readFile(seenPath, "utf8");
    const j = JSON.parse(raw);
    return j && typeof j === "object" ? j : {};
  } catch {
    return {};
  }
}

export async function saveKolvipSeen(fs, seenPath, data) {
  const pathMod = await import("node:path");
  await fs.mkdir(pathMod.dirname(seenPath), { recursive: true });
  await fs.writeFile(seenPath, JSON.stringify(data), "utf8");
}

export async function rememberKolvipDataIds(all, kolvipChannelId, dataIds) {
  const bucket =
    all[kolvipChannelId] && typeof all[kolvipChannelId] === "object"
      ? /** @type {{ ids: string[] }} */ (all[kolvipChannelId])
      : { ids: [] };
  if (!Array.isArray(bucket.ids)) bucket.ids = [];
  for (const id of dataIds) {
    if (!id || bucket.ids.includes(id)) continue;
    bucket.ids.push(id);
  }
  if (bucket.ids.length > 2000) bucket.ids = bucket.ids.slice(-2000);
  all[kolvipChannelId] = bucket;
}

/**
 * @param {import('./kolvip-cdp-message.js').KolvipDomMessage[]} messages
 * @param {{ kolvipChannelId: string, discordChannelId: string, source: string }} map
 */
function kolvipRowsFromMessages(messages, map) {
  /** @type {Record<string, unknown>[]} */
  const rows = [];
  for (const msg of messages) {
    if (!msg?.dataId) continue;
    rows.push(kolvipMessageToDiscordRow(msg, map));
  }
  return rows;
}

/**
 * @param {ReturnType<typeof import('./store.js').openStore>} store
 * @param {Record<string, unknown>[]} rows
 * @param {((channel: string, payload: Record<string, unknown>) => void) | undefined} broadcast
 * @param {boolean} pushLive
 */
async function upsertKolvipShowMessages(store, rows, broadcast, pushLive) {
  if (!rows.length || typeof store?.insertDiscordMessagesBatch !== "function") return 0;
  await store.insertDiscordMessagesBatch(rows);
  if (!pushLive || typeof broadcast !== "function") return rows.length;
  const visible = rows.filter((r) => messageVisibleForKolvipShow(r.channelId, r.source));
  if (!visible.length) return rows.length;
  try {
    broadcast("message", {
      kind: "discord_message_batch",
      source: String(visible[0]?.source ?? "kolvip_api"),
      count: visible.length,
      rows: visible.map((r) => messageRowToClientForPush(r)),
    });
  } catch {
    /* Show 仍可从接口读到已入库行 */
  }
  return rows.length;
}

/**
 * @param {{
 *   kolvipChannelId: string,
 *   channelName: string,
 *   messages: import('./kolvip-cdp-message.js').KolvipDomMessage[],
 *   mode: 'live'|'backfill',
 *   curated: boolean,
 *   seen?: Record<string, unknown>,
 *   signalCards: NonNullable<Parameters<typeof runSignalCardPipelineForRows>[1]['signalCards']>,
 *   store: ReturnType<typeof import('./store.js').openStore>,
 *   log: ReturnType<typeof import('./logger.js').createLogger>,
 *   skipLiquidation?: boolean,
 *   broadcast?: (channel: string, payload: Record<string, unknown>) => void,
 * }} opts
 */
export async function ingestKolvipMessageBatch(opts) {
  const kid = String(opts.kolvipChannelId).trim();
  const mapping = getKolvipMappingByKolvipId(kid);
  const curated = opts.curated && mapping;
  const discordChannelId = curated
    ? mapping.discordChannelId
    : kolvipScanVirtualChannelId(kid);
  const source =
    opts.mode === "live"
      ? "kolvip_api"
      : curated
        ? "kolvip_api_backfill"
        : "kolvip_api_scan";

  const messages = opts.messages ?? [];
  const allIds = messages.map((m) => m.dataId).filter(Boolean);

  let toProcess = messages;
  if (opts.mode === "live" && opts.seen) {
    const bucket =
      opts.seen[kid] && typeof opts.seen[kid] === "object"
        ? /** @type {{ ids?: string[] }} */ (opts.seen[kid])
        : { ids: [] };
    const set = new Set(Array.isArray(bucket.ids) ? bucket.ids.map(String) : []);
    const hadHistory = set.size > 0;
    if (!hadHistory) {
      const seedRows = kolvipRowsFromMessages(messages, {
        kolvipChannelId: kid,
        discordChannelId,
        source,
      });
      const messagesUpserted = await upsertKolvipShowMessages(
        opts.store,
        seedRows,
        opts.broadcast,
        true
      );
      await rememberKolvipDataIds(opts.seen, kid, allIds);
      return {
        fetched: messages.length,
        rowsQueued: 0,
        cardsQueued: 0,
        cardsCreated: 0,
        sourceUpgraded: 0,
        messagesUpserted,
        seeded: true,
        cardIds: [],
        skipCounts: {},
        channelName: opts.channelName || mapping?.logicName || kid,
        discordChannelId,
        source,
      };
    }
    toProcess = messages.filter((m) => m.dataId && !set.has(m.dataId));
    await rememberKolvipDataIds(opts.seen, kid, allIds);
  }

  const rows = kolvipRowsFromMessages(toProcess, {
    kolvipChannelId: kid,
    discordChannelId,
    source,
  });
  const messagesUpserted = await upsertKolvipShowMessages(
    opts.store,
    rows,
    opts.broadcast,
    opts.mode === "live"
  );

  /** @type {number[]} */
  const cardIds = [];
  const store = opts.store;
  /** @type {Record<string, number>} */
  let skipCounts = {};
  let pipelineCreated = 0;
  let sourceUpgraded = 0;
  if (rows.length) {
    const pipe = await runSignalCardPipelineForRows(rows, {
      signalCards: opts.signalCards,
      store: opts.store,
      log: opts.log,
      telegramPush: null,
      respectKolvipBypass: false,
      skipTelegram: opts.mode === "backfill" || !curated,
      skipOllamaFallback: opts.mode === "backfill",
    });
    pipelineCreated = pipe.created;
    sourceUpgraded = pipe.sourceUpgraded ?? 0;
    skipCounts = pipe.skipCounts;
    for (const r of rows) {
      const mid = String(r.messageId ?? "").trim();
      if (!mid || !store.getSignalCardByMessageId) continue;
      const card = await store.getSignalCardByMessageId(mid);
      const id = Number(card?.id ?? card?.ID);
      if (Number.isFinite(id) && id > 0) cardIds.push(id);
    }
  }

  const cardsCreated = pipelineCreated;
  if (rows.length && cardsCreated === 0 && sourceUpgraded === 0 && pipelineCreated === 0) {
    opts.log.info(
      `巨鲸 ingest 本批无新卡 channel=${kid} discordChannel=${discordChannelId} source=${source} queued=${rows.length} skips=${JSON.stringify(skipCounts)}`
    );
  } else if (sourceUpgraded > 0) {
    opts.log.info(
      `巨鲸 ingest 升级 source ${sourceUpgraded} 张（非新建）channel=${kid} source=${source}`
    );
  }

  // 手动 period 回溯：skipLiquidation=true，盈亏改走 /rebacktest 限速批量
  if (opts.mode === "backfill" && cardIds.length && !opts.skipLiquidation) {
    await runBatchLiquidation(opts.store, opts.log, { cardIds, limit: cardIds.length });
  }

  return {
    fetched: messages.length,
    rowsQueued: rows.length,
    messagesUpserted,
    cardsQueued: rows.length,
    cardsCreated,
    sourceUpgraded,
    seeded: false,
    cardIds,
    skipCounts,
    channelName: opts.channelName || mapping?.logicName || kid,
    discordChannelId,
    source,
  };
}

export async function summarizeChannelEvalFromStore(store, channelId, fromMs, toMs) {
  const rows = await store.listCardsForEval({
    fromMs,
    toMs,
    channelId,
    limit: 500,
  });
  /** @type {ReturnType<typeof archiveCardToClient>[]} */
  const cards = [];
  for (const r of rows) {
    try {
      cards.push(archiveCardToClient(/** @type {Record<string, unknown>} */ (r)));
    } catch {
      /* ignore */
    }
  }
  return summarizeKolvipChannelEval(cards);
}
