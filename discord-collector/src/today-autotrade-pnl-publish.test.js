import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatTodayPnlPublishText } from "./today-autotrade-pnl-publish.js";

describe("formatTodayPnlPublishText", () => {
  it("生成多行结算正文", () => {
    const text = formatTodayPnlPublishText({
      dayLabel: "2026年11月23日星期一",
      sumPnlUsdt: 1.5,
      tradeCount: 1,
      rows: [
        {
          sourceLabel: "巨鲸",
          channelName: "女王",
          symbol: "BTC",
          effectiveMarginUsdt: 2,
          pnlPct: 5,
          effectivePnlUsdt: 0.1,
          statusLabel: "止盈",
        },
      ],
    });
    assert.match(text, /合计 \+1\.50 U/);
    assert.match(text, /巨鲸 · 女王 · #BTC/);
  });
});