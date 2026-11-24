import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bareTradeSymbol,
  isImplausibleEntryText,
  levelNearAnchor,
  priceSaneForSymbol,
  reconcileDisplayOutcome,
  reconcileDisplayPnlPct,
  resolveTodayPnlMarkContext,
  sanitizeDisplayTpsl,
} from "./today-autotrade-pnl-display.js";

describe("resolveTodayPnlMarkContext", () => {
  it("detects short from execution direction (not resolveLiquidationPlan)", () => {
    const ctx = resolveTodayPnlMarkContext({
      symbol: "SKHYNIXUSDT",
      assetClass: "crypto",
      execution: {
        symbol: "SKHYNIX",
        direction: "做空",
        planned: { entryPrice: "900", stopLossPrice: "950", takeProfitPrices: [] },
        actual: {},
        outcome: "pending",
      },
      parsedJson: null,
      progress: { entryHitAt: "2026-01-01T00:00:00.000Z", entryPriceUsed: 900, leverage: 10 },
    });
    assert.equal(ctx.isShort, true);
    assert.equal(ctx.leverage, 10);
  });

  it("uses 20x leverage for non-BTC altcoin without progress leverage", () => {
    const ctx = resolveTodayPnlMarkContext({
      symbol: "SKHYNIXUSDT",
      execution: { direction: "做多", planned: {}, actual: {}, outcome: "pending" },
      parsedJson: null,
      progress: { entryHitAt: "2026-01-01T00:00:00.000Z", entryPriceUsed: 900 },
    });
    assert.equal(ctx.isShort, false);
    assert.equal(ctx.leverage, 20);
  });
});

describe("sanitizeDisplayTpsl", () => {
  it("drops MMT-scale TP/SL leaked onto BTC card", () => {
    const tpsl = sanitizeDisplayTpsl(
      {
        symbol: "BTCUSDT",
        execution: {
          symbol: "BTC",
          direction: "做多",
          planned: {
            entryPrice: "斩获800%+",
            stopLossPrice: "0.207",
            takeProfitPrices: ["0.226", "0.239", "0.261"],
          },
          actual: {},
          outcome: "pending",
        },
        parsedJson: {
          symbol: "BTC",
          direction: "做多",
          entry: "92000",
          stopLoss: "90000",
          targets: ["95000"],
        },
        progress: { entryPriceUsed: 91500 },
      },
      {
        stopLossPrice: "0.207",
        takeProfitPrices: ["0.226", "0.239", "0.261"],
        takeProfitText: "0.226, 0.239, 0.261",
      }
    );
    assert.equal(tpsl.stopLossPrice, "90000");
    assert.deepEqual(tpsl.takeProfitPrices, ["95000"]);
  });

  it("rejects absurd stop vs SKHYNIX entry anchor", () => {
    const tpsl = sanitizeDisplayTpsl(
      {
        symbol: "SKHYNIXUSDT",
        execution: {
          symbol: "SKHYNIX",
          direction: "做空",
          planned: { entryPrice: "920", stopLossPrice: "234217.85", takeProfitPrices: [] },
          actual: {},
          outcome: "pending",
        },
        parsedJson: null,
        progress: { entryPriceUsed: 920 },
      },
      { stopLossPrice: "234217.85", takeProfitPrices: [], takeProfitText: null }
    );
    assert.equal(tpsl.stopLossPrice, null);
  });
});

describe("reconcileDisplayPnlPct", () => {
  it("nulls garbage pnl from sub-dollar BTC entry in progress", () => {
    const p = reconcileDisplayPnlPct(
      {
        symbol: "BTCUSDT",
        progress: { entryPriceUsed: 0.207, pnlPct: 9997.41 },
        execution: null,
        parsedJson: null,
      },
      9997.41
    );
    assert.equal(p, null);
  });
});

describe("reconcileDisplayOutcome", () => {
  it("fixes take_profit label when pnl is deeply negative", () => {
    assert.equal(reconcileDisplayOutcome("take_profit", -851), "stop_loss");
  });

  it("fixes stop_loss label when pnl is positive", () => {
    assert.equal(reconcileDisplayOutcome("stop_loss", 12.5), "take_profit");
  });
});

describe("helpers", () => {
  it("bareTradeSymbol strips quote", () => {
    assert.equal(bareTradeSymbol("BTCUSDT"), "BTC");
  });

  it("isImplausibleEntryText flags percent hype", () => {
    assert.equal(isImplausibleEntryText("斩获800%+", "BTC"), true);
    assert.equal(isImplausibleEntryText("91500", "BTC"), false);
  });

  it("priceSaneForSymbol enforces BTC floor", () => {
    assert.equal(priceSaneForSymbol("BTCUSDT", 0.207), false);
    assert.equal(priceSaneForSymbol("BTCUSDT", 62000), true);
  });

  it("levelNearAnchor", () => {
    assert.equal(levelNearAnchor(900, 950, 3), true);
    assert.equal(levelNearAnchor(900, 234217, 3), false);
  });
});