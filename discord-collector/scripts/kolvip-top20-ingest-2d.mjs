#!/usr/bin/env node
/**
 * 胜率榜前 20 · 近 N 天巨鲸 API → Show 消息 + 信号卡（供 /cards、/eval）。
 *
 *   node scripts/kolvip-top20-ingest-2d.mjs
 *   node scripts/kolvip-top20-ingest-2d.mjs --days=30
 */
import "../src/load-env.js";
import { config } from "../src/config.js";
import { openStore } from "../src/store.js";
import { createLogger } from "../src/logger.js";
import { createDiscordSignalCardService } from "../src/discord-signal-card-service.js";
import { createCardExternalSink } from "../src/card-external-sink.js";
import { createCommunityFeedService } from "../src/community-feed-service.js";
import { buildKolvipApiClient } from "../src/kolvip-api-fetch.js";
import { pullAndIngestKolvipChannel } from "../src/kolvip-backfill-manual-engine.js";
import { getKolvipMappingByKolvipId } from "../src/kolvip-cdp-config.js";
import { getKolvipEvalRankedChannelIds } from "../src/kolvip-eval-channels.js";
import { resolveKolvipChannelIdForShow } from "../src/kolvip-channel-catchup.js";

const daysArg = process.argv.find((a) => a.startsWith("--days="));
const defaultDays = config.kolvipCardIngestDays ?? 30;
const DAYS = Math.min(90, Math.max(1, Number(daysArg?.split("=")[1] ?? defaultDays) || defaultDays));
const toMs = Date.now();
const fromMs = toMs - DAYS * 86_400_000;

const log = createLogger("kolvip-top20-2d");
const store = await openStore(config.mysql, log);
const broadcast = () => {};
const cardSink = createCardExternalSink(log);
cardSink.start();
const communityFeed = createCommunityFeedService(store, log, broadcast);
const signalCards = createDiscordSignalCardService(store, log, broadcast, {
  communityFeed,
  cardSink,
});
const { client } = await buildKolvipApiClient(log);

const ranked = getKolvipEvalRankedChannelIds();
const names = config.discordShowSidebar?.namesByChannelId ?? {};

/** @type {Record<string, unknown>[]} */
const results = [];

for (let i = 0; i < ranked.length; i++) {
  const showId = ranked[i];
  const label = names[showId] || showId;
  const kid = resolveKolvipChannelIdForShow(showId);
  if (!kid) {
    console.log(`[${i + 1}/${ranked.length}] ${label} · skip 无 kolvip id`);
    results.push({ showId, ok: false, error: "no_kolvip_id" });
    continue;
  }
  const mapping = getKolvipMappingByKolvipId(kid);
  process.stdout.write(`[${i + 1}/${ranked.length}] ${label} (ch=${kid}) … `);
  try {
    const result = await pullAndIngestKolvipChannel({
      store,
      signalCards,
      client,
      fromMs,
      toMs,
      group: {
        channelId: kid,
        name: label,
        curated: Boolean(mapping),
        discordChannelId: showId,
      },
    });
    const summary = {
      showId,
      kolvipChannelId: kid,
      name: label,
      ok: result.ok !== false,
      pages: result.scrollPages,
      messages: result.messageCount,
      cardsCreated: result.cardsCreated,
      error: result.error ?? null,
    };
    results.push(summary);
    console.log(
      summary.ok
        ? `pages=${summary.pages} msg=${summary.messages} cards+${summary.cardsCreated}`
        : `ERR ${summary.error}`,
    );
    await new Promise((r) => setTimeout(r, Math.max(400, Number(config.kolvipApiChannelDelayMs) || 800)));
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message ?? e);
    console.log(`ERR ${msg}`);
    results.push({ showId, kolvipChannelId: kid, ok: false, error: msg });
  }
}

const ok = results.filter((r) => r.ok !== false).length;
const cards = results.reduce((n, r) => n + (Number(r.cardsCreated) || 0), 0);
console.log(JSON.stringify({ days: DAYS, from: new Date(fromMs).toISOString(), ok, total: ranked.length, cardsCreated: cards }, null, 2));

try {
  await store.close?.();
} catch {
  /* ignore */
}
cardSink.stop?.();
process.exit(ok >= Math.min(5, ranked.length) ? 0 : 1);