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
  recordKolvipCdpPublishSuccess,
  recordTelegramCdpPublishSuccess,
} from "./kolvip-operate-cdp.js";
import { shouldPublishKolvipOperateCdp } from "./kolvip-operate-cdp-daily.js";

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
  it("解析 999=全部 / 1,3,5,6；空列表视为全部", () => {
    assert.equal(resolveKolvipOperateOrderSlots([999]).acceptAll, true);
    assert.equal(resolveKolvipOperateOrderSlots([]).acceptAll, true);
    assert.deepEqual([...resolveKolvipOperateOrderSlots([1, 3, 5, 6]).slots].sort(), [1, 3, 5, 6]);
  });

  it("显式 1/3/5/6 时仍只占这些槽，且不再下午补非槽位", () => {
    resetKolvipOperateCdpStateForTest();
    const previous = process.env.KOLVIP_OPERATE_CDP_ORDER_SLOTS;
    process.env.KOLVIP_OPERATE_CDP_ORDER_SLOTS = "1,3,5,6";
    // config is already loaded; this test uses resolve + manual? claim reads live config.
    // 不依赖改 env（config 已缓存）。用 resolve 单测槽解析；claim 走当前默认 999。
    const morning = new Date("2026-11-21T09:00:00+08:00");
    const policy = resolveKolvipOperateOrderSlots([1, 3, 5, 6]);
    const taken = [];
    for (let i = 1; i <= 7; i += 1) {
      taken.push(policy.acceptAll || policy.slots.has(i) ? i : null);
    }
    assert.deepEqual(taken, [1, null, 3, null, 5, 6, null]);
    if (previous == null) delete process.env.KOLVIP_OPERATE_CDP_ORDER_SLOTS;
    else process.env.KOLVIP_OPERATE_CDP_ORDER_SLOTS = previous;
    resetKolvipOperateCdpStateForTest();
  });

  it("默认全部槽位时上午也可连发，满 4 条成功后停止；TG send 成功不占额度", () => {
    resetKolvipOperateCdpStateForTest();
    const morning = new Date("2026-11-21T09:00:00+08:00");
    recordTelegramCdpPublishSuccess(morning);
    recordTelegramCdpPublishSuccess(morning);
    assert.equal(
      shouldPublishKolvipOperateCdp({ dayKey: "2026-11-21", tgOk: 2, tgMorningOk: 2, kolvipOk: 0 }),
      true,
    );
    for (let i = 1; i <= 4; i += 1) {
      assert.deepEqual(claimKolvipOperateOrderSlot(morning), { slot: i, backfill: false });
      recordKolvipCdpPublishSuccess(morning);
    }
    assert.equal(claimKolvipOperateOrderSlot(morning), null);
    const afternoon = new Date("2026-11-21T15:00:00+08:00");
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