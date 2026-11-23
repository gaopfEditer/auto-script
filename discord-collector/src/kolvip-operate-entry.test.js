import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  buildKolvipOperateEntryNarrative,
  improveEntryRange,
  parseEntryRange,
} from "./kolvip-operate-entry.js";
import {
  kolvipOperateSessionDayKey,
  claimKolvipOperateOrderSlot,
  resetKolvipOperateCdpStateForTest,
  resolveKolvipOperateOrderSlots,
  recordTelegramCdpPublishSuccess,
} from "./kolvip-operate-cdp.js";
import { shouldKolvipAfternoonCdpBackfill } from "./kolvip-operate-cdp-daily.js";

describe("kolvip-operate-entry", () => {
  it("XAU 空单抬高入场 8 点", () => {
    const range = parseEntryRange("3564$ - 3578$");
    assert.ok(range);
    const next = improveEntryRange(range, "做空", "XAUUSDT");
    assert.equal(next.lo, 3572);
    assert.equal(next.hi, 3586);
  });

  it("生成仅四行正文", () => {
    const text = buildKolvipOperateEntryNarrative({
      symbol: "XAUUSDT",
      direction: "做空",
      leverage: "50倍",
      entryRaw: "3564$ - 3578$",
    });
    assert.match(text, /^币种：#XAUUSDT/m);
    assert.match(text, /^方向：做空/m);
    assert.match(text, /^杠杆：50倍/m);
    assert.match(text, /^入场：3572\$ - 3586\$/m);
    assert.doesNotMatch(text, /止损|目标/);
  });
});

describe("kolvip-operate-cdp session", () => {
  it("解析 999=全部 / 1,3,5,6", () => {
    assert.equal(resolveKolvipOperateOrderSlots([999]).acceptAll, true);
    assert.deepEqual([...resolveKolvipOperateOrderSlots([1, 3, 5, 6]).slots].sort(), [1, 3, 5, 6]);
  });

  it("全局发单序仅 1/3/5/6 占槽", () => {
    resetKolvipOperateCdpStateForTest();
    const morning = new Date("2026-11-21T09:00:00+08:00");
    assert.deepEqual(claimKolvipOperateOrderSlot(morning), { slot: 1, backfill: false });
    assert.equal(claimKolvipOperateOrderSlot(morning), null);
    assert.deepEqual(claimKolvipOperateOrderSlot(morning), { slot: 3, backfill: false });
    assert.equal(claimKolvipOperateOrderSlot(morning), null);
    assert.deepEqual(claimKolvipOperateOrderSlot(morning), { slot: 5, backfill: false });
    assert.deepEqual(claimKolvipOperateOrderSlot(morning), { slot: 6, backfill: false });
    assert.equal(claimKolvipOperateOrderSlot(morning), null);
    resetKolvipOperateCdpStateForTest();
  });

  it("下午 TG 上午无单时巨鲸补量占非槽位序号", () => {
    resetKolvipOperateCdpStateForTest();
    const afternoon = new Date("2026-11-21T14:00:00+08:00");
    const stats = { dayKey: "2026-11-21", tgOk: 0, tgMorningOk: 0, kolvipOk: 0 };
    assert.equal(shouldKolvipAfternoonCdpBackfill(stats, afternoon), true);
    assert.deepEqual(claimKolvipOperateOrderSlot(afternoon), { slot: 1, backfill: false });
    assert.deepEqual(claimKolvipOperateOrderSlot(afternoon), { slot: 2, backfill: true });
    assert.deepEqual(claimKolvipOperateOrderSlot(afternoon), { slot: 3, backfill: false });
    assert.deepEqual(claimKolvipOperateOrderSlot(afternoon), { slot: 4, backfill: true });
    resetKolvipOperateCdpStateForTest();
  });

  it("上午 TG 已有单则下午不补非槽位", () => {
    resetKolvipOperateCdpStateForTest();
    const morning = new Date("2026-11-21T10:00:00+08:00");
    recordTelegramCdpPublishSuccess(morning);
    const afternoon = new Date("2026-11-21T15:00:00+08:00");
    assert.deepEqual(claimKolvipOperateOrderSlot(afternoon), { slot: 1, backfill: false });
    assert.equal(claimKolvipOperateOrderSlot(afternoon), null);
    resetKolvipOperateCdpStateForTest();
  });

  it("08:00 前归属上一交易日", () => {
    const early = new Date("2026-11-21T07:30:00+08:00");
    const late = new Date("2026-11-21T08:30:00+08:00");
    assert.equal(kolvipOperateSessionDayKey(early), "2026-11-20");
    assert.equal(kolvipOperateSessionDayKey(late), "2026-11-21");
  });
});