import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  resolveOpenTpslPrices,
  placeBitgetOpenWithPresets,
  ensureBitgetPositionTpslAfterOpen,
  repairBitgetPositionTpsl,
  classifyBitgetTpslRepairError,
  sendBitgetTradeTelegramAlert,
  resolveRepairTpslLevels,
  isValidTakeProfit,
  isValidStopLoss,
  roundBitgetTriggerPrice,
  sanitizeBitgetOpenPresetPrices,
  sanitizeBitgetTriggerPrice,
  enrichBitgetContractMeta,
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

  it("识别 preset/execute 参数错误", () => {
    const err =
      "Bitget HTTP 400: The parameter does not meet the specification presetSLExcutePrice must than 0";
    assert.equal(classifyBitgetTpslRepairError(err, "long"), "request_param");
  });
});

describe("resolveRepairTpslLevels", () => {
  it("信号 SL 仍有效但严于 initialSlPct 时放宽止损", () => {
    const r = resolveRepairTpslLevels({
      mark: 3500,
      holdSide: "long",
      direction: "做多",
      initialSlPct: 4.3,
      signalStopLossStr: "3400",
      signalTakeProfitStr: "3800",
      sizeStr: "1",
    });
    assert.equal(r.stopLossStr, "3349.5");
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
  it("信号没有止损时按 5% 计算，且不发明止盈", () => {
    const r = resolveOpenTpslPrices({
      parsed: { direction: "做多", signalPhase: "open" },
      fillPrice: 100,
      direction: "做多",
      initialSlPct: 5,
      preserveSignalStop: true,
      allowMissingTakeProfit: true,
    });
    assert.equal(r.takeProfitStr, "");
    assert.equal(r.stopLossStr, "95");
    assert.ok(isValidStopLoss(100, r.stopLossPrice, "long"));
  });

  it("空的 planned.stopLossPrice 不会盖掉信号止损", () => {
    const r = resolveOpenTpslPrices({
      parsed: { direction: "做多", stopLoss: "97", entry: "100" },
      executionJson: { planned: { stopLossPrice: "", entryPrice: "100", takeProfitPrices: [] } },
      fillPrice: 100,
      direction: "做多",
      initialSlPct: 5,
      preserveSignalStop: true,
      allowMissingTakeProfit: true,
    });
    assert.equal(r.stopLossStr, "97");
  });

  it("信号止损比 5% 更紧时仍用信号价", () => {
    const r = resolveOpenTpslPrices({
      parsed: { direction: "做多", stopLoss: "99" },
      fillPrice: 100,
      direction: "做多",
      initialSlPct: 5,
      preserveSignalStop: true,
      allowMissingTakeProfit: true,
    });
    assert.equal(r.stopLossStr, "99");
  });
});

describe("placeBitgetOpenWithPresets", () => {
  it("预设被拒后仍只重试带止损的市价单", async () => {
    /** @type {Record<string, unknown>[]} */
    const placeCalls = [];
    let mark = 100;
    let failOnce = true;

    const client = {
      placeOrder: async (body) => {
        placeCalls.push(body);
        if (!body.presetStopLossPrice) throw new Error("must have stop");
        if (failOnce) {
          failOnce = false;
          mark = 102;
          throw new Error("stop loss price should be less than current price");
        }
        return { data: { orderId: "oid-1" } };
      },
    };

    const result = await placeBitgetOpenWithPresets(client, {
      openBase: { symbol: "SOLUSDT", side: "buy", size: "1", orderType: "limit", price: "100" },
      symbol: "SOLUSDT",
      productType: "USDT-FUTURES",
      marginCoin: "USDT",
      holdSide: "long",
      direction: "做多",
      size: "1",
      initialSlPct: 5,
      parsed: { direction: "做多", stopLoss: "90", takeProfits: ["110"] },
      fetchMark: async () => mark,
      maxPresetAttempts: 2,
    });

    assert.equal(result.ok, true);
    assert.equal(placeCalls.length, 2);
    for (const body of placeCalls) {
      assert.equal(body.orderType, "market");
      assert.equal(body.price, undefined);
      assert.equal(body.presetStopLossPrice, "90");
      assert.equal(body.presetStopSurplusPrice, "110");
      assert.equal(body.presetStopLossExecutePrice, "90");
    }
  });

  it("信号没有止盈时仍下市价单，且只带 5% 止损", async () => {
    /** @type {Record<string, unknown> | null} */
    let body = null;
    const client = {
      placeOrder: async (b) => {
        body = b;
        return { data: { orderId: "oid-sl-only" } };
      },
    };
    const result = await placeBitgetOpenWithPresets(client, {
      openBase: { symbol: "SOLUSDT", side: "buy", size: "0.2", orderType: "limit", price: "100" },
      symbol: "SOLUSDT",
      productType: "USDT-FUTURES",
      marginCoin: "USDT",
      holdSide: "long",
      direction: "做多",
      size: "0.2",
      initialSlPct: 5,
      parsed: { direction: "做多" },
      fetchMark: async () => 100,
      maxPresetAttempts: 1,
    });
    assert.equal(result.ok, true);
    assert.equal(body?.orderType, "market");
    assert.equal(body?.presetStopLossPrice, "95");
    assert.equal(body?.presetStopSurplusPrice, undefined);
    assert.equal(body?.presetStopLossExecutePrice, "95");
  });

  it("止损相对标记价无效时不发送市价单", async () => {
    let calls = 0;
    const client = {
      placeOrder: async () => {
        calls += 1;
        return { data: { orderId: "should-not" } };
      },
    };
    const result = await placeBitgetOpenWithPresets(client, {
      openBase: { symbol: "SOLUSDT", side: "buy", size: "1" },
      symbol: "SOLUSDT",
      productType: "USDT-FUTURES",
      marginCoin: "USDT",
      holdSide: "long",
      direction: "做多",
      size: "1",
      initialSlPct: 5,
      parsed: { direction: "做多", stopLoss: "110" },
      fetchMark: async () => 100,
      maxPresetAttempts: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "stop_loss_unavailable");
    assert.equal(result.orderSent, false);
    assert.equal(calls, 0);
  });

  it("没有标记价时不发送市价单", async () => {
    let calls = 0;
    const client = {
      placeOrder: async () => {
        calls += 1;
        return { data: { orderId: "should-not" } };
      },
    };
    const result = await placeBitgetOpenWithPresets(client, {
      openBase: { symbol: "SOLUSDT", side: "buy", size: "1" },
      symbol: "SOLUSDT",
      productType: "USDT-FUTURES",
      marginCoin: "USDT",
      holdSide: "long",
      direction: "做多",
      size: "1",
      initialSlPct: 5,
      parsed: { direction: "做多" },
      fetchMark: async () => null,
      maxPresetAttempts: 1,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, "stop_loss_unavailable");
    assert.equal(calls, 0);
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

  it("补挂 placePosTpsl 携带与触发价一致且 >0 的执行价", async () => {
    process.env.BITGET_TPSL_REPAIR_RETRIES = "1";
    /** @type {Record<string, unknown>[]} */
    const payloads = [];
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
      placePosTpsl: async (p) => {
        payloads.push(p);
        placed = true;
        return { data: { ok: true } };
      },
    };
    const record = {};
    const result = await repairBitgetPositionTpsl(client, baseCtx, record);
    assert.equal(result.ok, true);
    assert.equal(payloads.length, 1);
    const p = payloads[0];
    assert.equal(p.stopLossExecutePrice, p.stopLossTriggerPrice);
    assert.equal(p.stopSurplusExecutePrice, p.stopSurplusTriggerPrice);
    assert.ok(Number(p.stopLossExecutePrice) > 0);
    assert.ok(Number(p.stopSurplusExecutePrice) > 0);
  });

  it("request_param 用尽时不触发裸仓平仓", async () => {
    process.env.BITGET_REQUIRE_TPSL = "1";
    process.env.BITGET_NAKED_POSITION_ACTION = "close";
    process.env.BITGET_TPSL_VERIFY_SEC = "2";
    process.env.BITGET_TPSL_REPAIR_RETRIES = "2";

    let closed = false;
    const client = {
      getSinglePosition: async () => ({ data: [{ symbol: "ETHUSDT", holdSide: "long", total: "1" }] }),
      getOrdersPlanPending: async () => ({ data: [] }),
      withHoldSideFallback: async (fn) => fn("long"),
      placePosTpsl: async () => {
        throw new Error("presetSLExcutePrice must than 0");
      },
      closePositions: async () => {
        closed = true;
        return { data: { ok: true } };
      },
    };
    const log = { warn: () => {} };
    const record = {};
    const result = await ensureBitgetPositionTpslAfterOpen(client, log, baseCtx, record);
    assert.equal(result.ok, true);
    assert.equal(result.reason, "stop_unconfirmed_kept");
    assert.equal(closed, false);
    assert.notEqual(record.nakedPositionClosed, true);
    assert.equal(record.tpslRepair?.closeReason, "request_param_exhausted");
  });

  it("sl_breached：按最新标记价重算止损并重试，不立即平仓", async () => {
    process.env.BITGET_TPSL_REPAIR_RETRIES = "3";
    let calls = 0;
    const client = {
      getMixTicker: async () => ({ markPrice: "3500" }),
      getMixContract: async () => ({ pricePlace: "1", priceEndStep: "1" }),
      getSinglePosition: async () => ({ data: [{ symbol: "ETHUSDT", holdSide: "long", total: "1" }] }),
      getOrdersPlanPending: async () => ({ data: [] }),
      withHoldSideFallback: async (fn) => fn("long"),
      placePosTpsl: async () => {
        calls += 1;
        if (calls < 3) {
          throw new Error("stop loss price of the long position should be less than the current price");
        }
        return { data: { ok: true } };
      },
    };
    const record = {};
    const result = await repairBitgetPositionTpsl(client, baseCtx, record);
    assert.equal(result.closeImmediately, false);
    assert.ok(calls >= 2);
    assert.ok(record.tpslRepair.attempts.length >= 2);
    assert.ok(record.tpslRepair.attempts.some((a) => a.category === "sl_breached"));
  });
});

describe("ensureBitgetPositionTpslAfterOpen", () => {
  it("校验失败且补挂重试用尽时不平仓", async () => {
    process.env.BITGET_REQUIRE_TPSL = "1";
    process.env.BITGET_NAKED_POSITION_ACTION = "close";
    process.env.BITGET_TPSL_VERIFY_SEC = "2";
    process.env.BITGET_TPSL_REPAIR_RETRIES = "1";

    let closed = 0;
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
        closed += 1;
        return { data: { ok: true } };
      },
    };

    const log = {
      warn: (msg) => alerts.push(String(msg)),
    };

    const record = { presetStopLossPrice: "3000" };
    const result = await ensureBitgetPositionTpslAfterOpen(client, log, baseCtx, record);

    assert.equal(result.ok, true);
    assert.equal(result.reason, "stop_unconfirmed_kept");
    assert.equal(closed, 0);
    assert.notEqual(record.nakedPositionClosed, true);
    assert.notEqual(record.status, "naked_closed");
    assert.ok(Array.isArray(record.tpslRepair?.attempts));
    assert.equal(record.tpslRepair.attempts.length, 1);
    assert.ok(alerts.some((m) => m.includes("不平仓")));
  });

  it("sl_breached 补挂失败时不因穿越止损立即市价平仓", async () => {
    process.env.BITGET_REQUIRE_TPSL = "1";
    process.env.BITGET_NAKED_POSITION_ACTION = "close";
    process.env.BITGET_TPSL_VERIFY_SEC = "2";
    process.env.BITGET_TPSL_REPAIR_RETRIES = "2";

    let closed = false;

    const client = {
      getMixTicker: async () => ({ markPrice: "3500" }),
      getMixContract: async () => ({ pricePlace: "1", priceEndStep: "1" }),
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

    assert.equal(closed, false);
    assert.equal(result.ok, true);
    assert.equal(result.reason, "stop_unconfirmed_kept");
    assert.notEqual(record.nakedPositionClosed, true);
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
    assert.equal(bitgetNakedPositionAction(), "skip");
    process.env.BITGET_NAKED_POSITION_ACTION = "close";
    assert.equal(bitgetNakedPositionAction(), "skip");
    assert.equal(bitgetTpslVerifyWindowMs(), 8000);
    assert.equal(bitgetTpslRepairRetries(), 3);

    for (const k of keys) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
});

describe("roundBitgetTriggerPrice", () => {
  it("WLD 浮点尾数按 pricePlace=4、endStep=1 收成 0.0001 的倍数", () => {
    const meta = { pricePlace: 4, priceEndStep: 1 };
    const rounded = roundBitgetTriggerPrice(0.40015500000000004, meta);
    assert.equal(rounded, "0.4002");
    assert.equal(/0{5,}/.test(rounded), false);
    assert.equal(roundBitgetTriggerPrice(1.23456, meta), "1.2346");
  });

  it("UAI pricePlace=5 收到 0.00001", () => {
    assert.equal(roundBitgetTriggerPrice(0.012345678, { pricePlace: 5, priceEndStep: 1 }), "0.01235");
  });

  it("RUNE pricePlace=4 收到 0.0001", () => {
    assert.equal(roundBitgetTriggerPrice(0.61234, { pricePlace: 4, priceEndStep: 1 }), "0.6123");
  });

  it("把 10-30 文案识别为精度错误", () => {
    assert.equal(
      classifyBitgetTpslRepairError("The price you enter should be a multiple of 0.0001", "long"),
      "precision"
    );
    assert.equal(
      classifyBitgetTpslRepairError("Parameter verification exception 0.40015500000000004", "long"),
      "precision"
    );
  });
});

describe("live regression float tails (VVV/HOT/PYTH)", () => {
  it("VVVUSDT 空单 5% 止损浮点尾数按 pricePlace=3 tick=0.001 对齐", () => {
    const entry = 19.126;
    const rawSl = entry * 1.05;
    const meta = enrichBitgetContractMeta({ pricePlace: "3", priceEndStep: "1" });
    const rounded = sanitizeBitgetOpenPresetPrices({
      stopLossRaw: String(rawSl),
      takeProfitRaw: "18",
      meta,
      holdSide: "short",
    });
    assert.equal(rounded.stopLossStr, "20.083");
    assert.match(rounded.stopLossStr, /^\d+(\.\d+)?$/);
    assert.equal(rounded.stopLossStr.includes("000000000"), false);
  });

  it("HOTUSDT 触发价须为 0.0000001 的倍数", () => {
    const meta = enrichBitgetContractMeta({ pricePlace: "7", priceEndStep: "1" });
    const rounded = sanitizeBitgetTriggerPrice(0.00040574499999999994, meta, 0, { mode: "ceil" });
    assert.equal(rounded, "0.0004058");
    const scaled = Number(rounded) / 0.0000001;
    assert.equal(Number.isInteger(scaled), true);
  });

  it("PYTHUSDT 5% 空单止损 0.071862… 收到 0.00001 tick", () => {
    const raw = 0.06844 * 1.05;
    const meta = enrichBitgetContractMeta({ pricePlace: "5", priceEndStep: "1" });
    const sl = sanitizeBitgetOpenPresetPrices({
      stopLossRaw: String(raw),
      takeProfitRaw: "0.06",
      meta,
      holdSide: "short",
    }).stopLossStr;
    assert.equal(sl, "0.07187");
    assert.equal((Number(sl) / 0.00001) % 1, 0);
  });

  it("resolveOpenTpslPrices 结合合约 meta 产出已 tick 对齐字符串", () => {
    const meta = enrichBitgetContractMeta({ pricePlace: "5", priceEndStep: "1" });
    const r = resolveOpenTpslPrices({
      parsed: { direction: "做空" },
      fillPrice: 0.06844,
      direction: "做空",
      initialSlPct: 5,
      contractMeta: meta,
    });
    assert.equal(r.stopLossStr, "0.07187");
    assert.equal(r.takeProfitStr, "0.06501");
  });
});

describe("placeBitgetOpenWithPresets tick", () => {
  it("没有信号止损时 5% 止损按 tick 取整，且不附带发明的止盈", async () => {
    /** @type {string[]} */
    const bodies = [];
    const client = {
      getMixContract: async () => ({ pricePlace: "4", priceEndStep: "1" }),
      placeOrder: async (body) => {
        bodies.push(JSON.stringify(body));
        return { data: { orderId: "1" } };
      },
    };
    const result = await placeBitgetOpenWithPresets(client, {
      openBase: { symbol: "WLDUSDT", side: "buy", size: "2" },
      symbol: "WLDUSDT",
      productType: "USDT-FUTURES",
      marginCoin: "USDT",
      holdSide: "long",
      direction: "做多",
      size: "2",
      initialSlPct: 5,
      parsed: { direction: "做多" },
      fetchMark: async () => 0.42,
    });
    assert.equal(result.ok, true);
    assert.equal(bodies.length, 1);
    const body = JSON.parse(bodies[0]);
    assert.equal(body.orderType, "market");
    assert.equal(body.presetStopLossPrice, "0.399");
    assert.equal(body.presetStopSurplusPrice, undefined);
    assert.equal(body.presetStopLossExecutePrice, "0.399");
    assert.ok(Number(body.presetStopLossExecutePrice) > 0);
  });

  it("信号止损和止盈按 tick 取整后跟市价单一起送出", async () => {
    /** @type {Record<string, unknown>[]} */
    const bodies = [];
    const client = {
      getMixContract: async () => ({ pricePlace: "4", priceEndStep: "1" }),
      placeOrder: async (body) => {
        bodies.push(body);
        return { data: { orderId: "1" } };
      },
    };
    const result = await placeBitgetOpenWithPresets(client, {
      openBase: { symbol: "WLDUSDT", side: "buy", size: "2", orderType: "limit", price: "0.42" },
      symbol: "WLDUSDT",
      productType: "USDT-FUTURES",
      marginCoin: "USDT",
      holdSide: "long",
      direction: "做多",
      size: "2",
      initialSlPct: 5,
      parsed: {
        direction: "做多",
        stopLoss: "0.40015500000000004",
        takeProfits: ["0.451234567"],
      },
      executionJson: { planned: { stopLossPrice: "", takeProfitPrices: [], entryPrice: "" } },
      fetchMark: async () => 0.42,
    });
    assert.equal(result.ok, true);
    assert.equal(bodies.length, 1);
    const body = bodies[0];
    assert.equal(body.orderType, "market");
    assert.equal(body.price, undefined);
    assert.equal(body.presetStopLossPrice, "0.4001");
    assert.equal(body.presetStopSurplusPrice, "0.4513");
    assert.equal(body.presetStopLossExecutePrice, "0.4001");
    assert.equal(body.presetStopSurplusExecutePrice, "0.4513");
  });
});

describe("sendBitgetTradeTelegramAlert", () => {
  it("不向 Telegram 群发送 Bitget 操作结果", async () => {
    let warnCount = 0;
    await sendBitgetTradeTelegramAlert(
      { warn: () => warnCount++ },
      "Bitget 裸仓已平 / KGENUSDT long card=#2603"
    );
    assert.equal(warnCount, 0);
  });
});
