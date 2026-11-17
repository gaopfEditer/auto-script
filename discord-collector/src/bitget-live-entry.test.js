import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { config } from "./config.js";
import { buildBitgetOrderPlan, resolveBitgetLeverage, resolveBitgetOrderSize } from "./bitget-order-from-signal.js";

describe("bitget live entry defaults", () => {
  it("自动开仓默认 1U 保证金、20x，市价，信号止损优先，否则 5%", () => {
    const prev = {
      major: config.bitgetMajorLeverage,
      alt: config.bitgetAltcoinLeverage,
      def: config.bitgetDefaultLeverage,
      size: config.bitgetOrderSizeUsdt,
      sl: config.bitgetInitialSlPct,
    };
    config.bitgetMajorLeverage = 20;
    config.bitgetAltcoinLeverage = 20;
    config.bitgetDefaultLeverage = 20;
    config.bitgetOrderSizeUsdt = 1;
    config.bitgetInitialSlPct = 5;
    try {
      assert.equal(resolveBitgetLeverage("BTC"), 20);
      assert.equal(resolveBitgetLeverage("ETHUSDT"), 20);
      assert.equal(resolveBitgetLeverage("SOL"), 20);

      const sized = resolveBitgetOrderSize(1, 100, undefined, { leverage: 20, dryRun: true });
      assert.equal(sized.ok, true);
      if (!sized.ok) return;
      assert.equal(sized.marginUsdt, 1);
      assert.equal(sized.leverage, 20);
      assert.equal(sized.positionNotionalUsdt, 20);

      /** @type {const} */
      const channel = {
        leverage: 20,
        orderSizeUsdt: 1,
        orderType: "limit",
        marginMode: "crossed",
        productType: "USDT-FUTURES",
        initialSlPct: 5,
      };

      const fallback = buildBitgetOrderPlan({
        cardId: 7,
        parsed: { symbol: "SOL", direction: "long", entry: "100" },
        channelTrade: channel,
      });
      assert.equal(fallback.ok, true);
      if (!fallback.ok) return;
      assert.equal(fallback.plan.orderType, "market");
      assert.equal(fallback.plan.price, null);
      assert.equal(fallback.plan.leverage, 20);
      assert.equal(fallback.plan.orderSizeUsdt, 1);
      assert.equal(fallback.plan.stopLossPrice, "95");
      assert.equal(fallback.plan.takeProfitPrice, null);

      const signal = buildBitgetOrderPlan({
        cardId: 8,
        parsed: { symbol: "SOL", direction: "long", entry: "100", stopLoss: "97", takeProfits: ["110"] },
        executionJson: { planned: { stopLossPrice: "", entryPrice: "100", takeProfitPrices: [] } },
        channelTrade: channel,
      });
      assert.equal(signal.ok, true);
      if (!signal.ok) return;
      assert.equal(signal.plan.stopLossPrice, "97");
      assert.equal(signal.plan.takeProfitPrice, "110");
      assert.equal(signal.plan.leverage, 20);
      assert.equal(signal.plan.orderSizeUsdt, 1);

      const blocked = buildBitgetOrderPlan({
        cardId: 9,
        parsed: { symbol: "SOL", direction: "long", entry: "100", stopLoss: "110" },
        channelTrade: channel,
      });
      assert.equal(blocked.ok, false);
      if (blocked.ok) return;
      assert.equal(blocked.reason, "missing_stop_loss");
    } finally {
      config.bitgetMajorLeverage = prev.major;
      config.bitgetAltcoinLeverage = prev.alt;
      config.bitgetDefaultLeverage = prev.def;
      config.bitgetOrderSizeUsdt = prev.size;
      config.bitgetInitialSlPct = prev.sl;
    }
  });
});
