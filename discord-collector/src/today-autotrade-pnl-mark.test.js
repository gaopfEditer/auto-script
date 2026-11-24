import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isProgressTerminal } from "./card-level-progress.js";
import { calcLeveragePnl } from "./card-price-fetch.js";
import {
  computeTodayPnlOpenMark,
  markOpenUserMessage,
  resolveMarkEntryPrice,
} from "./today-autotrade-pnl-mark.js";
import { resolveTodayPnlMarkContext as ctxFromDisplay } from "./today-autotrade-pnl-display.js";

describe("resolveMarkEntryPrice", () => {
  it("prefers progress entryPriceUsed", () => {
    const entry = resolveMarkEntryPrice({
      progress: { entryPriceUsed: 100, entryHitAt: "2026-01-01T00:00:00.000Z" },
      execution: { planned: { entryPrice: "200" } },
      parsedJson: null,
    });
    assert.equal(entry, 100);
  });

  it("rejects percent-hype entry on BTC when progress missing", () => {
    const entry = resolveMarkEntryPrice({
      symbol: "BTCUSDT",
      progress: null,
      execution: { planned: { entryPrice: "斩获800%+" } },
      parsedJson: { entry: "92000" },
    });
    assert.equal(entry, null);
  });
});

describe("short MTM sign", () => {
  it("short profit is positive with mark context", () => {
    const card = {
      symbol: "BTCUSDT",
      execution: { direction: "做空", planned: { entryPrice: "100000" }, actual: {}, outcome: "pending" },
      parsedJson: null,
      progress: { entryHitAt: "2026-01-01T00:00:00.000Z", entryPriceUsed: 100000, leverage: 20 },
    };
    const { isShort, leverage } = ctxFromDisplay(card);
    assert.equal(isShort, true);
    const pnl = calcLeveragePnl(100000, 99000, isShort, leverage);
    assert.ok(pnl && pnl.pnlPctOnMargin > 0);
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