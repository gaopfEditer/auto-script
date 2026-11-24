import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  bareTradeSymbol,
  isImplausibleEntryText,
  levelNearAnchor,
  priceSaneForSymbol,
  reconcileDisplayOutcome,
  reconcileDisplayPnlPct,
  resolveTodayPnlEntryDisplay,
  resolveTodayPnlMarkContext,
  sanitizeDisplayTpsl,
  resolveCardAlignedDisplayPnl,
  resolveCardAlignedDisplayOutcome,
  dedupeTodayPnlTrades,
  TODAY_PNL_SIGNAL_DEDUPE_MS,
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

  it("rejects short stop below entry (ICNT leak)", () => {
    const tpsl = sanitizeDisplayTpsl(
      {
        symbol: "ICNTUSDT",
        execution: {
          symbol: "ICNT",
          direction: "做空",
          planned: {
            entryPrice: "0.3302",
            stopLossPrice: "0.207",
            takeProfitPrices: ["0.226", "0.239", "0.261"],
          },
          actual: {},
          outcome: "pending",
        },
        parsedJson: {
          symbol: "ICNT",
          direction: "做空",
          entry: "0.3302",
          stopLoss: "0.207",
          targets: ["0.226"],
        },
        progress: { entryPriceUsed: 0.3302 },
      },
      {
        stopLossPrice: "0.207",
        takeProfitPrices: ["0.226", "0.239", "0.261"],
        takeProfitText: "0.226, 0.239, 0.261",
      }
    );
    assert.equal(tpsl.stopLossPrice, null);
    assert.deepEqual(tpsl.takeProfitPrices, []);
  });

  it("keeps valid short ICNT plan", () => {
    const tpsl = sanitizeDisplayTpsl(
      {
        symbol: "ICNTUSDT",
        execution: {
          symbol: "ICNT",
          direction: "做空",
          planned: {
            entryPrice: "0.3302",
            stopLossPrice: "0.3418",
            takeProfitPrices: ["0.3165", "0.296", "0.262"],
          },
          actual: {},
          outcome: "pending",
        },
        parsedJson: null,
        progress: { entryPriceUsed: 0.3302 },
      },
      {
        stopLossPrice: "0.3418",
        takeProfitPrices: ["0.3165", "0.296", "0.262"],
        takeProfitText: "0.3165, 0.296, 0.262",
      }
    );
    assert.equal(tpsl.stopLossPrice, "0.3418");
    assert.deepEqual(tpsl.takeProfitPrices, ["0.3165", "0.296", "0.262"]);
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
  it("nulls garbage pnl when BTC progress entry is marketing 800", () => {
    const p = reconcileDisplayPnlPct(
      {
        symbol: "BTCUSDT",
        progress: { entryPriceUsed: 800, pnlPct: 9997.41 },
        execution: {
          direction: "做多",
          planned: { entryPrice: "斬获800%+" },
          actual: {},
          outcome: "pending",
        },
        parsedJson: null,
      },
      9997.41
    );
    assert.equal(p, null);
  });

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

describe("resolveTodayPnlEntryDisplay", () => {
  it("shows sane planned entry on XAU row", () => {
    const d = resolveTodayPnlEntryDisplay({
      symbol: "XAUUSDT",
      execution: {
        direction: "做多",
        planned: { entryPrice: "3625", stopLossPrice: "3615", takeProfitPrices: ["3628"] },
        actual: {},
        outcome: "pending",
      },
      parsedJson: null,
      progress: { entryPriceUsed: 3625 },
    });
    assert.equal(d.entryPriceKind, "planned");
    assert.equal(d.entryPrice, "3625");
    assert.equal(d.entryPriceDisplay, "3625");
  });

  it("keeps ICNT entry when TP/SL voided", () => {
    const tpsl = sanitizeDisplayTpsl(
      {
        symbol: "ICNTUSDT",
        execution: {
          symbol: "ICNT",
          direction: "做空",
          planned: { entryPrice: "0.3302", stopLossPrice: "0.207", takeProfitPrices: ["0.226"] },
          actual: {},
          outcome: "pending",
        },
        parsedJson: { entry: "0.3302", direction: "做空" },
        progress: { entryPriceUsed: 0.3302 },
      },
      { stopLossPrice: "0.207", takeProfitPrices: ["0.226"], takeProfitText: "0.226" }
    );
    assert.equal(tpsl.stopLossPrice, null);
    const d = resolveTodayPnlEntryDisplay({
      symbol: "ICNTUSDT",
      execution: {
        symbol: "ICNT",
        direction: "做空",
        planned: { entryPrice: "0.3302", stopLossPrice: "0.207", takeProfitPrices: ["0.226"] },
        actual: {},
        outcome: "pending",
      },
      parsedJson: { entry: "0.3302", direction: "做空" },
      progress: { entryPriceUsed: 0.3302 },
    });
    assert.equal(d.entryPrice, "0.3302");
  });

  it("uses stored marketAtSignal when no sane entry", () => {
    const d = resolveTodayPnlEntryDisplay({
      symbol: "BTCUSDT",
      execution: {
        direction: "做多",
        planned: { entryPrice: "市价", stopLossPrice: "90000", takeProfitPrices: [] },
        actual: {},
        outcome: "pending",
      },
      parsedJson: null,
      progress: null,
      backtest: { mode: "liquidation", marketAtSignal: 91234.5 },
    });
    assert.equal(d.entryPriceKind, "market_at_signal");
    assert.match(d.entryPriceDisplay, /^发单市价 91234\.5/);
  });
});

describe("dedupeTodayPnlTrades", () => {
  it("collapses nearby same-channel MMT rows, keeps richer later plan", () => {
    const older = {
      cardId: 3093,
      channelId: "-1001766481463",
      symbol: "MMTUSDT",
      signalAt: "2026-11-24T01:58:34.000Z",
      pnlPct: 124.71,
      entryPrice: "0.207",
    };
    const newer = {
      cardId: 3094,
      channelId: "-1001766481463",
      symbol: "MMTUSDT",
      signalAt: "2026-11-24T02:00:45.000Z",
      pnlPct: 126.56,
      entryPrice: "0.207",
      stopLossPrice: "0.19",
      takeProfitPrices: ["0.226", "0.239", "0.261"],
      takeProfitText: "0.226, 0.239, 0.261",
    };
    const out = dedupeTodayPnlTrades([older, newer], TODAY_PNL_SIGNAL_DEDUPE_MS);
    assert.equal(out.length, 1);
    assert.equal(out[0].cardId, 3094);
  });

  it("keeps rows outside dedupe window", () => {
    const a = {
      cardId: 1,
      channelId: "ch",
      symbol: "BTCUSDT",
      signalAt: "2026-11-24T01:00:00.000Z",
    };
    const b = {
      cardId: 2,
      channelId: "ch",
      symbol: "BTCUSDT",
      signalAt: "2026-11-24T01:10:00.000Z",
    };
    const out = dedupeTodayPnlTrades([a, b], TODAY_PNL_SIGNAL_DEDUPE_MS);
    assert.equal(out.length, 2);
  });
});

describe("card-aligned pnl (SC-3127 shape)", () => {
  it("take_profit with net negative path pnl shows positive display", () => {
    const card = {
      symbol: "XAUUSDT",
      execution: { direction: "做多", planned: {}, actual: {}, outcome: "pending" },
      progress: {
        status: "closed_sl",
        outcome: "take_profit",
        pnlPct: -10.8,
        entryPriceUsed: 3625,
        tpHits: [{ index: 1, price: 3628, sizePct: 1 / 6 }],
        slHitAt: "2026-01-01T12:00:00.000Z",
      },
    };
    const display = resolveCardAlignedDisplayPnl(card, -10.8);
    assert.equal(display, 10.8);
    assert.equal(resolveCardAlignedDisplayOutcome(card, "take_profit"), "take_profit");
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