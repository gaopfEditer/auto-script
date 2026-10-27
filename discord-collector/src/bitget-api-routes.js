/**
 * Bitget 自动下单 / 手动下单 API。
 */
import { loadBitgetTradeConfig } from "./bitget-trade-config.js";
import { signalChannelDisplayName } from "./discord-signal-config.js";
import { config } from "./config.js";
import { getBitgetProxyInUse } from "./bitget-api.js";
import { isShortDirection } from "./card-direction.js";

/**
 * @param {import("express").Express} app
 * @param {ReturnType<typeof import("./bitget-order-service.js").createBitgetOrderService>} bitgetOrder
 * @param {ReturnType<typeof import("./bitget-manual-service.js").createBitgetManualService>} bitgetManual
 */
export function registerBitgetRoutes(app, bitgetOrder, bitgetManual) {
  app.get("/api/bitget/status", (_req, res) => {
    const status = bitgetOrder.getStatus();
    const cfg = loadBitgetTradeConfig();
    const channels = Object.entries(cfg.channels)
      .filter(([, c]) => c.enabled !== false)
      .map(([id, c]) => ({
        channelId: id,
        name: c.name ?? signalChannelDisplayName(id),
        leverage: c.leverage ?? cfg.default.leverage,
        orderSizeUsdt: c.orderSizeUsdt ?? cfg.default.orderSizeUsdt,
        orderType: c.orderType ?? cfg.default.orderType,
      }));
    res.json({
      ok: true,
      ...status,
      dryRun: cfg.dryRun,
      orderSizeUsdt: config.bitgetOrderSizeUsdt,
      majorLeverage: config.bitgetMajorLeverage,
      altcoinLeverage: config.bitgetAltcoinLeverage,
      proxy: getBitgetProxyInUse() || null,
      channels,
    });
  });

  app.get("/api/bitget/preview", async (req, res) => {
    const symbol = String(req.query.symbol ?? "").trim();
    if (!symbol) {
      res.status(400).json({ ok: false, error: "symbol_required" });
      return;
    }
    const orderSizeUsdt = Number(req.query.orderSizeUsdt);
    const leverage = Number(req.query.leverage);
    try {
      const result = await bitgetManual.preview(symbol, {
        orderSizeUsdt: Number.isFinite(orderSizeUsdt) && orderSizeUsdt > 0 ? orderSizeUsdt : undefined,
        leverage: Number.isFinite(leverage) && leverage > 0 ? leverage : undefined,
      });
      if (!result.ok) {
        res.status(400).json(result);
        return;
      }
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.post("/api/bitget/order", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const symbol = String(body.symbol ?? "").trim();
    let side = String(body.side ?? "").trim().toLowerCase();
    if (!side && body.direction) {
      side = isShortDirection(body.direction) ? "sell" : "buy";
    }
    if (!symbol || (side !== "buy" && side !== "sell")) {
      res.status(400).json({ ok: false, error: "symbol_and_side_required" });
      return;
    }
    try {
      const result = await bitgetManual.placeOrder({
        symbol,
        side: /** @type {"buy"|"sell"} */ (side),
        orderType: body.orderType === "limit" ? "limit" : "market",
        price: body.price,
        orderSizeUsdt: body.orderSizeUsdt,
        leverage: body.leverage,
        stopLossPrice: body.stopLossPrice != null ? String(body.stopLossPrice) : undefined,
        takeProfitPrice: body.takeProfitPrice != null ? String(body.takeProfitPrice) : undefined,
      });
      if (!result.ok) {
        res.status(result.error === "credentials_missing" ? 503 : 400).json(result);
        return;
      }
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.get("/api/bitget/orders", async (req, res) => {
    const limit = Math.min(100, Math.max(1, Number(req.query.limit) || 50));
    const symbol = String(req.query.symbol ?? "").trim();
    const includeExchange = req.query.exchange !== "0";
    try {
      const result = await bitgetManual.listHistory({ limit, symbol, includeExchange });
      res.json(result);
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  });

  app.post("/api/bitget/reload", (_req, res) => {
    const cfg = bitgetOrder.reloadConfig();
    res.json({
      ok: true,
      enabled: cfg.enabled,
      dryRun: cfg.dryRun,
      liveTrading: !cfg.dryRun,
      channelKeys: Object.keys(cfg.channels),
      hint: cfg.dryRun ? "仍为模拟；.env 设 BITGET_DRY_RUN=0 后 POST /api/bitget/reload" : "已切换实盘",
    });
  });

  app.post("/api/bitget/test-connection", async (_req, res) => {
    const result = await bitgetOrder.testConnection();
    if (!result.ok) {
      res.status(result.error === "credentials_missing" ? 503 : 500).json({ ok: false, ...result });
      return;
    }
    res.json({ ok: true, ...result });
  });
}
