#!/usr/bin/env node
/**
 * 补推胜率榜前 10 频道卡片到 KOLVIP_TOP10_TELEGRAM_CHAT_ID（含 kolvip-scan-*）。
 *
 *   node scripts/kolvip-top10-mirror-catchup.mjs
 *   node scripts/kolvip-top10-mirror-catchup.mjs --dry-run
 */
import "../src/load-env.js";
import { config } from "../src/config.js";
import { openStore } from "../src/store.js";
import { createLogger } from "../src/logger.js";
import { signalCardToClient } from "../src/discord-signal-card-service.js";
import { pickCardSinkText } from "../src/card-external-sink.js";
import { shanghaiCalendarDayStartMs } from "../src/discord-backfill-engine.js";
import { isKolvipTop10TelegramCardChannel } from "../src/discord-telegram-push-config.js";
import {
  createKolvipTop10CardTelegramPush,
  sendKolvipTop10CardMirrorOnly,
} from "../src/kolvip-top10-telegram.js";

const dryRun = process.argv.includes("--dry-run");
const fromMs = shanghaiCalendarDayStartMs();
const log = createLogger("kolvip-top10-mirror");

if (!config.kolvipTop10TelegramChatId) {
  console.error("未配置 KOLVIP_TOP10_TELEGRAM_CHAT_ID");
  process.exit(1);
}

const store = await openStore(config.mysql, log);
const sender = createKolvipTop10CardTelegramPush(log);
if (!sender?.enabled && !dryRun) {
  console.error("top10 镜像 TG 未启用（检查 bot token / TELEGRAM_SEND_URL）");
  process.exit(1);
}

const rows = await store.listSignalCards({ fromMs, limit: 500, status: "active" });
let eligible = 0;
let sent = 0;
let skipped = 0;

for (const row of rows) {
  const client = signalCardToClient(row);
  const channelId = String(client.channelId ?? "").trim();
  if (!isKolvipTop10TelegramCardChannel(channelId)) continue;
  if (client.telegramSentAt) {
    skipped += 1;
    continue;
  }
  const src = String(client.source ?? "").trim();
  if (src === "kolvip_api_backfill" || src.includes("backfill")) {
    skipped += 1;
    continue;
  }
  const sigMs = new Date(String(client.signalAt ?? "")).getTime();
  if (!Number.isFinite(sigMs) || sigMs < fromMs) {
    skipped += 1;
    continue;
  }
  eligible += 1;
  const text = pickCardSinkText(client) || String(client.cardsByStyle?.cn_brief ?? "");
  if (!String(text).trim()) {
    skipped += 1;
    continue;
  }
  if (dryRun) {
    console.log(`[dry-run] #${client.id} channel=${channelId} symbol=${client.symbol ?? "-"}`);
    continue;
  }
  const r = await sendKolvipTop10CardMirrorOnly(log, sender, {
    text,
    channelId,
    channelName: client.channelName,
    cardId: client.id,
    messageId: client.messageId,
    symbol: client.symbol,
  });
  if (r?.ok) sent += 1;
  else skipped += 1;
}

const summary = {
  chatId: config.kolvipTop10TelegramChatId,
  from: new Date(fromMs).toISOString(),
  scanned: rows.length,
  eligible,
  sent,
  skipped,
  dryRun,
};
console.log(JSON.stringify(summary, null, 2));
try {
  await store.close?.();
} catch {
  /* ignore */
}