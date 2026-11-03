import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { KOLVIP_SIGNAL_CARD_SOURCES } from "./discord-signal-card-source.js";
import { getKolvipMappingByKolvipId, isKolvipSignalEnabled } from "./kolvip-cdp-config.js";
import { ingestKolvipMessageBatch } from "./kolvip-ingest.js";
import {
  buildKolvipShowIsolationPayload,
  discordMessageSoftDeleteFields,
  isDiscordSnowflakeMessageId,
  isKolvipMessageSource,
  isolateShowChannelMessages,
  kolvipShowMessageVisibilityWhere,
  messageVisibleForShow,
  partitionDiscordMessageUpserts,
  shouldIndexDiscordChannelRow,
  KOLVIP_DISCORD_SOFT_DELETE_REASON,
} from "./kolvip-show-messages.js";

const SOURCES = KOLVIP_SIGNAL_CARD_SOURCES;
const MAPPED = ["1444963929393729686", "1562351038277619783"];

/** @param {boolean} enabled */
function policy(enabled) {
  return { enabled, mappedChannelIds: MAPPED, kolvipSources: SOURCES };
}

describe("kolvip Show source", () => {
  it("kolvip_ 前缀与 KOLVIP_SIGNAL_CARD_SOURCES 都算巨鲸消息", () => {
    for (const src of SOURCES) {
      assert.equal(isKolvipMessageSource(src, SOURCES), true, src);
      assert.equal(src.startsWith("kolvip_"), true, src);
    }
    assert.equal(isKolvipMessageSource("gateway_ws", SOURCES), false);
    assert.equal(isKolvipMessageSource("rest_api", SOURCES), false);
    assert.equal(isKolvipMessageSource("auto", SOURCES), false);
  });

  it("开：映射频道只留 kolvip；关：隐藏全部 kolvip 行", () => {
    const ch = MAPPED[0];
    assert.equal(messageVisibleForShow(ch, "kolvip_api", policy(true)), true);
    assert.equal(messageVisibleForShow(ch, "kolvip_api_backfill", policy(true)), true);
    assert.equal(messageVisibleForShow(ch, "gateway_ws", policy(true)), false);
    assert.equal(messageVisibleForShow(ch, "rest_api", policy(true)), false);
    assert.equal(messageVisibleForShow("999", "gateway_ws", policy(true)), true);
    assert.equal(messageVisibleForShow("kolvip-scan-99", "kolvip_api_scan", policy(true)), true);

    assert.equal(messageVisibleForShow(ch, "kolvip_api", policy(false)), false);
    assert.equal(messageVisibleForShow(ch, "kolvip_api_scan", policy(false)), false);
    assert.equal(messageVisibleForShow(ch, "gateway_ws", policy(false)), true);
    assert.equal(messageVisibleForShow("kolvip-scan-99", "kolvip_api_scan", policy(false)), false);
  });

  it("查询片段：开则映射频道 OR kolvip，关则 NOT kolvip", () => {
    const on = kolvipShowMessageVisibilityWhere(policy(true));
    assert.match(on.sql, /channel_id NOT IN/);
    assert.match(on.sql, /kolvip_%/);
    assert.ok(on.params.includes(MAPPED[0]));
    assert.ok(on.params.includes("kolvip_api_backfill"));

    const off = kolvipShowMessageVisibilityWhere(policy(false));
    assert.match(off.sql, /^NOT /);
    assert.equal(off.params.includes(MAPPED[0]), false);
    assert.ok(off.params.includes("kolvip_cdp"));
  });

  it("前端缓存按 isolation 丢掉另一源", () => {
    const rows = [
      { messageId: "1", source: "gateway_ws" },
      { messageId: "k", source: "kolvip_api" },
    ];
    const only = isolateShowChannelMessages(MAPPED[0], rows, buildKolvipShowIsolationPayload(policy(true)));
    assert.deepEqual(only.map((r) => r.messageId), ["k"]);
    const hide = isolateShowChannelMessages(MAPPED[0], rows, buildKolvipShowIsolationPayload(policy(false)));
    assert.deepEqual(hide.map((r) => r.messageId), ["1"]);
    const other = isolateShowChannelMessages("999", rows, buildKolvipShowIsolationPayload(policy(true)));
    assert.equal(other.length, 2);
  });
});

describe("Discord 刷新不覆盖 kolvip 行", () => {
  it("同 messageId 的 Discord 行被跳过，其它 id 仍 upsert", () => {
    const existing = new Map([
      ["kolvip-10-1", "kolvip_api"],
      ["100", "gateway_ws"],
    ]);
    const { keep, preservedKolvip } = partitionDiscordMessageUpserts(
      existing,
      [
        { messageId: "kolvip-10-1", source: "rest_api", content: "discord" },
        { messageId: "100", source: "rest_api", content: "refresh" },
        { messageId: "kolvip-10-2", source: "kolvip_api_backfill", content: "new" },
      ],
      SOURCES
    );
    assert.deepEqual(preservedKolvip, ["kolvip-10-1"]);
    assert.deepEqual(
      keep.map((r) => r.messageId),
      ["100", "kolvip-10-2"]
    );
  });

  it("非雪花 messageId 不走 CAST 游标", () => {
    assert.equal(isDiscordSnowflakeMessageId("1444963929393729686"), true);
    assert.equal(isDiscordSnowflakeMessageId("kolvip-10-55"), false);
  });
});

describe("软删与侧栏", () => {
  it("巨鲸开时只软删映射频道上的 Discord 原文", () => {
    const on = discordMessageSoftDeleteFields(MAPPED[0], "gateway_ws", policy(true), "2026-11-03T00:00:00.000Z");
    assert.equal(on.deletedReason, KOLVIP_DISCORD_SOFT_DELETE_REASON);
    assert.equal(on.deletedAt, "2026-11-03T00:00:00.000Z");
    const kolvip = discordMessageSoftDeleteFields(MAPPED[0], "kolvip_api", policy(true), "2026-11-03T00:00:00.000Z");
    assert.equal(kolvip.deletedAt, null);
    const off = discordMessageSoftDeleteFields(MAPPED[0], "rest_api", policy(false), "2026-11-03T00:00:00.000Z");
    assert.equal(off.deletedAt, null);
    const other = discordMessageSoftDeleteFields("999", "gateway_ws", policy(true), "2026-11-03T00:00:00.000Z");
    assert.equal(other.deletedAt, null);
  });

  it("备选虚拟频道不进 Discord 侧栏索引", () => {
    assert.equal(
      shouldIndexDiscordChannelRow(
        { channelId: "kolvip-scan-99", source: "kolvip_api_scan" },
        policy(true)
      ),
      false
    );
    assert.equal(
      shouldIndexDiscordChannelRow({ channelId: MAPPED[0], source: "gateway_ws" }, policy(true)),
      false
    );
    assert.equal(
      shouldIndexDiscordChannelRow({ channelId: MAPPED[0], source: "kolvip_api" }, policy(true)),
      true
    );
    assert.equal(
      shouldIndexDiscordChannelRow({ channelId: MAPPED[0], source: "kolvip_api" }, policy(false)),
      false
    );
  });
});

describe("ingestKolvipMessageBatch 写入 Show 消息表", () => {
  const log = { info() {}, debug() {}, warn() {} };

  /**
   * @param {{ onMessage?: () => Promise<unknown> }} [hooks]
   */
  function fakeStore(hooks = {}) {
    /** @type {Record<string, unknown>[][]} */
    const batches = [];
    let onMessageCalls = 0;
    return {
      batches,
      onMessageCalls: () => onMessageCalls,
      store: {
        insertDiscordMessagesBatch: async (rows) => {
          batches.push(rows);
          return { inserted: rows.length, duplicate: 0, insertedRows: rows };
        },
        getSignalCardByMessageId: async () => null,
      },
      signalCards: {
        ensureHydrated: async () => {},
        dedup: {
          isDuplicate: () => false,
          remember: async () => {},
        },
        onMessage: async () => {
          onMessageCalls += 1;
          if (hooks.onMessage) return hooks.onMessage();
          return { skipped: "parse_failed" };
        },
      },
    };
  }

  /** @param {string} dataId @param {string} text */
  function msg(dataId, text) {
    return {
      dataId,
      text,
      author: "峰哥",
      timeText: "",
      timeTitle: "2026-11-01T00:00:00.000Z",
      imageUrl: "",
    };
  }

  it("精选回溯 upsert kolvip-{ch}-{dataId} 到映射 Discord 频道", async () => {
    const map = getKolvipMappingByKolvipId("10");
    assert.ok(map);
    const fake = fakeStore();
    const out = await ingestKolvipMessageBatch({
      kolvipChannelId: "10",
      channelName: map.logicName,
      messages: [msg("55", "BTC 多")],
      mode: "backfill",
      curated: true,
      signalCards: fake.signalCards,
      store: fake.store,
      log,
    });
    assert.equal(out.discordChannelId, map.discordChannelId);
    assert.equal(out.source, "kolvip_api_backfill");
    assert.equal(out.messagesUpserted, 1);
    assert.equal(fake.batches.length, 1);
    assert.equal(fake.batches[0][0].messageId, "kolvip-10-55");
    assert.equal(fake.batches[0][0].channelId, map.discordChannelId);
    assert.equal(fake.batches[0][0].source, "kolvip_api_backfill");
    assert.equal(fake.onMessageCalls(), 1);
  });

  it("未映射备选保持 kolvip-scan 虚拟频道", async () => {
    const fake = fakeStore();
    const out = await ingestKolvipMessageBatch({
      kolvipChannelId: "99",
      channelName: "备选",
      messages: [msg("7", "只扫描")],
      mode: "backfill",
      curated: true,
      signalCards: fake.signalCards,
      store: fake.store,
      log,
    });
    assert.equal(out.discordChannelId, "kolvip-scan-99");
    assert.equal(out.source, "kolvip_api_scan");
    assert.equal(fake.batches[0][0].channelId, "kolvip-scan-99");
    assert.equal(fake.batches[0][0].messageId, "kolvip-99-7");
    assert.equal(fake.batches[0][0].guildId, "");
    assert.equal(fake.onMessageCalls(), 1);
  });

  it("live 首次记档只 upsert 消息、不建卡；之后只 upsert 新 dataId", async () => {
    const map = getKolvipMappingByKolvipId("10");
    assert.ok(map);
    const fake = fakeStore();
    /** @type {Record<string, unknown>} */
    const seen = {};
    const seeded = await ingestKolvipMessageBatch({
      kolvipChannelId: "10",
      channelName: map.logicName,
      messages: [msg("1", "历史"), msg("2", "历史2")],
      mode: "live",
      curated: true,
      seen,
      signalCards: fake.signalCards,
      store: fake.store,
      log,
    });
    assert.equal(seeded.seeded, true);
    assert.equal(seeded.rowsQueued, 0);
    assert.equal(seeded.messagesUpserted, 2);
    assert.equal(fake.onMessageCalls(), 0);
    assert.equal(fake.batches[0][0].source, "kolvip_api");
    assert.equal(fake.batches[0][0].channelId, map.discordChannelId);
    assert.equal(fake.batches[0][1].messageId, "kolvip-10-2");

    const pushed = [];
    const next = await ingestKolvipMessageBatch({
      kolvipChannelId: "10",
      channelName: map.logicName,
      messages: [msg("2", "历史2"), msg("3", "新")],
      mode: "live",
      curated: true,
      seen,
      signalCards: fake.signalCards,
      store: fake.store,
      log,
      broadcast(channel, payload) {
        pushed.push({ channel, payload });
      },
    });
    assert.equal(next.seeded, false);
    assert.equal(next.messagesUpserted, 1);
    assert.equal(fake.batches[1][0].messageId, "kolvip-10-3");
    assert.equal(fake.onMessageCalls(), 1);
    if (isKolvipSignalEnabled()) {
      assert.equal(pushed.length, 1);
      assert.equal(pushed[0].channel, "message");
      assert.equal(pushed[0].payload.kind, "discord_message_batch");
      assert.equal(pushed[0].payload.rows[0].messageId, "kolvip-10-3");
      assert.equal(pushed[0].payload.rows[0].source, "kolvip_api");
    } else {
      assert.equal(pushed.length, 0);
    }
  });
});
