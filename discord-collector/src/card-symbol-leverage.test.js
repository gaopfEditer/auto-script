import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { resolveStatsLeverage } from "./card-symbol-leverage.js";

describe("resolveStatsLeverage", () => {
  it("XAU 50x", () => {
    assert.equal(resolveStatsLeverage("XAU"), 50);
    assert.equal(resolveStatsLeverage("XAUUSDT"), 50);
    assert.equal(resolveStatsLeverage("PAXGUSDT"), 50);
  });
  it("BTC/ETH 100x", () => {
    assert.equal(resolveStatsLeverage("BTCUSDT"), 100);
    assert.equal(resolveStatsLeverage("ETH"), 100);
  });
  it("山寨 20x", () => {
    assert.equal(resolveStatsLeverage("SOLUSDT"), 20);
    assert.equal(resolveStatsLeverage("ARCUSDT"), 20);
  });
});