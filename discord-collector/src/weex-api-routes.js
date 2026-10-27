/**
 * WEEX 自动交易 API（状态 / 热加载 / 连通测试）。
 */
import { config } from "./config.js";
import { getWeexProxyInUse } from "./weex-api.js";
import { loadWeexTradeConfig, refreshWeexEnvFromDotenv, readWeexDryRunFromEnv } from "./weex-trade-config.js";

/** @param {import("express").Express} app @param {ReturnType<typeof import("./weex-order-service.js").createWeexOrderService>} weexOrder */
export function registerWeexRoutes(app, weexOrder) {
  app.get("/api/weex/status", (_req, res) => {
    const status = weexOrder.getStatus();
    const cfg = loadWeexTradeConfig();
    res.json({
      ok: true,
      ...status,
      orderSizeUsdt: config.bitgetOrderSizeUsdt,
      majorLeverage: config.bitgetMajorLeverage,
      altcoinLeverage: config.bitgetAltcoinLeverage,
      initialSlPct: config.bitgetInitialSlPct,
      proxy: getWeexProxyInUse() || null,
      tradeParamsSource: "BITGET_* (共用保证金/杠杆/止损参数)",
    });
  });

  app.post("/api/weex/reload", (_req, res) => {
    refreshWeexEnvFromDotenv();
    const cfg = weexOrder.reloadConfig();
    res.json({
      ok: true,
      dryRun: readWeexDryRunFromEnv(),
      enabled: cfg.enabled,
      hint: cfg.dryRun ? "仍为模拟；.env 设 WEEX_DRY_RUN=0 或 BITGET_DRY_RUN=0 后 POST /api/weex/reload" : "已切换实盘",
    });
  });

  app.post("/api/weex/test-connection", async (_req, res) => {
    const result = await weexOrder.testConnection();
    res.json(result);
  });
}
