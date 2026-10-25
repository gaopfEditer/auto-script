/**
 * Discord 回溯缓存：对已有卡片 batch 盈亏（与 Telegram enrich 同路径）。
 */
import fs from "node:fs";
import path from "node:path";
import { backtestBackfillGroupUnified } from "./backfill-batch-eval.js";
import { dedupeBackfillGroupCards } from "./backfill-card-dedup.js";
import { hydrateBackfillCardList } from "./discord-backfill-hydrate.js";
import { summarizeBacktestItems } from "./telegram-backfill-market-entry.js";

/**
 * @param {Record<string, unknown>} group
 * @returns {Array<Record<string, unknown>>}
 */
function cardsForDiscordGroup(group) {
  if (Array.isArray(group.cards) && group.cards.length) {
    return hydrateBackfillCardList(/** @type {Array<Record<string, unknown>>} */ (group.cards));
  }
  if (Array.isArray(group.backtestItems) && group.backtestItems.length) {
    return hydrateBackfillCardList(
      group.backtestItems.map((item) => {
        const row = /** @type {Record<string, unknown>} */ ({ ...item });
        if (!row.signalAt && row.at) row.signalAt = row.at;
        if (!row.phase) row.phase = "full";
        return row;
      }),
    );
  }
  if (Array.isArray(group.samples) && group.samples.length) {
    return hydrateBackfillCardList(/** @type {Array<Record<string, unknown>>} */ (group.samples));
  }
  return [];
}

/**
 * @param {string} filePath
 * @param {{
 *   maxBacktestsPerGroup?: number;
 *   skipBacktestCache?: boolean;
 *   backtestCacheRoot?: string;
 *   onGroupDone?: (info: { groupIndex: number; groupTotal: number; groupName: string }) => void;
 * }} [opts]
 */
export async function enrichDiscordBackfillFile(filePath, opts = {}) {
  const raw = fs.readFileSync(filePath, "utf8");
  const data = JSON.parse(raw);
  const groups = Array.isArray(data.groups) ? data.groups : [];
  const maxPer = Math.max(0, Number(opts.maxBacktestsPerGroup) || 120);
  const cacheRoot =
    opts.backtestCacheRoot ?? path.join(path.dirname(filePath), "backtest");

  /** @type {Array<Record<string, unknown>>} */
  const out = [];
  for (let i = 0; i < groups.length; i++) {
    const g = /** @type {Record<string, unknown>} */ (groups[i]);
    opts.onGroupDone?.({
      groupIndex: i + 1,
      groupTotal: groups.length,
      groupName: String(g.name ?? g.channelId ?? ""),
    });
    if (g.ok === false && g.error) {
      out.push(g);
      continue;
    }
    const cards = cardsForDiscordGroup(g);
    if (!cards.length) {
      out.push(g);
      continue;
    }
    const source = {
      ...g,
      channelId: g.channelId,
      cards,
    };
    let row = await backtestBackfillGroupUnified(source, {
      maxBacktests: maxPer,
      sourceType: "discord",
      skipBacktestCache: Boolean(opts.skipBacktestCache),
      backtestCacheRoot: cacheRoot,
    });
    row = dedupeBackfillGroupCards(row);
    row = {
      ...row,
      ...summarizeBacktestItems(
        /** @type {Array<Record<string, unknown>>} */ (row.backtestItems ?? []),
      ),
    };
    out.push(row);
  }

  const ranking = [...out].sort(
    (a, b) =>
      Number(b.cardEmitCount ?? b.parsedSignalCount ?? 0) -
        Number(a.cardEmitCount ?? a.parsedSignalCount ?? 0) ||
      Number(b.tradeLikeCount ?? 0) - Number(a.tradeLikeCount ?? 0),
  );

  const payload = {
    ...data,
    groups: out,
    ranking,
    backtestEnrichedAt: new Date().toISOString(),
  };
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}
