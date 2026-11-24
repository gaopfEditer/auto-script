import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseShanghaiCalendarDayYmd,
  resolveShanghaiDayRange,
  shanghaiYmdFromMs,
} from "./card-archive-mysql-time.js";
import { resolveTodayAutotradePnlDayRange } from "./today-autotrade-pnl-api.js";

const NOW = Date.parse("2026-11-24T15:30:00+08:00");

describe("resolveShanghaiDayRange", () => {
  it("default today: from 00:00 Shanghai to now", () => {
    const r = resolveShanghaiDayRange({ nowMs: NOW });
    assert.equal(r.dayYmd, "2026-11-24");
    assert.equal(r.isToday, true);
    assert.equal(r.fromMs, Date.parse("2026-11-24T00:00:00+08:00"));
    assert.equal(r.toMs, NOW);
  });

  it("yesterday: full calendar day window", () => {
    const r = resolveShanghaiDayRange({ day: "2026-11-23", nowMs: NOW });
    assert.equal(r.dayYmd, "2026-11-23");
    assert.equal(r.isToday, false);
    assert.equal(r.fromMs, Date.parse("2026-11-23T00:00:00+08:00"));
    assert.equal(r.toMs, Date.parse("2026-11-24T00:00:00+08:00") - 1);
  });

  it("earlier day uses Shanghai midnight boundaries", () => {
    const r = resolveShanghaiDayRange({ day: "2026-11-20", nowMs: NOW });
    assert.equal(r.fromMs, Date.parse("2026-11-20T00:00:00+08:00"));
    assert.equal(r.toMs, Date.parse("2026-11-21T00:00:00+08:00") - 1);
    assert.equal(shanghaiYmdFromMs(r.fromMs), "2026-11-20");
  });

  it("invalid day falls back to today", () => {
    const r = resolveShanghaiDayRange({ day: "not-a-date", nowMs: NOW });
    assert.equal(r.dayYmd, "2026-11-24");
    assert.equal(r.isToday, true);
  });
});

describe("resolveTodayAutotradePnlDayRange", () => {
  it("wraps query day param", () => {
    const r = resolveTodayAutotradePnlDayRange("2026-11-22", NOW);
    assert.equal(r.dayYmd, "2026-11-22");
    assert.equal(parseShanghaiCalendarDayYmd("2026-11-22"), r.fromMs);
  });
});