import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createRangeEntryService } from "./range-entry-service.js";

function tempService() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "range-entry-svc-"));
  const file = path.join(dir, "pending.json");
  /** @type {Record<string, number>} */
  const marks = { bitget: 3600, weex: 3600 };
  /** @type {string[]} */
  const opened = [];
  /** @type {Set<string>} */
  const exposed = new Set();
  const svc = createRangeEntryService({
    filePath: file,
    intervalMs: 60_000,
    fetchMarkByExchange: {
      bitget: async () => marks.bitget,
      weex: async () => marks.weex,
    },
  });
  for (const ex of /** @type {const} */ (["bitget", "weex"])) {
    svc.registerExchange(ex, {
      hasExposure: async (symbol) => exposed.has(`${ex}:${symbol}`),
      openPending: async (item) => {
        opened.push(`${ex}:${item.cardId}`);
        return { ok: true };
      },
    });
  }
  const base = {
    cardId: 9100,
    channelId: "kolvip-scan-39",
    channelName: "华尔街女王",
    parsed: {
      parser: "kolvip_brief",
      symbol: "XAUUSDT",
      direction: "做空",
      entry: "3568$ - 3590$",
      stopLoss: "3600",
      takeProfits: ["3555", "3542"],
    },
  };
  return { svc, marks, opened, exposed, file, base };
}

describe("range-entry-service", () => {
  it("已在区内立即市价，不登记待触发", async () => {
    const { svc, marks, opened, base } = tempService();
    marks.bitget = 3575;
    const r = await svc.handleArrival({ ...base, exchange: "bitget" });
    assert.equal(r.action, "enter_now");
    assert.equal(svc.listWaiting().length, 0);
    assert.deepEqual(opened, []);
  });

  it("区外等待并在进入后市价；同信号不重复登记", async () => {
    const { svc, marks, opened, base } = tempService();
    marks.bitget = 3605;
    const wait = await svc.handleArrival({ ...base, exchange: "bitget" });
    assert.equal(wait.action, "waiting");
    const again = await svc.handleArrival({ ...base, exchange: "bitget" });
    assert.equal(again.action, "waiting");
    assert.equal(again.already, true);
    assert.equal(svc.listWaiting().length, 1);

    marks.bitget = 3580;
    const tick = await svc.tick();
    assert.equal(svc.listWaiting().length, 0);
    assert.deepEqual(opened, ["bitget:9100"]);
    assert.ok((tick.results ?? []).some((x) => x && /** @type {any} */ (x).action === "triggered"));
  });

  it("穿越远端后跳过，不追价", async () => {
    const { svc, marks, opened, base } = tempService();
    marks.bitget = 3500;
    const r = await svc.handleArrival({ ...base, exchange: "bitget" });
    assert.equal(r.action, "skipped");
    assert.equal(r.reason, "price_crossed_below_range");
    assert.equal(svc.listWaiting().length, 0);
    assert.deepEqual(opened, []);
  });

  it("等待中若价格穿越远端则取消待触发", async () => {
    const { svc, marks, opened, base } = tempService();
    marks.bitget = 3605;
    await svc.handleArrival({ ...base, exchange: "bitget" });
    marks.bitget = 3500;
    const tick = await svc.tick();
    assert.equal(svc.listWaiting().length, 0);
    assert.deepEqual(opened, []);
    assert.ok((tick.results ?? []).some((x) => x && /** @type {any} */ (x).action === "skipped"));
  });

  it("单点入场不受影响，直接 pass", async () => {
    const { svc, base } = tempService();
    const r = await svc.handleArrival({
      ...base,
      exchange: "bitget",
      parsed: { ...base.parsed, entry: "3628" },
    });
    assert.equal(r.action, "pass");
    assert.equal(svc.listWaiting().length, 0);
  });

  it("重启后恢复待触发且不双开；同币种已有仓位则跳过", async () => {
    const first = tempService();
    first.marks.bitget = 3605;
    first.marks.weex = 3605;
    await first.svc.handleArrival({ ...first.base, exchange: "bitget" });
    await first.svc.handleArrival({ ...first.base, exchange: "weex" });
    assert.equal(first.svc.listWaiting().length, 2);

    const marks = { bitget: 3580, weex: 3580 };
    /** @type {string[]} */
    const opened = [];
    const exposed = new Set();
    const resumed = createRangeEntryService({
      filePath: first.file,
      intervalMs: 60_000,
      fetchMarkByExchange: {
        bitget: async () => marks.bitget,
        weex: async () => marks.weex,
      },
    });
    resumed.registerExchange("bitget", {
      hasExposure: async (symbol) => exposed.has(`bitget:${symbol}`),
      openPending: async (item) => {
        opened.push(`bitget:${item.cardId}`);
        return { ok: true };
      },
    });
    resumed.registerExchange("weex", {
      hasExposure: async (symbol) => exposed.has(`weex:${symbol}`),
      openPending: async (item) => {
        opened.push(`weex:${item.cardId}`);
        return { ok: true };
      },
    });
    assert.equal(resumed.listWaiting().length, 2);

    const again = await resumed.handleArrival({ ...first.base, exchange: "bitget" });
    assert.equal(again.already, true);
    assert.equal(resumed.listWaiting().length, 2);

    await resumed.tick();
    assert.deepEqual(opened.sort(), ["bitget:9100", "weex:9100"]);
    assert.equal(resumed.listWaiting().length, 0);

    marks.bitget = 3570;
    exposed.add("bitget:XAUUSDT");
    const blocked = await resumed.handleArrival({ ...first.base, cardId: 9101, exchange: "bitget" });
    assert.equal(blocked.action, "skipped");
    assert.equal(blocked.reason, "duplicate_position");
  });
});
