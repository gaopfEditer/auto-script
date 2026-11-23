import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveCardSourcePostUrl } from "./card-source-post-url.js";

describe("resolveCardSourcePostUrl", () => {
  it("note 中的币安广场链接", () => {
    const url = resolveCardSourcePostUrl({
      sourceType: "binance",
      note: "发帖时间=2026-01-01 · https://www.binance.com/zh-CN/square/post/391272392326218 · 方向=多",
    });
    assert.equal(url, "https://www.binance.com/zh-CN/square/post/391272392326218");
  });

  it("binance messageId + sourceRef", () => {
    const url = resolveCardSourcePostUrl({
      sourceType: "binance",
      messageId: "binance-9001",
      sourceRef: "9001",
    });
    assert.equal(url, "https://www.binance.com/zh-CN/square/post/9001");
  });

  it("telegram sourceRef tg:chat:msg", () => {
    const url = resolveCardSourcePostUrl({
      sourceType: "telegram",
      channelId: "-1001766481463",
      sourceRef: "tg:-1001766481463:4242",
    });
    assert.equal(url, "https://t.me/c/1766481463/4242");
  });

  it("x tweet id", () => {
    const url = resolveCardSourcePostUrl({
      sourceType: "x",
      messageId: "x-1234567890",
      parsedJson: { userHandle: "trader" },
    });
    assert.equal(url, "https://x.com/trader/status/1234567890");
  });
});