import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { evalCardPathQualityIssue } from "./card-eval-path-quality.js";

describe("evalCardPathQualityIssue", () => {
  it("pnl 爆炸", () => {
    const hit = evalCardPathQualityIssue({
      symbol: "BTCUSDT",
      progress: { pnlPct: -2_000_000, entryHitAt: "x", leverage: 100 },
    });
    assert.equal(hit?.code, "pnl_outlier");
  });

  it("BTC 上用金价入场", () => {
    const hit = evalCardPathQualityIssue({
      symbol: "BTCUSDT",
      parsedJson: { entry: "3955" },
      progress: { pnlPct: 10, entryHitAt: "x", leverage: 20 },
    });
    assert.equal(hit?.code, "symbol_entry_mismatch");
  });

  it("BTC 正常六万档不算错标", () => {
    const hit = evalCardPathQualityIssue({
      symbol: "BTCUSDT",
      parsedJson: { entry: "76500" },
      progress: { pnlPct: 10, entryHitAt: "x", leverage: 100 },
    });
    assert.equal(hit, null);
  });
});