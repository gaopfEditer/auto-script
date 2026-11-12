import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_COPY_SIZING_PARAMS,
  advancePositionAfterOutcome,
  evalCardToCopySizingTrade,
  normalizeCopySizingParams,
  replayCopySizingHistory,
  replayFromEvalCards,
} from "./telegram-copy-sizing.js";

describe("normalizeCopySizingParams", () => {
  it("fills defaults and clamps invalid numbers", () => {
    const p = normalizeCopySizingParams({ basePosition: -1, winBumpPct: "x" });
    assert.deepEqual(p, {
      basePosition: DEFAULT_COPY_SIZING_PARAMS.basePosition,
      winBumpPct: DEFAULT_COPY_SIZING_PARAMS.winBumpPct,
      lossCutPct: DEFAULT_COPY_SIZING_PARAMS.lossCutPct,
      minPosition: DEFAULT_COPY_SIZING_PARAMS.minPosition,
    });
  });

  it("keeps custom positive params", () => {
    const p = normalizeCopySizingParams({
      basePosition: 2,
      winBumpPct: 15,
      lossCutPct: 25,
      minPosition: 0.5,
    });
    assert.equal(p.basePosition, 2);
    assert.equal(p.winBumpPct, 15);
    assert.equal(p.lossCutPct, 25);
    assert.equal(p.minPosition, 0.5);
  });
});

describe("advancePositionAfterOutcome", () => {
  const custom = { winBumpPct: 20, lossCutPct: 30, minPosition: 1 };

  it("applies +10% after win by default", () => {
    assert.equal(advancePositionAfterOutcome(10, "win", {}), 11);
  });

  it("applies -20% after loss by default", () => {
    assert.equal(advancePositionAfterOutcome(10, "loss", {}), 8);
  });

  it("respects custom ratios", () => {
    assert.equal(advancePositionAfterOutcome(10, "win", custom), 12);
    assert.equal(advancePositionAfterOutcome(10, "loss", custom), 7);
  });

  it("clamps to minimum after loss", () => {
    assert.equal(advancePositionAfterOutcome(1.2, "loss", { minPosition: 1, lossCutPct: 20 }), 1);
    assert.equal(advancePositionAfterOutcome(1, "loss", { minPosition: 2, lossCutPct: 50 }), 2);
  });
});

describe("replayCopySizingHistory", () => {
  it("returns base position for empty sequence", () => {
    const r = replayCopySizingHistory([], { basePosition: 3 });
    assert.equal(r.replayCount, 0);
    assert.equal(r.suggestedNextPosition, 3);
    assert.equal(r.cumulativeSimPnl, 0);
    assert.equal(r.steps.length, 0);
  });

  it("replays in settledAtMs order with ±100% pnl on position", () => {
    /** @type {import("./telegram-copy-sizing.js").CopySizingTradeInput[]} */
    const trades = [
      { id: "b", outcome: "loss", settledAtMs: 200 },
      { id: "a", outcome: "win", settledAtMs: 100 },
    ];
    const r = replayCopySizingHistory(trades, DEFAULT_COPY_SIZING_PARAMS);
    assert.equal(r.replayCount, 2);
    assert.equal(r.steps[0].id, "a");
    assert.equal(r.steps[0].position, 1);
    assert.equal(r.steps[0].simulatedPnl, 1);
    assert.equal(r.steps[0].nextPosition, 1.1);
    assert.equal(r.steps[1].id, "b");
    assert.equal(r.steps[1].position, 1.1);
    assert.equal(r.steps[1].simulatedPnl, -1.1);
    assert.equal(r.cumulativeSimPnl, -0.1);
    assert.equal(r.suggestedNextPosition, 1);
  });
});

describe("evalCardToCopySizingTrade", () => {
  it("maps take_profit/stop_loss and skips pending", () => {
    const win = evalCardToCopySizingTrade({
      entered: true,
      outcome: "take_profit",
      signalAt: "2025-01-01T10:00:00+08:00",
      progress: { tpHits: [{ hitAt: "2025-01-02T12:00:00+08:00" }] },
    });
    assert.ok(win);
    assert.equal(win.outcome, "win");
    assert.ok(win.settledAtMs > 0);

    assert.equal(
      evalCardToCopySizingTrade({ entered: true, outcome: "pending" }),
      null,
    );
    assert.equal(evalCardToCopySizingTrade({ entered: false, outcome: "take_profit" }), null);
  });

  it("replays eval cards with independent 100% pnl", () => {
    const r = replayFromEvalCards(
      [
        {
          id: "1",
          entered: true,
          outcome: "take_profit",
          signalAt: "2025-01-01T00:00:00Z",
          pnlPct: 3.5,
        },
        {
          id: "2",
          entered: true,
          outcome: "stop_loss",
          signalAt: "2025-01-02T00:00:00Z",
          pnlPct: -12,
        },
      ],
      DEFAULT_COPY_SIZING_PARAMS,
    );
    assert.equal(r.replayCount, 2);
    assert.equal(r.cumulativeSimPnl, -0.1);
  });
});
