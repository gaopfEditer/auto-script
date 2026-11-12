import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { normalizeExecution } from "./discord-signal-execution.js";
import {
  prepareAutoTradeForOrder,
  telegramTradeRequiresStopLoss,
} from "./telegram-auto-trade.js";

describe("prepareAutoTradeForOrder", () => {
  it("有数字入场时用该价按 5% SL / 默认 TP 下单（不用信号止损）", async () => {
    const parsed = {
      symbol: "RUNE",
      direction: "long",
      entry: "0.041",
      stopLoss: "0.0394",
      takeProfits: ["0.04258", "0.0451"],
    };
    const execution = normalizeExecution(
      { entryPrice: "", stopLossPrice: "", takeProfitPrices: [] },
      parsed
    );
    const out = await prepareAutoTradeForOrder(parsed, execution, "RUNE", {
      fetchPrice: async () => {
        throw new Error("proxy down");
      },
    });
    assert.equal(telegramTradeRequiresStopLoss(out.execution), true);
    assert.equal(out.parsed.tradeTpslFromMark, true);
    assert.ok(Math.abs(Number(out.parsed.stopLoss) - 0.041 * 0.95) < 1e-8);
  });

  it("市价且有方向时用注入价格补默认止损", async () => {
    const parsed = { symbol: "WLD", direction: "long", entry: "市价" };
    const execution = normalizeExecution(null, parsed);
    const out = await prepareAutoTradeForOrder(parsed, execution, "WLD", {
      fetchPrice: async () => ({ price: 2.5 }),
    });
    assert.equal(telegramTradeRequiresStopLoss(out.execution), true);
    const sl = Number(out.parsed.stopLoss);
    assert.ok(Math.abs(sl - 2.5 * 0.95) < 1e-8);
    assert.ok(out.parsed.takeProfits.length >= 1);
  });

  it("正文有止损也会被实时价规则覆盖", async () => {
    const parsed = {
      symbol: "RUNE",
      direction: "long",
      entry: "0.041",
      rawContent: "止盈：0.04258—0.0451 / 止损：0.0394",
    };
    const execution = normalizeExecution(
      { entryPrice: "", stopLossPrice: "", takeProfitPrices: [] },
      parsed
    );
    const out = await prepareAutoTradeForOrder(parsed, execution, "RUNE", {
      fetchPrice: async () => {
        throw new Error("no network");
      },
    });
    assert.equal(out.parsed.tradeTpslFromMark, true);
    assert.ok(Math.abs(Number(out.parsed.stopLoss) - 0.041 * 0.95) < 1e-8);
    assert.equal(telegramTradeRequiresStopLoss(out.execution), true);
  });
});

describe("normalizeExecution flat aliases", () => {
  it("扁平 entry/stopLoss/targets 写入 planned", () => {
    const ex = normalizeExecution({
      entry: "0.041",
      stopLoss: "0.0394",
      targets: ["0.04258", "0.0451"],
    });
    assert.equal(ex.planned.entryPrice, "0.041");
    assert.equal(ex.planned.stopLossPrice, "0.0394");
    assert.deepEqual(ex.planned.takeProfitPrices, ["0.04258", "0.0451"]);
  });
});
