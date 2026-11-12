import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveTelegramGroupEvalWindows,
  TELEGRAM_GROUP_EVAL_TZ,
} from "./card-eval-api.js";

describe("resolveTelegramGroupEvalWindows", () => {
  it("exposes month / week / all with Shanghai timezone metadata", () => {
    const w = resolveTelegramGroupEvalWindows();
    assert.equal(w.month.label, "近一个月");
    assert.equal(w.week.label, "七天");
    assert.equal(w.all.label, "总计");
    assert.equal(w.month.timezone, TELEGRAM_GROUP_EVAL_TZ);
    assert.equal(w.week.timezone, TELEGRAM_GROUP_EVAL_TZ);
    assert.equal(w.all.timezone, TELEGRAM_GROUP_EVAL_TZ);
    assert.equal(w.all.allTime, true);
    assert.equal(w.all.fromMs, 0);
    assert.ok(w.month.toMs >= w.month.fromMs);
    assert.ok(w.week.toMs >= w.week.fromMs);
    assert.equal(w.all.toMs, w.month.toMs);
    assert.equal(w.week.toMs, w.month.toMs);
    assert.ok(!("lastWeek" in w));
  });
});
