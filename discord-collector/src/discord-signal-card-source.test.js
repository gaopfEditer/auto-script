import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  legacySignalSourceNeedsKolvipUpgrade,
  upgradeKolvipSignalCardSourceFromRow,
} from "./discord-signal-card-source.js";
import { kolvipMessageToDiscordRow } from "./kolvip-cdp-message.js";
import { DEFAULT_KOLVIP_CHANNEL_MAPPINGS } from "./kolvip-cdp-config.js";

describe("legacySignalSourceNeedsKolvipUpgrade", () => {
  it("auto → kolvip_api_backfill", () => {
    assert.equal(legacySignalSourceNeedsKolvipUpgrade("auto", "kolvip_api_backfill"), true);
  });

  it("已是目标 source 不升级", () => {
    assert.equal(legacySignalSourceNeedsKolvipUpgrade("kolvip_api_backfill", "kolvip_api_backfill"), false);
  });

  it("kolvip_api → kolvip_api_backfill", () => {
    assert.equal(legacySignalSourceNeedsKolvipUpgrade("kolvip_api", "kolvip_api_backfill"), true);
  });
});

describe("upgradeKolvipSignalCardSourceFromRow", () => {
  it("正文去重场景：升级已有 message_id 卡的 source", async () => {
    const map = DEFAULT_KOLVIP_CHANNEL_MAPPINGS[0];
    const row = kolvipMessageToDiscordRow(
      { dataId: "42", text: "BTC", author: "", timeText: "", timeTitle: "", imageUrl: "" },
      {
        kolvipChannelId: map.kolvipChannelId,
        discordChannelId: map.discordChannelId,
        source: "kolvip_api_backfill",
      }
    );
    const messageId = String(row.messageId);
    /** @type {Record<string, unknown>} */
    let saved = {
      id: 7,
      message_id: messageId,
      channel_id: map.discordChannelId,
      source: "auto",
      source_type: "discord",
      source_ref: map.discordChannelId,
    };
    const store = {
      async getSignalCardByMessageId(mid) {
        return mid === messageId ? { ...saved } : null;
      },
      async updateSignalCard(id, patch) {
        assert.equal(id, 7);
        saved = { ...saved, ...patch, source_type: patch.sourceType, source_ref: patch.sourceRef };
        return saved;
      },
      async getSignalCardById(id) {
        return id === 7 ? { ...saved } : null;
      },
    };
    const up = await upgradeKolvipSignalCardSourceFromRow(store, row, null);
    assert.equal(up.upgraded, true);
    assert.equal(saved.source, "kolvip_api_backfill");
    assert.equal(saved.source_type, "kolvip");
    assert.equal(saved.source_ref, map.kolvipChannelId);
  });

  it("非巨鲸 source 不处理", async () => {
    const row = { messageId: "x", channelId: "1", source: "auto", content: "a" };
    const store = {
      async getSignalCardByMessageId() {
        return { id: 1, source: "auto" };
      },
      async updateSignalCard() {
        throw new Error("should not update");
      },
    };
    const up = await upgradeKolvipSignalCardSourceFromRow(store, row, null);
    assert.equal(up.upgraded, false);
  });
});
