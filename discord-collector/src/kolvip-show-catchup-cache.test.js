import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  compareDiscordSnowflake,
  isChannelShowHistoryFresh,
  minDiscordSnowflakeId,
} from "./discord-show-history-cache.js";
import { shouldSkipKolvipShowTailCatchup } from "./kolvip-show-catchup-cache.js";

describe("discord-show-history-cache", () => {
  it("compareDiscordSnowflake 按数值比较", () => {
    assert.equal(compareDiscordSnowflake("100", "200"), -1);
    assert.equal(compareDiscordSnowflake("9223372036854775807", "9223372036854775808"), -1);
  });

  it("minDiscordSnowflakeId 取更旧 id", () => {
    assert.equal(minDiscordSnowflakeId("100", "50"), "50");
    assert.equal(minDiscordSnowflakeId("", "50"), "50");
  });

  it("isChannelShowHistoryFresh：无 before 时仅看 warmed_at", () => {
    const now = Date.now();
    assert.equal(isChannelShowHistoryFresh({ warmedAtMs: now - 1000 }, { ttlMs: 60_000 }), true);
    assert.equal(isChannelShowHistoryFresh({ warmedAtMs: now - 120_000 }, { ttlMs: 60_000 }), false);
  });

  it("isChannelShowHistoryFresh：有 before 时需 oldest 已覆盖", () => {
    const now = Date.now();
    const cache = { warmedAtMs: now - 1000, oldestMessageId: "1000" };
    assert.equal(
      isChannelShowHistoryFresh(cache, { ttlMs: 60_000, beforeMessageId: "2000" }),
      true
    );
    assert.equal(
      isChannelShowHistoryFresh(cache, { ttlMs: 60_000, beforeMessageId: "500" }),
      false
    );
  });
});

describe("shouldSkipKolvipShowTailCatchup", () => {
  const store = {
    async getDiscordChannelShowHistoryCache() {
      return {
        warmedAtMs: Date.now() - 60_000,
        oldestMessageId: "1000",
      };
    },
  };

  it("live 尾拉不因 30 天预热缓存跳过", async () => {
    assert.equal(
      await shouldSkipKolvipShowTailCatchup(store, "kolvip-scan-31", {}),
      false
    );
  });

  it("force 时不跳过", async () => {
    assert.equal(
      await shouldSkipKolvipShowTailCatchup(store, "kolvip-scan-31", {
        force: true,
        beforeMessageId: "kolvip-31-100",
      }),
      false
    );
  });

  it("beforeId>0 时不跳过", async () => {
    assert.equal(
      await shouldSkipKolvipShowTailCatchup(store, "kolvip-scan-31", { beforeId: 99 }),
      false
    );
  });

  it("beforeMessageId 已覆盖且在 TTL 内可跳过", async () => {
    assert.equal(
      await shouldSkipKolvipShowTailCatchup(store, "kolvip-scan-31", {
        beforeMessageId: "2000",
      }),
      true
    );
    assert.equal(
      await shouldSkipKolvipShowTailCatchup(store, "kolvip-scan-31", {
        beforeMessageId: "500",
      }),
      false
    );
  });
});