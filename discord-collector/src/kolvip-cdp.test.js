import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  kolvipStableMessageId,
  kolvipMessageToDiscordRow,
  parseKolvipMessageTimeMs,
} from "./kolvip-cdp-message.js";
import { parseWtokenFromLocalStorageExport } from "./kolvip-api-auth.js";
import { kolvipApiRawToDomMessage } from "./kolvip-api-message.js";
import { parseCdpConnectHostPort } from "./kolvip-cdp-connect.js";
import {
  listKolvipGroupAncestorsOuterToInner,
  domOpenKolvipChannel,
} from "./kolvip-cdp-nav.js";
import {
  DEFAULT_KOLVIP_CHANNEL_MAPPINGS,
  parseKolvipChannelIdsEnv,
  getKolvipMappedDiscordChannelIds,
  resolveKolvipAssetUrl,
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

  it("相对路径 imageUrl 拼 kolvip origin", () => {
    const map = DEFAULT_KOLVIP_CHANNEL_MAPPINGS.find((m) => m.kolvipChannelId === "16");
    assert.ok(map);
    const row = kolvipMessageToDiscordRow(
      {
        dataId: "1",
        text: "x",
        author: "胖猫",
        timeText: "",
        timeTitle: "",
        imageUrl: "/web_file/abc.png",
      },
      { kolvipChannelId: map.kolvipChannelId, discordChannelId: map.discordChannelId }
    );
    const raw = /** @type {{ attachments?: Array<{ url: string }> }} */ (row.rawJson);
    assert.match(raw.attachments?.[0]?.url ?? "", /^https:\/\/[^/]+\/web_file\/abc\.png$/);
  });

  it("parseKolvipMessageTimeMs 优先 bubble title", () => {
    const ms = parseKolvipMessageTimeMs("无效", "2026-01-15T08:30:00.000Z");
    assert.equal(ms, Date.parse("2026-01-15T08:30:00.000Z"));
  });
});

describe("resolveKolvipAssetUrl", () => {
  it("保留绝对 URL", () => {
    assert.equal(resolveKolvipAssetUrl("https://cdn.example/x"), "https://cdn.example/x");
  });

  it("/web_file 相对路径", () => {
    assert.match(resolveKolvipAssetUrl("/web_file/x"), /^https:\/\/[^/]+\/web_file\/x$/);
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

describe("kolvip API 消息行", () => {
  it("kolvipApiRawToDomMessage 映射 id 与图片", () => {
    const dom = kolvipApiRawToDomMessage({
      id: 42,
      text: "BTC long",
      author: "测试",
      time: Date.parse("2026-01-01T00:00:00.000Z"),
      images: [{ url: "https://cdn.example/a.jpg" }],
    });
    assert.equal(dom.dataId, "42");
    assert.equal(dom.text, "BTC long");
    assert.equal(dom.imageUrl, "https://cdn.example/a.jpg");
  });

  it("API 相对路径 images 拼绝对 URL", () => {
    const dom = kolvipApiRawToDomMessage({
      id: 1,
      text: "t",
      images: [{ url: "/web_file/pangmao.jpg" }],
    });
    assert.match(dom.imageUrl, /^https:\/\/[^/]+\/web_file\/pangmao\.jpg$/);
  });

  it("parseWtokenFromLocalStorageExport", () => {
    const t = parseWtokenFromLocalStorageExport({ wtoken: "abc" });
    assert.equal(t, "abc");
  });
});

describe("parseCdpConnectHostPort", () => {
  it("解析 host:port", () => {
    const p = parseCdpConnectHostPort("http://127.0.0.1:9222");
    assert.equal(p.host, "127.0.0.1");
    assert.equal(p.port, 9222);
  });
});

describe("kolvip 侧栏分组展开顺序", () => {
  it("listKolvipGroupAncestorsOuterToInner 外层先于内层", () => {
    const doc = {
      createElement(tag) {
        return { tagName: tag.toUpperCase(), parentElement: null, attributes: {} };
      },
    };
    /** @type {any} */
    const outer = { tagName: "DIV", parentElement: null, hasAttribute: (n) => n === "data-open-grp" };
    /** @type {any} */
    const inner = { tagName: "DIV", parentElement: outer, hasAttribute: (n) => n === "data-open-grp" };
    /** @type {any} */
    const ch = { tagName: "A", parentElement: inner, hasAttribute: () => false };
    outer.parentElement = null;
    const chain = listKolvipGroupAncestorsOuterToInner(/** @type {Element} */ (ch));
    assert.deepEqual(chain, [outer, inner]);
  });

  it("domOpenKolvipChannel 无入口时失败", () => {
    const document = {
      querySelectorAll: () => [],
    };
    const r = domOpenKolvipChannel(/** @type {Document} */ (document), "1");
    assert.equal(r.ok, false);
  });
});
