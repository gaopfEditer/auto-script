import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { kolvipWebSocketUrl, parseKolvipWsFrame } from "./kolvip-ws-service.js";

describe("kolvip-ws-service", () => {
  it("builds ws url from api base", () => {
    const url = kolvipWebSocketUrl("abc.token");
    assert.match(url, /^wss:\/\/kolvip\.vip\/api-v1\/webu\/ws\?token=/);
    assert.ok(url.includes(encodeURIComponent("abc.token")));
  });

  it("parses msg frame", () => {
    const frame = parseKolvipWsFrame({
      type: "msg",
      data: {
        id: 99,
        channel_id: 16,
        author: "test",
        text: "BTC long",
        images: [],
        files: [],
        time: 1700000000000,
      },
    });
    assert.equal(frame.kind, "message");
    if (frame.kind === "message") {
      assert.equal(frame.kolvipChannelId, "16");
      assert.equal(frame.message.dataId, "99");
      assert.equal(frame.message.text, "BTC long");
    }
  });

  it("ignores hb", () => {
    assert.equal(parseKolvipWsFrame({ type: "hb" }).kind, "heartbeat");
  });
});