import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { classifyRangeEntry, entryHasRange, resolveEntryRaw } from "./range-entry-policy.js";

describe("classifyRangeEntry", () => {
  const shortRange = "3568$ - 3590$";
  const longRange = "@3619 - 3615";

  it("已在闭区间内（含端点）立即市价", () => {
    for (const mark of [3568, 3579, 3590]) {
      const r = classifyRangeEntry(shortRange, "做空", mark);
      assert.equal(r.action, "enter_now", String(mark));
      assert.deepEqual(r.range, { low: 3568, high: 3590 });
      assert.equal(r.mark, mark);
    }
    const long = classifyRangeEntry(longRange, "做多", 3615);
    assert.equal(long.action, "enter_now");
    assert.deepEqual(long.range, { low: 3615, high: 3619 });
  });

  it("区外尚未进入则等待", () => {
    const shortWait = classifyRangeEntry(shortRange, "SHORT", 3600);
    assert.equal(shortWait.action, "wait");
    const longWait = classifyRangeEntry("3619 - 3615", "做多", 3610);
    assert.equal(longWait.action, "wait");
  });

  it("空单已低于区间低点、多单已高于区间高点则跳过不追", () => {
    const shortSkip = classifyRangeEntry(shortRange, "做空", 3567.9);
    assert.equal(shortSkip.action, "skip_crossed");
    assert.equal(shortSkip.reason, "price_crossed_below_range");
    const longSkip = classifyRangeEntry(longRange, "LONG", 3620);
    assert.equal(longSkip.action, "skip_crossed");
    assert.equal(longSkip.reason, "price_crossed_above_range");
  });

  it("单点入场不走区间规则", () => {
    const r = classifyRangeEntry("3628", "做空", 3620);
    assert.equal(r.action, "pass");
    assert.equal(r.range, null);
    assert.equal(entryHasRange("3628"), false);
    assert.equal(entryHasRange("3568$ - 3590$"), true);
  });

  it("方向不明或没有标记价时不擅自开仓", () => {
    assert.equal(classifyRangeEntry(shortRange, "", 3570).action, "direction_unclear");
    assert.equal(classifyRangeEntry(shortRange, "做空", null).action, "mark_unavailable");
  });

  it("resolveEntryRaw 优先 planned.entryPrice", () => {
    const raw = resolveEntryRaw({ entry: "1 - 2" }, { planned: { entryPrice: "3568$ - 3590$" } });
    assert.equal(raw, "3568$ - 3590$");
  });
});
