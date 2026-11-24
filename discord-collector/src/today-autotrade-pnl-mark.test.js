import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isProgressTerminal } from "./card-level-progress.js";
import {
  computeTodayPnlOpenMark,
  markOpenUserMessage,
  resolveMarkEntryPrice,
} from "./today-autotrade-pnl-mark.js";

describe("resolveMarkEntryPrice", () => {
  it("prefers progress entryPriceUsed", () => {
    const entry = resolveMarkEntryPrice({
      progress: { entryPriceUsed: 100, entryHitAt: "2026-01-01T00:00:00.000Z" },
      execution: { planned: { entryPrice: "200" } },
      parsedJson: null,
    });
    assert.equal(entry, 100);
  });

  it("falls back to planned entry", () => {
    const entry = resolveMarkEntryPrice({
      progress: null,
      execution: { planned: { entryPrice: "0.55" } },
      parsedJson: { entry: "0.6" },
    });
    assert.equal(entry, 0.55);
  });
});

describe("computeTodayPnlOpenMark", () => {
  it("skips terminal progress", async () => {
    const card = {
      symbol: "BTC",
      progress: { status: "closed_tp", outcome: "take_profit", pnlPct: 5 },
      execution: null,
      parsedJson: null,
    };
    assert.equal(isProgressTerminal(card.progress), true);
    const r = await computeTodayPnlOpenMark(card);
    assert.equal(r.skip, true);
    assert.equal(r.reason, "closed");
  });
});

describe("markOpenUserMessage", () => {
  it("maps known codes", () => {
    assert.equal(markOpenUserMessage("no_entry"), "无入场价");
    assert.equal(markOpenUserMessage("price_fetch_failed"), "现价获取失败");
  });
});