import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  kolvipStableMessageId,
  kolvipMessageToDiscordRow,
  parseKolvipMessageTimeMs,
} from "./kolvip-cdp-message.js";
import { parseCdpConnectHostPort } from "./kolvip-cdp-connect.js";
import {
  DEFAULT_KOLVIP_CHANNEL_MAPPINGS,
  parseKolvipChannelIdsEnv,
  getKolvipMappedDiscordChannelIds,
} from "./kolvip-cdp-config.js";

describe("kolvip message id 与 Discord 行", () => {
  it("data-id 稳定 messageId", () => {
    assert.equal(kolvipStableMessageId("16", "abc123"), "kolvip-16-abc123");
  });

  it("正文与图片 attachment 进 rawJson", () => {
    const map = DEFAULT_KOLVIP_CHANNEL_MAPPINGS.find((m) => m.kolvipChannelId === "16");
    assert.ok(map);
    const row = kolvipMessageToDiscordRow(
      {
        dataId: "99",
        text: "BTC 做多 95000",
        author: "胖猫",
        timeText: "12:00",
        timeTitle: "2026-11-02 12:00:00",
        imageUrl: "https://cdn.example/img.jpg",
      },
      { kolvipChannelId: map.kolvipChannelId, discordChannelId: map.discordChannelId }
    );
    assert.equal(row.channelId, map.discordChannelId);
    assert.equal(row.messageId, "kolvip-16-99");
    assert.equal(row.source, "kolvip_cdp");
    assert.equal(row.content, "BTC 做多 95000");
    const raw = /** @type {{ attachments?: Array<{ url: string }> }} */ (row.rawJson);
    assert.equal(raw.attachments?.[0]?.url, "https://cdn.example/img.jpg");
  });

  it("parseKolvipMessageTimeMs 优先 bubble title", () => {
    const ms = parseKolvipMessageTimeMs("无效", "2026-01-15T08:30:00.000Z");
    assert.equal(ms, Date.parse("2026-01-15T08:30:00.000Z"));
  });
});

describe("kolvip 频道 env 与旁路", () => {
  it("默认映射 8 频道含胖猫 parser", () => {
    assert.equal(DEFAULT_KOLVIP_CHANNEL_MAPPINGS.length, 8);
    const pangmao = DEFAULT_KOLVIP_CHANNEL_MAPPINGS.find((m) => m.kolvipChannelId === "16");
    assert.equal(pangmao?.parser, "pangmao");
    assert.ok(getKolvipMappedDiscordChannelIds().has(pangmao.discordChannelId));
  });

  it("parseKolvipChannelIdsEnv 支持列表与 colon", () => {
    const a = parseKolvipChannelIdsEnv("1,16");
    assert.equal(a.length, 2);
    assert.equal(a[1].kolvipChannelId, "16");
    const b = parseKolvipChannelIdsEnv("22:1444963689194192947");
    assert.equal(b[0].discordChannelId, "1444963689194192947");
  });
});

describe("parseCdpConnectHostPort", () => {
  it("解析 host:port", () => {
    const p = parseCdpConnectHostPort("http://127.0.0.1:9222");
    assert.equal(p.host, "127.0.0.1");
    assert.equal(p.port, 9222);
  });
});
