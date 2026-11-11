import { test } from "node:test";
import assert from "node:assert/strict";
import {
  shanghaiCalendarDayBounds,
  formatMainCardDigestZh,
} from "./card-main-telegram-digest.js";

test("shanghaiCalendarDayBounds returns +08:00 day span", () => {
  const { ymd, fromMs, toMs, timezone } = shanghaiCalendarDayBounds(0);
  assert.equal(timezone, "Asia/Shanghai");
  assert.match(ymd, /^\d{4}-\d{2}-\d{2}$/);
  assert.ok(toMs > fromMs);
  assert.ok(toMs - fromMs >= 86399000 && toMs - fromMs <= 86400000);
});

test("formatMainCardDigestZh includes counts and win rate", () => {
  const text = formatMainCardDigestZh({
    ymd: "2026-10-28",
    chatId: "-1003860925903",
    pushedCount: 5,
    metrics: {
      cardCount: 4,
      winCount: 3,
      lossCount: 1,
      pendingCount: 0,
      winRate: 75,
      avgPnlPct: 2.5,
    },
    decided: 4,
    notEntered: 1,
    timezone: "Asia/Shanghai",
  });
  assert.match(text, /2026-10-28/);
  assert.match(text, /-1003860925903/);
  assert.match(text, /75\.00%/);
  assert.match(text, /推送成功：5 张/);
});
