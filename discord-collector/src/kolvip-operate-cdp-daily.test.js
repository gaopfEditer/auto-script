import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isShanghaiAfternoon,
  kolvipOperateCalendarDayKey,
  kolvipOperateCdpDailyQuota,
  shouldPublishKolvipOperateCdp,
  totalCdpPublishOk,
} from "./kolvip-operate-cdp-daily.js";

describe("kolvip-operate-cdp-daily", () => {
  it("下午判定（仅计时，不再作为发单门闩）", () => {
    assert.equal(isShanghaiAfternoon(new Date("2026-11-21T11:59:00+08:00")), false);
    assert.equal(isShanghaiAfternoon(new Date("2026-11-21T12:00:00+08:00")), true);
  });

  it("上海自然日 00:00 切日", () => {
    assert.equal(kolvipOperateCalendarDayKey(new Date("2026-11-21T00:00:00+08:00")), "2026-11-21");
    assert.equal(kolvipOperateCalendarDayKey(new Date("2026-11-21T07:30:00+08:00")), "2026-11-21");
    assert.equal(kolvipOperateCalendarDayKey(new Date("2026-11-20T23:59:00+08:00")), "2026-11-20");
  });

  it("巨鲸日上限默认 4，与上午 TG 条数无关，也不跟 TG send 合计抢额度", () => {
    assert.equal(kolvipOperateCdpDailyQuota(), 4);
    const morning = { dayKey: "2026-11-21", tgOk: 3, tgMorningOk: 3, kolvipOk: 0 };
    assert.equal(shouldPublishKolvipOperateCdp(morning), true);
    const mid = { dayKey: "2026-11-21", tgOk: 0, tgMorningOk: 0, kolvipOk: 3 };
    assert.equal(shouldPublishKolvipOperateCdp(mid), true);
    const full = { dayKey: "2026-11-21", tgOk: 0, tgMorningOk: 0, kolvipOk: 4 };
    assert.equal(shouldPublishKolvipOperateCdp(full), false);
    const more = { dayKey: "2026-11-21", tgOk: 10, tgMorningOk: 10, kolvipOk: 4 };
    assert.equal(totalCdpPublishOk(more), 14);
    assert.equal(shouldPublishKolvipOperateCdp(more), false);
  });
});
