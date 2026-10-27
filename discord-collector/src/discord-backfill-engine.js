/**
 * Discord 频道回溯：CDP 上滚拉历史 → 解析信号 → 真实 K 线回测（不写库建卡）。
 */
import {
  normalizeBackfillDirection,
  runUnifiedBatchBacktestOnSignal,
} from "./backfill-batch-eval.js";
import { dedupeBackfillGroupCards } from "./backfill-card-dedup.js";
import { DISCORD_BACKFILL_PARSE_REPLAY_VERSION } from "./discord-backfill-parse-version.js";
import { extractSymbolFromPayload } from "./card-fields.js";
import { normalizeSignalText, signalTextHash } from "./discord-signal-dedup.js";
import {
  getSignalChannelConfig,
  isSignalChannel,
} from "./discord-signal-config.js";
import { executionFromParsed } from "./discord-signal-execution.js";
import {
  JUNZHANG_SL_LINK_MS,
  parseJunzhangSignals,
  parseSignalText,
} from "./discord-signal-parsers.js";
import { extractDiscordMessageContent, resolveDiscordMessageCreatedAtMs } from "./discord-gateway.js";
import { resolveCardSignalAt } from "./discord-signal-card-service.js";
import { cardRowParsed } from "./discord-signal-staged-trade.js";
import { createLogger } from "./logger.js";

const log = createLogger("discord-backfill");

/** 仅解析/拉取阶段：去掉盈亏回溯字段，避免与「批量回溯盈亏」混淆 */
export function stripBackfillGroupPnl(group) {
  if (!group || typeof group !== "object") return group;
  return {
    ...group,
    backtestItems: [],
    backtestsRun: 0,
    wins: 0,
    losses: 0,
    errors: 0,
    winRate: null,
    totalPnlPct: null,
    pnlSummedCount: 0,
    backtestEnrichedAt: undefined,
  };
}

/** @type {Record<string, { days: number, label: string }>} */
export const DISCORD_BACKFILL_PERIODS = {
  week: { days: 7, label: "近 1 周" },
  month1: { days: 30, label: "近 1 月" },
  month2: { days: 60, label: "近 2 月" },
  month3: { days: 90, label: "近 3 月" },
  month4: { days: 120, label: "近 4 月" },
};

/**
 * @param {unknown} raw
 * @returns {keyof typeof DISCORD_BACKFILL_PERIODS}
 */
export function normalizeDiscordBackfillPeriod(raw) {
  const p = String(raw ?? "week").trim().toLowerCase();
  if (p === "month" || p === "30d" || p === "m" || p === "1m") return "month1";
  if (p in DISCORD_BACKFILL_PERIODS) return /** @type {keyof typeof DISCORD_BACKFILL_PERIODS} */ (p);
  return "week";
}

/**
 * @param {string} period
 */
export function discordBackfillPeriodBounds(period) {
  const key = normalizeDiscordBackfillPeriod(period);
  const days = DISCORD_BACKFILL_PERIODS[key]?.days ?? 7;
  const toMs = Date.now();
  const fromMs = toMs - days * 86400000;
  return { period: key, days, fromMs, toMs };
}

function sleepMs(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {Record<string, unknown>} meta
 * @param {import("./store.js").StoreLike} store
 */
async function resolveGuildId(meta, store) {
  const fromMeta = String(meta.guildId ?? meta.guild_id ?? "").trim();
  if (fromMeta) return fromMeta;
  const env = String(process.env.DISCORD_BACKFILL_DEFAULT_GUILD_ID ?? "").trim();
  if (env) return env;
  const channelId = String(meta.channelId ?? meta.channel_id ?? "").trim();
  const ch = await store.getChannelMeta(channelId);
  return String(ch?.guild_id ?? ch?.guildId ?? "").trim();
}

/**
 * @param {{
 *   store: import("./store.js").StoreLike;
 *   scrollFn: (guildId: string, channelId: string, trace?: { beforeMessageId?: string }) => Promise<{ ok?: boolean; error?: string }>;
 *   navigateFn?: (guildId: string, channelId: string) => Promise<{ ok?: boolean; error?: string }>;
 *   guildId: string;
 *   channelId: string;
 *   fromMs: number;
 *   maxPages: number;
 *   onProgress?: (patch: Record<string, unknown>) => void;
 * }} opts
 */
export async function pullDiscordChannelHistoryUntil(opts) {
  const { store, scrollFn, navigateFn, guildId, channelId, fromMs, maxPages, onProgress } = opts;
  if (typeof scrollFn !== "function") {
    onProgress?.({ phase: "db_only", pagesDone: 0 });
    return { ok: true, pagesDone: 0, dbOnly: true };
  }
  if (navigateFn) {
    const nav = await navigateFn(guildId, channelId);
    if (!nav?.ok) {
      return { ok: false, pagesDone: 0, error: nav?.error ?? "CDP 导航失败" };
    }
    await sleepMs(800);
  }
  let pagesDone = 0;
  for (let i = 0; i < maxPages; i += 1) {
    const oldest = await store.getOldestDiscordMessageRowForChannel(channelId);
    if (oldest?.created_at_ms && oldest.created_at_ms <= fromMs) {
      break;
    }
    onProgress?.({ phase: "scroll", pagesDone, oldestMs: oldest?.created_at_ms ?? null });
    const out = await scrollFn(guildId, channelId, {
      beforeMessageId: oldest?.message_id || undefined,
    });
    if (!out?.ok) {
      return { ok: false, pagesDone, error: out?.error ?? "CDP 上滚失败" };
    }
    pagesDone += 1;
    await sleepMs(650);
    const after = await store.getOldestDiscordMessageRowForChannel(channelId);
    if (after?.message_id === oldest?.message_id && oldest?.message_id) {
      break;
    }
  }
  return { ok: true, pagesDone };
}

/**
 * @param {Array<Record<string, unknown>>} cards
 * @param {Record<string, unknown>} parsed
 * @param {number} atMs
 */
function mergeJunzhangStopIntoOpenCards(cards, parsed, atMs) {
  const execution = executionFromParsed(parsed);
  const sym = extractSymbolFromPayload(parsed, execution);
  const sl = String(parsed.stopLoss ?? execution.planned?.stopLossPrice ?? "").trim();
  if (!sym || !sl) return false;
  for (let j = cards.length - 1; j >= 0; j -= 1) {
    const c = cards[j];
    if (String(c.symbol ?? "") !== sym) continue;
    const cat = Date.parse(String(c.signalAt ?? ""));
    if (!Number.isFinite(cat) || atMs - cat > JUNZHANG_SL_LINK_MS) break;
    if (c.phase !== "open" && c.stopLoss) continue;
    cards[j] = {
      ...c,
      phase: "full",
      stopLoss: sl,
      cardPayload: {
        ...(c.cardPayload && typeof c.cardPayload === "object" ? c.cardPayload : {}),
        stopLoss: sl,
      },
    };
    return true;
  }
  return false;
}

/**
 * @param {import("./store.js").StoreLike | undefined} store
 * @param {Record<string, unknown>} row
 * @param {string} channelId
 * @param {string} parser
 */
function resolveDiscordBackfillMessageContent(row) {
  let content = normalizeSignalText(String(row.content ?? ""));
  let raw = row.raw_json;
  if (typeof raw === "string") {
    try {
      raw = JSON.parse(raw);
    } catch {
      raw = null;
    }
  }
  if (raw && typeof raw === "object") {
    const fromRaw = normalizeSignalText(
      extractDiscordMessageContent(/** @type {Record<string, unknown>} */ (raw)),
    );
    if (fromRaw) {
      if (!content) content = fromRaw;
      else if (fromRaw.length > content.length + 8) content = fromRaw;
      else if (!/现价开|参考价格|止损/i.test(content) && /现价开|参考价格|止损/i.test(fromRaw)) {
        content = fromRaw;
      }
    }
  }
  return content;
}

async function parseDiscordBackfillRow(store, row, channelId, parser) {
  const content = resolveDiscordBackfillMessageContent(row);
  if (!content) return { content: "", parsedList: [] };

  const mid = String(row.message_id ?? "");
  const src = String(row.source ?? "");
  if (store?.getSignalCardById && (src === "card_api" || mid.startsWith("card-api-"))) {
    let raw = row.raw_json;
    if (typeof raw === "string") {
      try {
        raw = JSON.parse(raw);
      } catch {
        raw = null;
      }
    }
    const rec = raw && typeof raw === "object" ? /** @type {Record<string, unknown>} */ (raw) : null;
    const cardId = Number(rec?.cardId ?? 0);
    if (cardId > 0) {
      const cardRow = await store.getSignalCardById(cardId);
      const parsed = cardRow ? cardRowParsed(cardRow) : null;
      if (parsed) return { content, parsedList: [parsed] };
    }
  }

  if (parser === "junzhang") {
    return { content, parsedList: parseJunzhangSignals(content) };
  }
  const one = parseSignalText(content, parser);
  return { content, parsedList: one ? [one] : [] };
}

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {string} channelId
 * @param {{ maxBacktests?: number; channelName?: string; store?: import("./store.js").StoreLike; fromMs?: number; toMs?: number }} [opts]
 */
export async function replayDiscordChannelMessages(rows, channelId, opts = {}) {
  const chCfg = getSignalChannelConfig(channelId);
  const parser = chCfg?.parser ?? "generic";
  const store = opts.store;
  const dedup = new Set();
  let messageCount = 0;
  let tradeLikeCount = 0;
  let parsedSignalCount = 0;
  /** @type {Record<string, number>} */
  const symbols = {};
  /** @type {Array<Record<string, unknown>>} */
  const samples = [];
  /** @type {Array<Record<string, unknown>>} */
  const cards = [];
  /** @type {Array<Record<string, unknown>>} */
  const backtestItems = [];
  const maxBt = Math.max(0, Number(opts.maxBacktests) || 40);
  let backtestsRun = 0;
  let wins = 0;
  let losses = 0;
  let errors = 0;

  for (const row of rows) {
    messageCount += 1;
    const { content, parsedList } = await parseDiscordBackfillRow(store, row, channelId, parser);
    if (!content) continue;
    if (/多|空|long|short|止盈|止损|entry|tp|sl|入场|【卡片】|现价开/i.test(content)) tradeLikeCount += 1;

    const msgHash = signalTextHash(content);
    if (dedup.has(msgHash)) continue;
    dedup.add(msgHash);

    if (!parsedList.length) continue;

    const messageId = String(row.message_id ?? "").trim();
    const signalMs = resolveDiscordMessageCreatedAtMs({
      created_at_ms: row.created_at_ms,
      messageId,
      raw_json: row.raw_json,
    });
    const signalAt =
      signalMs > 0 ? new Date(signalMs).toISOString() : new Date().toISOString();

    for (const parsed of parsedList) {
      const phaseEarly = String(parsed.signalPhase ?? "full");
      if (
        parser === "junzhang" &&
        phaseEarly === "tpsl" &&
        mergeJunzhangStopIntoOpenCards(cards, parsed, signalMs)
      ) {
        continue;
      }

      const execution = executionFromParsed(parsed);
      const sym = extractSymbolFromPayload(parsed, execution);
      const dirNorm = normalizeBackfillDirection(parsed.direction ?? execution.direction);
      const entry = execution.planned?.entryPrice ?? parsed.entry ?? "";
      const sigKey = signalTextHash(
        `${sym}|${dirNorm}|${String(entry ?? "").trim() || "mkt"}|${String(parsed.signalPhase ?? "")}`,
      );
      if (dedup.has(sigKey)) continue;
      dedup.add(sigKey);

      parsedSignalCount += 1;
      if (sym) symbols[sym] = (symbols[sym] ?? 0) + 1;

      if (samples.length < 8) {
        samples.push({
          phase: parsed.signalPhase ?? "full",
          symbol: sym || "",
          direction: parsed.direction ?? execution.direction ?? "",
          preview: content.slice(0, 120),
          messageId,
          signalAt,
        });
      }

      const phase = String(parsed.signalPhase ?? "full");
      if (phase === "tpsl") continue;
      if (!sym || !dirNorm) continue;
      const stopLoss = execution.planned?.stopLossPrice ?? parsed.stopLoss ?? "";
      const targets = execution.planned?.takeProfitPrices ?? parsed.targets ?? [];
      const signal = {
        phase,
        symbol: sym,
        direction: parsed.direction ?? execution.direction,
        directionNorm: dirNorm,
        messageId,
        signalAt,
        entry: String(entry ?? "").trim() || null,
        stopLoss: String(stopLoss ?? "").trim() || null,
        targets,
        preview: content.slice(0, 160),
        cardPayload: {
          symbol: sym,
          direction: dirNorm,
          entry,
          stopLoss,
          targets,
          signalAt,
          body: content.slice(0, 800),
          channelId,
          messageId,
        },
      };
      cards.push({ ...signal });
      if (maxBt <= 0 || backtestsRun >= maxBt) continue;
      const item = await runUnifiedBatchBacktestOnSignal(signal, {
        channelId,
        channelName: opts.channelName ?? "",
        sourceType: "discord",
        forceMarketEntry: !String(entry ?? "").trim(),
      });
      backtestsRun += 1;
      backtestItems.push(item);
      if (item.error && !item.entered) errors += 1;
      else if (!item.entered) {
        /* notEntered tracked below */
      } else if (item.pnlPct != null && Number(item.pnlPct) > 0) wins += 1;
      else if (item.pnlPct != null && Number(item.pnlPct) < 0) losses += 1;
      else if (item.outcome === "take_profit") wins += 1;
      else if (item.outcome === "stop_loss") losses += 1;
      await sleepMs(80);
    }
  }

  if (store?.listSignalCards) {
    const fromMs = Number(opts.fromMs) || 0;
    const toMs = Number(opts.toMs) || 0;
    /** @type {Set<string>} */
    const cardKeys = new Set(
      cards.map((c) => `${String(c.symbol ?? "")}|${String(c.signalAt ?? "")}|${String(c.directionNorm ?? "")}`),
    );
    try {
      const dbCards = await store.listSignalCards({
        channelId,
        fromMs: fromMs > 0 ? fromMs : undefined,
        toMs: toMs > 0 ? toMs : undefined,
        limit: 500,
      });
      for (const row of dbCards) {
        const parsed = cardRowParsed(row);
        if (!parsed) continue;
        const execution = executionFromParsed(parsed);
        const sym = extractSymbolFromPayload(parsed, execution);
        const dirNorm = normalizeBackfillDirection(parsed.direction ?? execution.direction);
        if (!sym || !dirNorm) continue;
        const phase = String(parsed.signalPhase ?? "full");
        if (phase === "tpsl") continue;
        const signalAt = String(resolveCardSignalAt(row) ?? "").trim();
        if (!signalAt) continue;
        const key = `${sym}|${signalAt}|${dirNorm}`;
        if (cardKeys.has(key)) continue;
        const dedupeKey = `signal-card-${String(row.id ?? row.ID ?? "")}`;
        if (dedup.has(dedupeKey)) continue;
        dedup.add(dedupeKey);
        cardKeys.add(key);
        parsedSignalCount += 1;
        symbols[sym] = (symbols[sym] ?? 0) + 1;
        const entry = execution.planned?.entryPrice ?? parsed.entry ?? "";
        const stopLoss = execution.planned?.stopLossPrice ?? parsed.stopLoss ?? "";
        const targets = execution.planned?.takeProfitPrices ?? parsed.targets ?? [];
        const preview = String(row.raw_content ?? row.rawContent ?? "").slice(0, 160);
        const signal = {
          phase,
          symbol: sym,
          direction: parsed.direction ?? execution.direction,
          directionNorm: dirNorm,
          messageId: `signal-card-${String(row.id ?? "")}`,
          signalAt,
          entry: String(entry ?? "").trim() || null,
          stopLoss: String(stopLoss ?? "").trim() || null,
          targets,
          preview,
          cardPayload: {
            symbol: sym,
            direction: dirNorm,
            entry,
            stopLoss,
            targets,
            signalAt,
            body: preview,
            channelId,
            signalCardId: row.id,
          },
        };
        cards.push({ ...signal });
        if (maxBt > 0 && backtestsRun < maxBt) {
          const item = await runUnifiedBatchBacktestOnSignal(signal, {
            channelId,
            channelName: opts.channelName ?? "",
            sourceType: "discord",
          });
          backtestsRun += 1;
          backtestItems.push(item);
          if (item.error && !item.entered) errors += 1;
          else if (!item.entered) {
            /* skip */
          } else if (item.pnlPct != null && Number(item.pnlPct) > 0) wins += 1;
          else if (item.pnlPct != null && Number(item.pnlPct) < 0) losses += 1;
          else if (item.outcome === "take_profit") wins += 1;
          else if (item.outcome === "stop_loss") losses += 1;
          await sleepMs(80);
        }
      }
    } catch (e) {
      log.warn(`signal_cards 合并失败 channel=${channelId}: ${String(/** @type {Error} */ (e).message ?? e)}`);
    }
  }

  const decided = wins + losses;
  let totalPnlPct = 0;
  let pnlSummedCount = 0;
  for (const item of backtestItems) {
    const p = Number(item.pnlPct);
    if (Number.isFinite(p)) {
      totalPnlPct += p;
      pnlSummedCount += 1;
    }
  }
  return {
    messageCount,
    tradeLikeCount,
    parsedSignalCount,
    cardEmitCount: parsedSignalCount,
    symbols,
    samples,
    cards,
    scrollPages: 0,
    backtestsRun,
    winRate: decided ? wins / decided : null,
    wins,
    losses,
    backtestItems,
    totalPnlPct: pnlSummedCount ? Math.round(totalPnlPct * 100) / 100 : null,
    pnlSummedCount,
  };
}

/**
 * @param {{
 *   store: import("./store.js").StoreLike;
 *   scrollFn: (guildId: string, channelId: string, trace?: { beforeMessageId?: string }) => Promise<{ ok?: boolean; error?: string }>;
 *   navigateFn?: (guildId: string, channelId: string) => Promise<{ ok?: boolean; error?: string }>;
 *   groups: Array<Record<string, unknown>>;
 *   period: string;
 *   maxScrollPages: number;
 *   maxBacktestsPerChannel: number;
 *   onProgress?: (patch: Record<string, unknown>) => void;
 * }} opts
 */
export async function runDiscordBackfillScan(opts) {
  const { store, scrollFn, navigateFn, groups, period, maxScrollPages, maxBacktestsPerChannel, onProgress } =
    opts;
  const { fromMs, toMs, days, period: periodKey } = discordBackfillPeriodBounds(period);
  /** @type {Array<Record<string, unknown>>} */
  const results = [];

  for (const meta of groups) {
    const channelId = String(meta.channelId ?? meta.channel_id ?? "").trim();
    const name = String(meta.name ?? channelId);
    if (!channelId) continue;
    if (!isSignalChannel(channelId)) {
      results.push({
        channelId,
        name,
        ok: false,
        error: "非信号频道或未在 discord-signal-config 中配置",
        messageCount: 0,
        tradeLikeCount: 0,
        parsedSignalCount: 0,
        cardEmitCount: 0,
        symbols: {},
        samples: [],
      });
      continue;
    }

    onProgress?.({ channelId, name, phase: "start" });
    const guildId = await resolveGuildId(meta, store);
    if (!guildId) {
      results.push({
        channelId,
        name,
        ok: false,
        error: "缺少 guildId：请在 discord_groups.json 的 backfillChannels 填写 guildId，或确保库内有该频道消息",
        messageCount: 0,
        tradeLikeCount: 0,
        parsedSignalCount: 0,
        cardEmitCount: 0,
        symbols: {},
        samples: [],
      });
      continue;
    }

    try {
      const pull = await pullDiscordChannelHistoryUntil({
        store,
        scrollFn,
        navigateFn,
        guildId,
        channelId,
        fromMs,
        maxPages: maxScrollPages,
        onProgress: (p) => onProgress?.({ channelId, name, ...p }),
      });
      if (!pull.ok) {
        results.push({
          channelId,
          name,
          guildId,
          ok: false,
          error: pull.error ?? "拉取历史失败",
          scrollPages: pull.pagesDone ?? 0,
          messageCount: 0,
          tradeLikeCount: 0,
          parsedSignalCount: 0,
          cardEmitCount: 0,
          symbols: {},
          samples: [],
        });
        continue;
      }

      if (typeof store.repairDiscordMessageCreatedAtForChannel === "function") {
        await store.repairDiscordMessageCreatedAtForChannel(channelId);
      }
      let rows = await store.listDiscordMessagesInTimeRange(channelId, fromMs, toMs);
      if (!rows.length && (fromMs > 0 || toMs > 0)) {
        const all = await store.listDiscordMessagesInTimeRange(channelId, 0, 0);
        rows = all.filter((row) => {
          const ms = resolveDiscordMessageCreatedAtMs({
            created_at_ms: row.created_at_ms,
            messageId: row.message_id,
            raw_json: row.raw_json,
          });
          if (fromMs > 0 && ms < fromMs) return false;
          if (toMs > 0 && ms > toMs) return false;
          return true;
        });
      }
      log.info(`[${name}] 库内 ${rows.length} 条 (${periodKey}) scroll=${pull.pagesDone}`);
      const replay = await replayDiscordChannelMessages(rows, channelId, {
        maxBacktests: maxBacktestsPerChannel,
        channelName: name,
        store,
        fromMs,
        toMs,
      });
      const deduped = dedupeBackfillGroupCards({
        channelId,
        name,
        guildId,
        ok: true,
        error: null,
        scrollPages: pull.pagesDone,
        parseReplayVersion: DISCORD_BACKFILL_PARSE_REPLAY_VERSION,
        ...replay,
      });
      results.push(stripBackfillGroupPnl(deduped));
    } catch (e) {
      results.push({
        channelId,
        name,
        ok: false,
        error: String(/** @type {Error} */ (e).message ?? e),
        messageCount: 0,
        tradeLikeCount: 0,
        parsedSignalCount: 0,
        cardEmitCount: 0,
        symbols: {},
        samples: [],
      });
    }
  }

  const ranking = [...results].sort(
    (a, b) =>
      Number(b.cardEmitCount ?? b.parsedSignalCount ?? 0) - Number(a.cardEmitCount ?? a.parsedSignalCount ?? 0) ||
      Number(b.tradeLikeCount ?? 0) - Number(a.tradeLikeCount ?? 0),
  );

  return {
    ok: true,
    replayMode: "discord_signal_parse_validate",
    parseOnly: true,
    period: periodKey,
    periodDays: days,
    fromMs,
    toMs,
    generatedAt: new Date().toISOString(),
    groupCount: results.length,
    groups: results,
    ranking,
    backtestEnrichedAt: undefined,
  };
}
