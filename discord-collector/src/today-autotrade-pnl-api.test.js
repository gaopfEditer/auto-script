import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { signalTpslFromCard } from "./today-autotrade-pnl-api.js";

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
});