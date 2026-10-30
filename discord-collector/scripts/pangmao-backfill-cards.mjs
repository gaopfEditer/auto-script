/**
 * 一次性：胖猫社区历史消息 → 信号卡（跳过 Telegram / 交易平台）。
 * node scripts/pangmao-backfill-cards.mjs
 */
import "dotenv/config";
import { openStore } from "../src/store.js";
import { createDiscordSignalCardService } from "../src/discord-signal-card-service.js";
import { isSignalChannel, getSignalChannelConfig } from "../src/discord-signal-config.js";
import { normalizeSignalText } from "../src/discord-signal-dedup.js";

const CHANNEL = "1562351038277619783";
const log = {
  info: (...a) => console.log("[info]", ...a),
  warn: (...a) => console.warn("[warn]", ...a),
  debug: () => {},
  error: (...a) => console.error("[err]", ...a),
};

async function loadAllMessages(store) {
  const all = [];
  let before = "";
  for (let i = 0; i < 20; i += 1) {
    const batch = await store.listRecentMessages(500, {
      channelId: CHANNEL,
      order: "desc",
      ...(before ? { beforeMessageId: before } : {}),
    });
    if (!batch.length) break;
    all.push(...batch);
    before = String(batch[batch.length - 1].message_id ?? "");
    if (batch.length < 500) break;
  }
  return all;
}

async function main() {
  console.log("isSignal", isSignalChannel(CHANNEL), getSignalChannelConfig(CHANNEL)?.name);
  const store = await openStore();
  const signalCards = createDiscordSignalCardService(store, log, null, {});
  await signalCards.ensureHydrated();
  const rows = await loadAllMessages(store);
  console.log("messages loaded", rows.length);
  const ordered = [...rows].sort(
    (a, b) => Number(a.created_at_ms ?? 0) - Number(b.created_at_ms ?? 0)
  );
  const stats = { ok: 0, merged: 0, skipped: {} };
  for (const r of ordered) {
    const content = normalizeSignalText(String(r.content ?? ""));
    if (!content) {
      stats.skipped.empty = (stats.skipped.empty ?? 0) + 1;
      continue;
    }
    const row = {
      channelId: CHANNEL,
      messageId: String(r.message_id ?? ""),
      content,
      guildId: String(r.guild_id ?? ""),
      createdAtMs: Number(r.created_at_ms ?? 0),
      receivedAt: r.received_at,
    };
    try {
      const res = await signalCards.onMessage(row, {
        skipDedup: true,
        skipTelegram: true,
        debugSimulate: true,
      });
      if (res?.merged) stats.merged += 1;
      else if (res?.card) stats.ok += 1;
      else {
        const k = String(res?.skipped ?? "unknown");
        stats.skipped[k] = (stats.skipped[k] ?? 0) + 1;
      }
    } catch (e) {
      stats.skipped.error = (stats.skipped.error ?? 0) + 1;
      log.warn(String(e?.message ?? e));
    }
  }
  const cards = await store.listSignalCards({ channelId: CHANNEL, limit: 50 });
  console.log(JSON.stringify({
    stats,
    cardsNow: cards.length,
    sample: cards.slice(0, 8).map((c) => ({
      id: c.id ?? c.ID,
      symbol: c.symbol,
      preview: String(c.raw_content ?? c.rawContent ?? "").slice(0, 60),
    })),
  }, null, 2));
  await store.close?.();
}

main().catch((e) => { console.error(e); process.exit(1); });
