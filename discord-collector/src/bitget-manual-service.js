/**
 * Bitget 手动下单：预览、下单、历史。
 */
import { config } from "./config.js";
import { createBitgetClient } from "./bitget-api.js";
import {
  calcBaseSize,
  parseBitgetContractMeta,
  resolveOrderLeverage,
  resolveBitgetOrderSize,
  roundUsdt2,
} from "./bitget-order-from-signal.js";
import { normalizeSymbol } from "./card-fields.js";
import { detectSymbolTier } from "./card-backtest-policy.js";
import { loadBitgetTradeConfig } from "./bitget-trade-config.js";
import { appendBitgetOrderHistory, listBitgetOrderHistory } from "./bitget-order-history.js";

/**
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 */
export function createBitgetManualService(log) {
  /** @returns {import("./bitget-api.js").BitgetCredentials | null} */
  function credentials() {
    const key = config.bitgetApiKey;
    const secret = config.bitgetApiSecret;
    const passphrase = config.bitgetPassphrase;
    if (!key || !secret || !passphrase) return null;
    return {
      apiKey: key,
      apiSecret: secret,
      passphrase,
      baseUrl: config.bitgetBaseUrl,
      timeoutMs: config.bitgetRequestTimeoutMs,
    };
  }

  /** @param {string} symbolInput @param {{ orderSizeUsdt?: number; leverage?: number }} [opts] */
  async function preview(symbolInput, opts = {}) {
    const symbol = normalizeSymbol(symbolInput);
    if (!symbol) return { ok: false, error: "invalid_symbol" };

    const tier = detectSymbolTier(symbol);
    const defaultLeverage = resolveOrderLeverage(symbol);
    const defaultOrderSizeUsdt = config.bitgetOrderSizeUsdt;
    const leverage = Number(opts.leverage) > 0 ? Number(opts.leverage) : defaultLeverage;
    const orderSizeUsdt = Number(opts.orderSizeUsdt) > 0 ? Number(opts.orderSizeUsdt) : defaultOrderSizeUsdt;
    const productType = "USDT-FUTURES";
    const tradeCfg = loadBitgetTradeConfig();

    /** @type {Record<string, unknown>} */
    const out = {
      ok: true,
      symbol,
      bareSymbol: symbol.replace(/USDT$/, ""),
      tier,
      tierLabel: tier === "major" ? "主流 (BTC/ETH)" : "山寨",
      defaultLeverage,
      defaultOrderSizeUsdt,
      leverage,
      orderSizeUsdt,
      productType,
      marginMode: tradeCfg.default.marginMode,
      dryRun: tradeCfg.dryRun,
      configured: Boolean(credentials()),
    };

    try {
      const creds = credentials();
      const client = creds ? createBitgetClient(creds) : createBitgetClient({ apiKey: "public", apiSecret: "public", passphrase: "public" });
      const ticker = await client.getMixTicker({ symbol, productType });
      const lastPrice = Number(ticker?.lastPr ?? ticker?.markPrice ?? 0);
      if (Number.isFinite(lastPrice) && lastPrice > 0) {
        out.lastPrice = lastPrice;
        let contractMeta = parseBitgetContractMeta(null);
        try {
          const contract = await client.getMixContract({ symbol, productType });
          contractMeta = parseBitgetContractMeta(contract);
          out.minTradeUsdt = contractMeta.minTradeUsdt;
          out.minTradeNum = contractMeta.minTradeNum;
        } catch {
          /* ignore */
        }
        const sized = resolveBitgetOrderSize(orderSizeUsdt, lastPrice, contractMeta, {
          dryRun: tradeCfg.dryRun,
          leverage,
        });
        const positionNotional = roundUsdt2(orderSizeUsdt * leverage);
        out.marginUsdt = orderSizeUsdt;
        out.positionNotionalUsdt = roundUsdt2(sized.positionNotionalUsdt ?? positionNotional);
        out.estimatedSize = sized.size ?? calcBaseSize(positionNotional, lastPrice, contractMeta);
        out.estimatedNotionalUsdt = roundUsdt2(sized.notionalUsdt ?? positionNotional);
        if (!sized.ok && sized.hint) out.sizeWarning = sized.hint;
        else if (sized.belowMinUsdt && tradeCfg.dryRun) {
          out.sizeWarning = `模拟模式：低于 Bitget 最小 ${contractMeta.minTradeUsdt || "—"} USDT，仅 dry-run 可提交`;
        }
      }
    } catch (e) {
      out.tickerError = String(/** @type {Error} */ (e).message ?? e);
    }

    return out;
  }

  /**
   * @param {{
   *   symbol: string;
   *   side: "buy" | "sell";
   *   orderType?: "market" | "limit";
   *   price?: string | number;
   *   orderSizeUsdt?: number;
   *   leverage?: number;
   *   stopLossPrice?: string;
   *   takeProfitPrice?: string;
   * }} body
   */
  async function placeOrder(body) {
    const symbol = normalizeSymbol(body.symbol);
    const side = body.side === "sell" ? "sell" : "buy";
    const orderType = body.orderType === "limit" ? "limit" : "market";
    if (!symbol) return { ok: false, error: "invalid_symbol" };

    const tradeCfg = loadBitgetTradeConfig();
    const dryRun = tradeCfg.dryRun;
    const productType = tradeCfg.default.productType;
    const marginMode = tradeCfg.default.marginMode;
    const marginCoin = "USDT";
    const leverage = Number(body.leverage) > 0 ? Number(body.leverage) : resolveOrderLeverage(symbol);
    const orderSizeUsdt = Number(body.orderSizeUsdt) > 0 ? Number(body.orderSizeUsdt) : config.bitgetOrderSizeUsdt;
    const holdSide = side === "buy" ? "long" : "short";

    const creds = credentials();
    if (!creds && !dryRun) return { ok: false, error: "credentials_missing" };

    let refPrice = Number(body.price);
    const client = createBitgetClient(
      creds ?? { apiKey: "public", apiSecret: "public", passphrase: "public" }
    );
    if (!Number.isFinite(refPrice) || refPrice <= 0) {
      const ticker = await client.getMixTicker({ symbol, productType });
      refPrice = Number(ticker?.lastPr ?? ticker?.markPrice ?? 0);
    }
    if (!Number.isFinite(refPrice) || refPrice <= 0) return { ok: false, error: "no_market_price" };

    let contractMeta = parseBitgetContractMeta(null);
    try {
      const contract = await client.getMixContract({ symbol, productType });
      contractMeta = parseBitgetContractMeta(contract);
    } catch {
      /* ignore */
    }

    const sizeResult = resolveBitgetOrderSize(orderSizeUsdt, refPrice, contractMeta, { dryRun, leverage });
    if (!sizeResult.ok) {
      return {
        ok: false,
        error: sizeResult.error,
        hint: sizeResult.hint,
        minTradeUsdt: sizeResult.minTradeUsdt,
        minTradeNum: sizeResult.minTradeNum,
      };
    }
    const size = sizeResult.size;

    /** @type {Record<string, unknown>} */
    const record = {
      source: "manual",
      symbol,
      side,
      holdSide,
      orderType,
      size,
      leverage,
      orderSizeUsdt,
      price: orderType === "limit" ? refPrice : null,
      fillPrice: refPrice,
      status: dryRun ? "dry_run" : "pending",
      stopLossPrice: body.stopLossPrice ?? null,
      takeProfitPrice: body.takeProfitPrice ?? null,
    };

    if (dryRun) {
      log.info(`[dry-run] 手动下单 ${symbol} ${side} ${orderType} size=${size} lev=${leverage}x`);
      record.status = "dry_run";
      appendBitgetOrderHistory(record);
      return { ok: true, dryRun: true, record };
    }

    if (!client) return { ok: false, error: "credentials_missing" };

    try {
      await client.ensureLeverage({ symbol, productType, marginCoin, leverage, holdSide, marginMode });
    } catch (e) {
      const errMsg = String(/** @type {Error} */ (e).message ?? e);
      record.status = "failed";
      record.error = errMsg;
      appendBitgetOrderHistory(record);
      return {
        ok: false,
        error: errMsg,
        hint: "杠杆未生效时，系统仍按高杠杆算仓位数量，交易所会用账户默认杠杆（常见 10x），保证金约为 名义÷10",
        record,
      };
    }

    try {
      const resp = await client.placeOrder({
        symbol,
        productType,
        marginMode,
        marginCoin,
        size,
        side,
        tradeSide: "open",
        orderType,
        price: orderType === "limit" ? String(refPrice) : undefined,
        clientOid: `manual-${Date.now()}`,
        presetStopLossPrice: body.stopLossPrice ? String(body.stopLossPrice) : undefined,
        presetStopSurplusPrice: body.takeProfitPrice ? String(body.takeProfitPrice) : undefined,
      });
      const data = resp && typeof resp === "object" && "data" in resp ? /** @type {Record<string, unknown>} */ (resp.data) : {};
      record.status = "placed";
      record.orderId = data.orderId ?? null;
      record.response = resp;
      appendBitgetOrderHistory(record);
      log.info(`手动下单 ${symbol} ${side} orderId=${record.orderId ?? "-"}`);
      return { ok: true, record };
    } catch (e) {
      const errMsg = String(/** @type {Error} */ (e).message ?? e);
      record.status = "failed";
      record.error = errMsg;
      appendBitgetOrderHistory(record);
      return { ok: false, error: errMsg, record };
    }
  }

  /** @param {{ limit?: number; symbol?: string; includeExchange?: boolean }} [opts] */
  async function listHistory(opts = {}) {
    const local = listBitgetOrderHistory({ limit: opts.limit, symbol: opts.symbol });
    /** @type {Array<Record<string, unknown>>} */
    let exchange = [];

    if (opts.includeExchange !== false && credentials()) {
      try {
        const client = createBitgetClient(credentials());
        const sym = opts.symbol ? normalizeSymbol(opts.symbol) : undefined;
        const resp = await client.getOrdersHistory({
          productType: "USDT-FUTURES",
          symbol: sym,
          pageSize: Math.min(50, Number(opts.limit ?? 50)),
        });
        const rows = Array.isArray(resp?.data?.entrustedList)
          ? resp.data.entrustedList
          : Array.isArray(resp?.data)
            ? resp.data
            : [];
        exchange = rows.map((r) => ({
          source: "exchange",
          .../** @type {Record<string, unknown>} */ (r),
        }));
      } catch (e) {
        log.debug(`Bitget 交易所历史拉取失败: ${/** @type {Error} */ (e).message}`);
      }
    }

    return {
      ok: true,
      local,
      exchange,
      dryRun: loadBitgetTradeConfig().dryRun,
    };
  }

  return { preview, placeOrder, listHistory };
}
