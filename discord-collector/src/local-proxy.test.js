import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveReachableLocalProxy } from "./local-proxy.js";

describe("resolveReachableLocalProxy", () => {
  it("配置端口不通时改用探测到的 7890", async () => {
    const url = await resolveReachableLocalProxy("http://127.0.0.1:7891", {
      probe: async (_host, port) => port === 7890,
      ports: [7890, 7891],
    });
    assert.equal(url, "http://127.0.0.1:7890");
  });

  it("配置端口通时保持原地址", async () => {
    const url = await resolveReachableLocalProxy("http://127.0.0.1:7891", {
      probe: async (_host, port) => port === 7891,
      ports: [7890, 7891],
    });
    assert.equal(url, "http://127.0.0.1:7891");
  });

  it("全部不通时仍返回配置地址", async () => {
    const url = await resolveReachableLocalProxy("http://127.0.0.1:7891", {
      probe: async () => false,
      ports: [7890, 7891],
    });
    assert.equal(url, "http://127.0.0.1:7891");
  });
});
