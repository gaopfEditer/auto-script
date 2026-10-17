import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveOpenTpslPrices,
  placeBitgetOpenWithPresets,
  ensureBitgetPositionTpslAfterOpen,
  isValidTakeProfit,
  isValidStopLoss,
} from "./bitget-tpsl-guard.js";

describe("resolveOpenTpslPrices", () => {
  it("分阶段信号无 TP 时按默认规则生成止盈", () => {
    const r = resolveOpenTpslPrices({
      parsed: { direction: "做多", signalPhase: "open" },
      fillPrice: 100,
      direction: "做多",
      initialSlPct: 4.3,
    });
    assert.ok(r.takeProfitStr, "应有默认 TP");
    assert.ok(r.stopLossStr, "应有 SL");
    assert.ok(isValidStopLoss(100, r.stopLossPrice, "long"));
    assert.ok(isValidTakeProfit(100, r.takeProfitPrice, "long"));
    assert.ok(r.takeProfits.length >= 1);
  });
});

describe("placeBitgetOpenWithPresets", () => {
  it("预设被拒后按新标记价重试，且从不裸开仓", async () => {
    /** @type {string[]} */
    const placeCalls = [];
    let mark = 100;
    let failOnce = true;

    const client = {
      placeOrder: async (body) => {
        placeCalls.push(JSON.stringify({ sl: body.presetStopLossPrice, tp: body.presetStopSurplusPrice }));
        if (!body.presetStopLossPrice || !body.presetStopSurplusPrice) {
          throw new Error("must have presets");
        }
        if (failOnce) {
          failOnce = false;
          mark = 102;
          throw new Error("stop loss price should be less than current price");
        }
        return { data: { orderId: "oid-1" } };
      },
    };

    const result = await placeBitgetOpenWithPresets(client, {
      openBase: { symbol: "BTCUSDT", side: "buy", size: "1" },
      symbol: "BTCUSDT",
      productType: "USDT-FUTURES",
      marginCoin: "USDT",
      holdSide: "long",
      direction: "做多",
      size: "1",
      initialSlPct: 4.3,
      stopLossStr: "95",
      takeProfitStr: "110",
      parsed: {},
      fetchMark: async () => mark,
    });

    assert.equal(result.ok, true);
    assert.equal(placeCalls.length, 2);
    for (const c of placeCalls) {
      const o = JSON.parse(c);
      assert.ok(o.sl && o.tp, "每次下单都必须带 TP/SL");
    }
  });
});

describe("ensureBitgetPositionTpslAfterOpen", () => {
  it("校验失败且补挂失败时市价平仓并告警", async () => {
    process.env.BITGET_REQUIRE_TPSL = "1";
    process.env.BITGET_NAKED_POSITION_ACTION = "close";
    process.env.BITGET_TPSL_VERIFY_SEC = "2";

    let closed = false;
    /** @type {string[]} */
    const alerts = [];

    const client = {
      getSinglePosition: async () => ({ data: [{ symbol: "ETHUSDT", holdSide: "long", total: "1" }] }),
      getOrdersPlanPending: async () => ({ data: [] }),
      withHoldSideFallback: async (fn) => fn("long"),
      placePosTpsl: async () => {
        throw new Error("place-pos-tpsl rejected");
      },
      closePositions: async () => {
        closed = true;
        return { data: { ok: true } };
      },
    };

    const log = {
      warn: (msg) => alerts.push(String(msg)),
    };

    const record = {};
    const result = await ensureBitgetPositionTpslAfterOpen(
      client,
      log,
      {
        symbol: "ETHUSDT",
        productType: "USDT-FUTURES",
        marginCoin: "USDT",
        holdSide: "long",
        size: "1",
        stopLossStr: "3000",
        takeProfitStr: "4000",
        cardId: 42,
      },
      record
    );

    assert.equal(result.ok, false);
    assert.equal(result.reason, "naked_closed");
    assert.equal(closed, true);
    assert.equal(record.nakedPositionClosed, true);
  });
});
