import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  formatPlazaEveningPnlText,
  formatTodayPnlPublishText,
  pickPlazaEveningHighlightRows,
} from "./today-autotrade-pnl-publish.js";

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

describe("formatPlazaEveningPnlText", () => {
  it("晒单含发单时间与杠杆且不带来源", () => {
    const text = formatPlazaEveningPnlText({
      rows: [
        {
          symbol: "XAUUSDT",
          direction: "做空",
          leverage: 50,
          pnlPct: 19.57,
          signalAt: "2026-11-26T08:48:05.000Z",
        },
      ],
    });
    assert.match(text, /今日盈利 1 笔/);
    assert.match(text, /#XAU 做空 50倍 \+19\.57%/);
    assert.match(text, /发单 16:48/);
    assert.doesNotMatch(text, /巨鲸/);
  });

  it("精选高盈利，无内部发车块", () => {
    const rows = [
      {
        symbol: "XAUUSDT",
        direction: "做空",
        leverage: 50,
        pnlPct: 19.57,
        signalAt: "2026-11-26T08:48:05.000Z",
      },
      {
        symbol: "XAUUSDT",
        direction: "做空",
        leverage: 50,
        pnlPct: 17.14,
        signalAt: "2026-11-26T04:50:00.000Z",
      },
      { symbol: "ETHUSDT", direction: "做多", leverage: 20, pnlPct: 5, signalAt: "2026-11-26T10:00:00.000Z" },
    ];
    assert.equal(pickPlazaEveningHighlightRows(rows, { minPnlPct: 8 }).length, 2);
    const text = formatPlazaEveningPnlText({
      rows,
      moodLine: "够吃就行。",
    });
    assert.match(text, /今日盈利 2 笔/);
    assert.doesNotMatch(text, /\+5\.00%/);
    assert.match(text, /\+17\.14%/);
    assert.doesNotMatch(text, /内部发车/);
    assert.match(text, /够吃就行/);
  });
});