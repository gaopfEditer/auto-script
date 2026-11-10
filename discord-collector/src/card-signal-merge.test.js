import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { findMergeTargetCard, buildSignalCardMergePatch } from "./card-signal-merge.js";

describe("findMergeTargetCard placeholder", () => {
  it("补全币种后合并到待补充卡并保留止损", async () => {
    const now = Date.now();
    const placeholder = {
      id: 9,
      symbol: "",
      author_key: "alice",
      signal_at: new Date(now).toISOString(),
      status: "active",
      outcome: "pending",
      parsed_json: JSON.stringify({
        symbol: "待补充",
        direction: "long",
        stopLoss: "0.0394",
        takeProfits: ["0.04258"],
        authorKey: "alice",
      }),
    };
    const store = {
      listRecentSignalCardsBySymbolChannel: async () => [],
      listRecentSignalCardsByChannel: async () => [placeholder],
    };
    const hit = await findMergeTargetCard(store, {
      channelId: "ch",
      symbol: "RUNE",
      authorKey: "alice",
      direction: "long",
      signalAtMs: now,
    });
    assert.equal(hit?.id, 9);
    const patch = buildSignalCardMergePatch({
      prevRow: hit,
      authorKey: "alice",
      parsedJson: { symbol: "RUNE", direction: "long", entry: "0.041" },
    });
    assert.match(String(patch.symbol), /RUNE/);
    assert.equal(patch.parsedJson.stopLoss, "0.0394");
  });
});
