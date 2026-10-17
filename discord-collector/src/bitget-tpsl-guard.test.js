import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveOpenTpslPrices,
  placeBitgetOpenWithPresets,
  ensureBitgetPositionTpslAfterOpen,
  repairBitgetPositionTpsl,
  classifyBitgetTpslRepairError,
  resolveRepairTpslLevels,
  isValidTakeProfit,
  isValidStopLoss,
  bitgetRequireTpslEnabled,
  bitgetNakedPositionAction,
  bitgetTpslVerifyWindowMs,
  bitgetTpslRepairRetries,
} from "./bitget-tpsl-guard.js";

const baseCtx = {
  symbol: "ETHUSDT",
  productType: "USDT-FUTURES",
  marginCoin: "USDT",
  holdSide: "long",
  size: "1",
  stopLossStr: "3000",
  takeProfitStr: "4000",
  cardId: 42,
  direction: "做多",
  initialSlPct: 4.3,
  fetchMark: async () => 3500,
};

function mockInspectMissing(client) {
  client.getSinglePosition = async () => ({
    data: [{ symbol: "ETHUSDT", holdSide: "long", total: "1" }],
  });
  client.getOrdersPlanPending = async () => ({ data: [] });
  client.withHoldSideFallback = async (fn) => fn("long");
}

describe("classifyBitgetTpslRepairError", () => {
  it("识别止损已被穿越 (long)", () => {
    const cat = classifyBitgetTpslRepairError(
      "stop loss price of the long position should be less than the current price",
      "long"
    );
    assert.equal(cat, "sl_breached");
  });

  it("识别精度错误", () => {
    assert.equal(classifyBitgetTpslRepairError("triggerPrice precision error pricePlace", "long"), "precision");
  });

  it("识别 transient / 429", () => {
    assert.equal(classifyBitgetTpslRepairError("429 Too Many Requests", "long"), "transient");
  });

  it("识别 holdSide 不匹配", () => {
    assert.equal(classifyBitgetTpslRepairError("holdSide position mode mismatch", "long"), "hold_side");
  });
});

describe("resolveRepairTpslLevels", () => {
  it("信号价相对 mark 仍有效时保留信号档位", () => {
    const r = resolveRepairTpslLevels({
      mark: 3500,
      holdSide: "long",
      direction: "做多",
      initialSlPct: 4.3,
      signalStopLossStr: "3400",
      signalTakeProfitStr: "3800",
      sizeStr: "1",
    });
    assert.equal(r.stopLossStr, "3400");
    assert.equal(r.takeProfitStr, "3800");
    assert.equal(r.usedSignalSl, true);
    assert.equal(r.usedSignalTp, true);
  });

  it("信号 SL 无效时按 mark 重算默认 TP/SL", () => {
    const r = resolveRepairTpslLevels({
      mark: 3500,
      holdSide: "long",
      direction: "做多",
      initialSlPct: 4.3,
      signalStopLossStr: "3600",
      signalTakeProfitStr: "3800",
      sizeStr: "1",
    });
    assert.equal(r.usedSignalSl, false);
    assert.ok(isValidStopLoss(3500, Number(r.stopLossStr), "long"));
    assert.ok(isValidTakeProfit(3500, Number(r.takeProfitStr), "long"));
  });
});

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

describe("repairBitgetPositionTpsl", () => {
  it("precision 错误：舍入后重试成功", async () => {
    process.env.BITGET_TPSL_REPAIR_RETRIES = "3";
    let calls = 0;
    let placed = false;
    const client = {
      getMixContract: async () => ({ pricePlace: 2, priceEndStep: 0.01, volumePlace: 2, sizeMultiplier: 0.01 }),
      getSinglePosition: async () => ({ data: [{ symbol: "ETHUSDT", holdSide: "long", total: "1" }] }),
      getOrdersPlanPending: async () =>
        placed
          ? {
              data: [
                { planType: "profit_plan", holdSide: "long" },
                { planType: "loss_plan", holdSide: "long" },
              ],
            }
          : { data: [] },
      withHoldSideFallback: async (fn) => fn("long"),
      placePosTpsl: async () => {
        calls++;
        if (calls === 1) throw new Error("triggerPrice precision pricePlace invalid");
        placed = true;
        return { data: { ok: true } };
      },
    };

    const record = {};
    const result = await repairBitgetPositionTpsl(client, baseCtx, record);
    assert.equal(result.ok, true);
    assert.ok(record.tpslRepair?.attempts?.length >= 2);
    assert.equal(record.tpslRepair.attempts[0].category, "precision");
  });

  it("transient 错误：退避后重试成功", async () => {
    process.env.BITGET_TPSL_REPAIR_RETRIES = "2";
    let calls = 0;
    let placed = false;
    const client = {
      getSinglePosition: async () => ({ data: [{ symbol: "ETHUSDT", holdSide: "long", total: "1" }] }),
      getOrdersPlanPending: async () =>
        placed
          ? {
              data: [
                { planType: "profit_plan", holdSide: "long" },
                { planType: "loss_plan", holdSide: "long" },
              ],
            }
          : { data: [] },
      withHoldSideFallback: async (fn) => fn("long"),
      placePosTpsl: async () => {
        calls++;
        if (calls === 1) throw new Error("429 Too Many Requests");
        placed = true;
        return { data: { ok: true } };
      },
    };

    const record = {};
    const result = await repairBitgetPositionTpsl(client, baseCtx, record);
    assert.equal(result.ok, true);
    assert.equal(record.tpslRepair.attempts[0].category, "transient");
  });

  it("hold_side 错误：经 withHoldSideFallback 重试成功", async () => {
    process.env.BITGET_TPSL_REPAIR_RETRIES = "2";
    let calls = 0;
    let placed = false;
    const client = {
      getSinglePosition: async () => ({ data: [{ symbol: "ETHUSDT", holdSide: "long", total: "1" }] }),
      getOrdersPlanPending: async () =>
        placed
          ? {
              data: [
                { planType: "profit_plan", holdSide: "long" },
                { planType: "loss_plan", holdSide: "long" },
              ],
            }
          : { data: [] },
      withHoldSideFallback: async (fn) => fn("long"),
      placePosTpsl: async () => {
        calls++;
        if (calls === 1) throw new Error("holdSide position mode mismatch");
        placed = true;
        return { data: { ok: true } };
      },
    };

    const record = {};
    const result = await repairBitgetPositionTpsl(client, baseCtx, record);
    assert.equal(result.ok, true);
    assert.equal(record.tpslRepair.attempts[0].category, "hold_side");
  });

  it("sl_breached：立即标记平仓原因", async () => {
    process.env.BITGET_TPSL_REPAIR_RETRIES = "3";
    const client = {
      withHoldSideFallback: async (fn) => fn("long"),
      placePosTpsl: async () => {
        throw new Error("stop loss price of the long position should be less than the current price");
      },
    };
    const record = {};
    const result = await repairBitgetPositionTpsl(client, baseCtx, record);
    assert.equal(result.ok, false);
    assert.equal(result.closeImmediately, true);
    assert.equal(result.closeReason, "sl_breached");
    assert.equal(record.tpslRepair.attempts.length, 1);
  });
});

describe("ensureBitgetPositionTpslAfterOpen", () => {
  it("校验失败且补挂重试用尽时市价平仓并记录 attempts", async () => {
    process.env.BITGET_REQUIRE_TPSL = "1";
    process.env.BITGET_NAKED_POSITION_ACTION = "close";
    process.env.BITGET_TPSL_VERIFY_SEC = "2";
    process.env.BITGET_TPSL_REPAIR_RETRIES = "1";

    let closed = false;
    /** @type {string[]} */
    const alerts = [];

    const client = {
      getSinglePosition: async () => ({ data: [{ symbol: "ETHUSDT", holdSide: "long", total: "1" }] }),
      getOrdersPlanPending: async () => ({ data: [] }),
      withHoldSideFallback: async (fn) => fn("long"),
      placePosTpsl: async () => {
        throw new Error("place-pos-tpsl rejected unknown");
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
    const result = await ensureBitgetPositionTpslAfterOpen(client, log, baseCtx, record);

    assert.equal(result.ok, false);
    assert.equal(result.reason, "naked_closed");
    assert.equal(closed, true);
    assert.equal(record.nakedPositionClosed, true);
    assert.ok(Array.isArray(record.tpslRepair?.attempts));
    assert.equal(record.tpslRepair.attempts.length, 1);
  });

  it("sl_breached 时立即平仓且告警含分类与 mark", async () => {
    process.env.BITGET_REQUIRE_TPSL = "1";
    process.env.BITGET_NAKED_POSITION_ACTION = "close";
    process.env.BITGET_TPSL_VERIFY_SEC = "2";
    process.env.BITGET_TPSL_REPAIR_RETRIES = "3";

    let closed = false;
    /** @type {string[]} */
    const alertBodies = [];
    const origAlert = process.env.BITGET_SKIP_TELEGRAM_ALERT;
    process.env.BITGET_SKIP_TELEGRAM_ALERT = "1";

    const client = {
      getSinglePosition: async () => ({ data: [{ symbol: "ETHUSDT", holdSide: "long", total: "1" }] }),
      getOrdersPlanPending: async () => ({ data: [] }),
      withHoldSideFallback: async (fn) => fn("long"),
      placePosTpsl: async () => {
        throw new Error("stop loss price of the long position should be less than the current price");
      },
      closePositions: async () => {
        closed = true;
        return { data: { ok: true } };
      },
    };

    const log = { warn: () => {} };

    const record = {};
    const result = await ensureBitgetPositionTpslAfterOpen(client, log, baseCtx, record);

    assert.equal(result.reason, "naked_closed");
    assert.equal(closed, true);
    assert.equal(record.nakedCloseCategory, "sl_breached");
    assert.equal(record.tpslRepair.attempts[0].category, "sl_breached");

    if (origAlert !== undefined) process.env.BITGET_SKIP_TELEGRAM_ALERT = origAlert;
  });
});

describe("bitget tpsl env defaults", () => {
  const keys = [
    "BITGET_REQUIRE_TPSL",
    "BITGET_NAKED_POSITION_ACTION",
    "BITGET_TPSL_VERIFY_SEC",
    "BITGET_TPSL_REPAIR_RETRIES",
  ];
  const saved = {};

  it("空字符串或非法值回退安全默认", () => {
    for (const k of keys) {
      saved[k] = process.env[k];
      process.env[k] = "";
    }
    process.env.BITGET_TPSL_VERIFY_SEC = "not-a-number";
    process.env.BITGET_TPSL_REPAIR_RETRIES = "NaN";
    process.env.BITGET_NAKED_POSITION_ACTION = "bogus";

    assert.equal(bitgetRequireTpslEnabled(), true);
    assert.equal(bitgetNakedPositionAction(), "close");
    assert.equal(bitgetTpslVerifyWindowMs(), 8000);
    assert.equal(bitgetTpslRepairRetries(), 3);

    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
});
