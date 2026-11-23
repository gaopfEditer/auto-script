import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isShanghaiAfternoon,
  shouldKolvipAfternoonCdpBackfill,
  totalCdpPublishOk,
} from "./kolvip-operate-cdp-daily.js";

describe("kolvip-operate-cdp-daily", () => {
  it("下午判定", () => {
    assert.equal(isShanghaiAfternoon(new Date("2026-11-21T11:59:00+08:00")), false);
    assert.equal(isShanghaiAfternoon(new Date("2026-11-21T12:00:00+08:00")), true);
  });

  it("上午无 TG 且未满 5 单可补量", () => {
    const afternoon = new Date("2026-11-21T15:00:00+08:00");
    const stats = { dayKey: "2026-11-21", tgOk: 0, tgMorningOk: 0, kolvipOk: 1 };
    assert.equal(totalCdpPublishOk(stats), 1);
    assert.equal(shouldKolvipAfternoonCdpBackfill(stats, afternoon), true);
    stats.tgMorningOk = 2;
    assert.equal(shouldKolvipAfternoonCdpBackfill(stats, afternoon), false);
  });
});