/**
 * Discord 回溯结果：补全卡片 signalAt / 从库内重放解析。
 */
import { replayDiscordChannelMessages } from "./discord-backfill-engine.js";
import { dedupeBackfillGroupCards } from "./backfill-card-dedup.js";
import { resolveDiscordMessageCreatedAtMs } from "./discord-gateway.js";
import { DISCORD_BACKFILL_PARSE_REPLAY_VERSION } from "./discord-backfill-parse-version.js";

export { DISCORD_BACKFILL_PARSE_REPLAY_VERSION } from "./discord-backfill-parse-version.js";

/**
 * @param {Array<Record<string, unknown>>} rows
 * @param {number} fromMs
 * @param {number} toMs
 */
function filterDiscordRowsBySignalTime(rows, fromMs, toMs) {
  const f = Number(fromMs) || 0;
  const t = Number(toMs) || 0;
  if (!f && !t) return rows;
  return rows.filter((row) => {
    const ms = resolveDiscordMessageCreatedAtMs({
      created_at_ms: row.created_at_ms,
      messageId: row.message_id,
      raw_json: row.raw_json,
    });
    if (f > 0 && ms < f) return false;
    if (t > 0 && ms > t) return false;
    return true;
  });
}

/**
 * @param {Record<string, unknown>} card
 */
export function hydrateBackfillCardSignalAt(card) {
  if (!card || typeof card !== "object") return card;
  const existing = String(card.signalAt ?? card.at ?? "").trim();
  if (existing && Number.isFinite(Date.parse(existing))) return card;

  const payload =
    card.cardPayload && typeof card.cardPayload === "object"
      ? /** @type {Record<string, unknown>} */ (card.cardPayload)
      : {};

  const ms = resolveDiscordMessageCreatedAtMs({
    messageId: card.messageId ?? payload.messageId,
    rawMessage: card.rawJson ?? payload.rawJson,
  });
  if (ms <= 0) return card;
  const signalAt = new Date(ms).toISOString();
  return { ...card, signalAt, at: signalAt };
}

/**
 * @param {Array<Record<string, unknown>>} cards
 */
export function hydrateBackfillCardList(cards) {
  return (cards ?? []).map((c) => hydrateBackfillCardSignalAt(c));
}

/**
 * @param {Record<string, unknown>} group
 */
function groupCardsNeedHydration(group) {
  if (Number(group.parseReplayVersion) !== DISCORD_BACKFILL_PARSE_REPLAY_VERSION) return true;
  const cards = Array.isArray(group.cards) ? group.cards : [];
  const items = Array.isArray(group.backtestItems) ? group.backtestItems : [];
  const samples = Array.isArray(group.samples) ? group.samples : [];
  const list = cards.length ? cards : items.length ? items : samples;
  if (!list.length) return true;
  return list.some((c) => {
    const t = String(c?.signalAt ?? c?.at ?? "").trim();
    return !t || !Number.isFinite(Date.parse(t));
  });
}

/**
 * @param {import("./store.js").StoreLike} store
 * @param {Record<string, unknown>} group
 * @param {number} fromMs
 * @param {number} toMs
 */
export async function ensureDiscordBackfillGroupCards(store, group, fromMs, toMs) {
  if (!group || typeof group !== "object") return group;
  const channelId = String(group.channelId ?? "").trim();
  if (!channelId) return group;

  let next = { ...group };

  if (groupCardsNeedHydration(next)) {
    if (typeof store.repairDiscordMessageCreatedAtForChannel === "function") {
      await store.repairDiscordMessageCreatedAtForChannel(channelId);
    }
    let rows = await store.listDiscordMessagesInTimeRange(channelId, fromMs, toMs);
    if (!rows.length && (fromMs > 0 || toMs > 0)) {
      const all = await store.listDiscordMessagesInTimeRange(channelId, 0, 0);
      rows = filterDiscordRowsBySignalTime(all, fromMs, toMs);
    }
    if (rows.length) {
      const replay = await replayDiscordChannelMessages(rows, channelId, {
        maxBacktests: 0,
        channelName: String(group.name ?? channelId),
        store,
        fromMs,
        toMs,
      });
      const prevBacktests = Array.isArray(next.backtestItems) ? next.backtestItems : [];
      next = dedupeBackfillGroupCards({
        ...next,
        ...replay,
        ok: next.ok !== false,
        parseReplayVersion: DISCORD_BACKFILL_PARSE_REPLAY_VERSION,
      });
      if (prevBacktests.length && (!next.backtestItems || !next.backtestItems.length)) {
        next.backtestItems = prevBacktests;
      }
    }
  }

  if (Array.isArray(next.cards) && next.cards.length) {
    next.cards = hydrateBackfillCardList(/** @type {Array<Record<string, unknown>>} */ (next.cards));
  }
  if (Array.isArray(next.backtestItems) && next.backtestItems.length) {
    next.backtestItems = hydrateBackfillCardList(
      /** @type {Array<Record<string, unknown>>} */ (next.backtestItems),
    );
  }
  if (Array.isArray(next.samples) && next.samples.length) {
    next.samples = hydrateBackfillCardList(
      /** @type {Array<Record<string, unknown>>} */ (next.samples),
    );
  }

  return next;
}

/**
 * @param {import("./store.js").StoreLike} store
 * @param {Array<Record<string, unknown>>} groups
 * @param {{ fromMs?: number; toMs?: number }} bounds
 */
export async function ensureDiscordBackfillGroupsCards(store, groups, bounds = {}) {
  const fromMs = Number(bounds.fromMs) || 0;
  const toMs = Number(bounds.toMs) || 0;
  const out = [];
  for (const g of groups) {
    out.push(await ensureDiscordBackfillGroupCards(store, g, fromMs, toMs));
  }
  return out;
}
