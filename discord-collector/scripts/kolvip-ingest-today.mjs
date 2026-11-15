#!/usr/bin/env node
/**
 * 巨鲸单频道：仅北京时间「今天」拉 API → Show 消息 + 信号卡（不清算）。
 *
 *   node scripts/kolvip-ingest-today.mjs           # 默认胖猫 ch=16
 *   node scripts/kolvip-ingest-today.mjs 16
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
import { shanghaiCalendarDayStartMs } from "../src/discord-backfill-engine.js";
import { getKolvipMappingByKolvipId } from "../src/kolvip-cdp-config.js";

const kid = String(process.argv[2] ?? "16").trim();
const log = createLogger("kolvip-today");
const fromMs = shanghaiCalendarDayStartMs();
const toMs = Date.now();

const mapping = getKolvipMappingByKolvipId(kid);
if (!mapping) {
  console.error(`未找到巨鲸频道映射 kolvipChannelId=${kid}`);
  process.exit(1);
}

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
const result = await pullAndIngestKolvipChannel({
  store,
  signalCards,
  client,
  group: {
    channelId: kid,
    name: mapping.logicName,
    curated: true,
    discordChannelId: mapping.discordChannelId,
  },
  fromMs,
  toMs,
  onProgress: (p) => {
    if (p.phase) {
      log.info(
        `[${mapping.logicName}] ${p.phase} pages=${p.pagesDone ?? "-"} batch=${p.messageTotal ?? "-"}`,
      );
    }
  },
});

const summary = {
  ok: result.ok !== false,
  kolvipChannelId: kid,
  name: mapping.logicName,
  discordChannelId: mapping.discordChannelId,
  from: new Date(fromMs).toISOString(),
  to: new Date(toMs).toISOString(),
  pages: result.scrollPages,
  messages: result.messageCount,
  cardsCreated: result.cardsCreated,
  cardEmitCount: result.cardEmitCount ?? result.parsedSignalCount,
  error: result.error ?? null,
};
console.log(JSON.stringify(summary, null, 2));
try {
  await store.close?.();
} catch {
  /* ignore */
}
cardSink.stop?.();
process.exit(summary.ok && !summary.error ? 0 : 1);