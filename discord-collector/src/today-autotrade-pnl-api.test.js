import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { attachSignalPlanFields, signalTpslFromCard } from "./today-autotrade-pnl-api.js";

describe("signalTpslFromCard", () => {
  it("reads planned TP/SL from execution", () => {
    const tpsl = signalTpslFromCard({
      execution: {
        symbol: "BTC",
        direction: "做多",
        planned: {
          entryPrice: "90000",
          stopLossPrice: "88000",
          takeProfitPrices: ["92000", "95000"],
        },
        actual: {},
        outcome: "pending",
      },
      parsedJson: { symbol: "BTC", direction: "做多" },
    });
    assert.equal(tpsl.stopLossPrice, "88000");
    assert.deepEqual(tpsl.takeProfitPrices, ["92000", "95000"]);
    assert.equal(tpsl.takeProfitText, "92000, 95000");
  });

  it("falls back to parsedJson when planned is empty", () => {
    const tpsl = signalTpslFromCard({
      execution: null,
      parsedJson: {
        symbol: "ETH",
        direction: "做空",
        stopLoss: "2500",
        targets: ["2300", "2200"],
      },
    });
    assert.equal(tpsl.stopLossPrice, "2500");
    assert.equal(tpsl.takeProfitText, "2300, 2200");
  });

  it("returns nulls when TP/SL missing", () => {
    const tpsl = signalTpslFromCard({
      execution: null,
      parsedJson: { symbol: "SOL", direction: "做多" },
    });
    assert.equal(tpsl.stopLossPrice, null);
    assert.equal(tpsl.takeProfitText, null);
    assert.deepEqual(tpsl.takeProfitPrices, []);
  });

  it("clears pnlUsdt when display pnl is rejected (SC-3112)", () => {
    const card = {
      symbol: "BTCUSDT",
      progress: {
        entryPriceUsed: 800,
        pnlPct: 9997.41,
        status: "closed_sl",
        outcome: "stop_loss",
        slPrice: 0.207,
      },
      execution: {
        symbol: "BTC",
        direction: "做多",
        planned: {
          entryPrice: "斬获800%+",
          stopLossPrice: "0.207",
          takeProfitPrices: ["0.226"],
        },
        actual: {},
        outcome: "stop_loss",
      },
      parsedJson: { symbol: "BTC", stopLoss: "0.207", targets: ["0.226"] },
    };
    const trade = attachSignalPlanFields(card, {
      pnlPct: 9997.41,
      pnlUsdt: 199.95,
      marginUsdt: 2,
      progressOutcome: "stop_loss",
    });
    assert.equal(trade.pnlPct, null);
    assert.equal(trade.pnlUsdt, null);
    assert.equal(trade.rawPnlPct, undefined);
    assert.equal(trade.stopLossPrice, null);
    assert.equal(trade.takeProfitText, null);
  });

  it("sanitizes wrong-scale BTC plan on display", () => {
    const tpsl = signalTpslFromCard({
      symbol: "BTCUSDT",
      execution: {
        symbol: "BTC",
        direction: "做多",
        planned: {
          entryPrice: "0.207",
          stopLossPrice: "0.207",
          takeProfitPrices: ["0.226"],
        },
        actual: {},
        outcome: "pending",
      },
      parsedJson: { symbol: "BTC", stopLoss: "89000", targets: ["93000"] },
      progress: { entryPriceUsed: 91000 },
    });
    assert.equal(tpsl.stopLossPrice, "89000");
    assert.deepEqual(tpsl.takeProfitPrices, ["93000"]);
  });
});