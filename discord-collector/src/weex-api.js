/**
 * WEEX 合约 V3 REST API（HMAC SHA256 + Base64 签名）。
 * @see https://www.weex.com/api-doc/contract/Transaction_API/PlaceOrder
 */
import crypto from "node:crypto";
import { ProxyAgent, request } from "undici";

import { config } from "./config.js";

/** @typedef {{ apiKey: string; apiSecret: string; passphrase: string; baseUrl?: string; timeoutMs?: number; proxy?: string }} WeexCredentials */

/** @type {Map<string, import("undici").Dispatcher>} */
const dispatcherCache = new Map();

/** @param {string} [proxyUrl] */
function resolveWeexProxyUrl(proxyUrl) {
  return (
    String(proxyUrl ?? config.weexProxy ?? "").trim() || String(config.webhookForwardProxy ?? "").trim()
  );
}

/** @param {string} [proxyUrl] */
function getWeexDispatcher(proxyUrl) {
  const proxy = resolveWeexProxyUrl(proxyUrl);
  if (!proxy) return undefined;
  let d = dispatcherCache.get(proxy);
  if (!d) {
    d = new ProxyAgent(proxy);
    dispatcherCache.set(proxy, d);
  }
  return d;
}

/** @param {string} [proxyUrl] */
function invalidateWeexDispatcher(proxyUrl) {
  const proxy = resolveWeexProxyUrl(proxyUrl);
  if (proxy) dispatcherCache.delete(proxy);
}

/** @param {unknown} err @param {string} [proxyUrl] */
function wrapWeexNetworkError(err, proxyUrl) {
  const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";
  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED") {
    const proxy = proxyUrl || resolveWeexProxyUrl();
    const hint = proxy
      ? `（经代理 ${proxy}，连接被重置/超时；请确认 Clash/V2Ray 等代理端口可用，或检查 COMMON_PROXY / WEEX_PROXY）`
      : "，请在 .env 设置 COMMON_PROXY 或 WEEX_PROXY（如 http://127.0.0.1:7890）";
    return new Error(`WEEX 网络连接失败 (${code})${hint}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}

/** @param {unknown} raw */
function unwrapWeexRows(raw) {
  if (Array.isArray(raw)) return raw;
  if (raw && typeof raw === "object") {
    const o = /** @type {Record<string, unknown>} */ (raw);
    if (Array.isArray(o.data)) return o.data;
    if (Array.isArray(o.symbols)) return o.symbols;
    if ("symbol" in o) return [o];
  }
  return [];
}

/** @param {unknown} raw */
export function parseWeexContractMeta(raw) {
  if (!raw || typeof raw !== "object") {
    return {
      minTradeNum: 0,
      minTradeUsdt: 0,
      volumePlace: 3,
      sizeMultiplier: 0,
      maxLeverage: 0,
      minLeverage: 1,
      pricePrecision: 2,
      priceStep: 0.01,
    };
  }
  const o = /** @type {Record<string, unknown>} */ (raw);
  const pricePrecision = Number(o.pricePrecision ?? 2);
  const tickSize = Number(o.tick_size ?? 0);
  const priceStep =
    tickSize > 0 ? tickSize : 10 ** -(Number.isFinite(pricePrecision) && pricePrecision >= 0 ? pricePrecision : 2);
  return {
    minTradeNum: Number(o.minOrderSize ?? 0) || 0,
    minTradeUsdt: 0,
    volumePlace: Number(o.quantityPrecision ?? 3) || 3,
    sizeMultiplier: 0,
    maxLeverage: Number(o.maxLeverage ?? 0) || 0,
    minLeverage: Number(o.minLeverage ?? 1) || 1,
    pricePrecision: Number.isFinite(pricePrecision) && pricePrecision >= 0 ? pricePrecision : 2,
    priceStep,
  };
}

/**
 * WEEX 价格按 tick/step 对齐（如 stepSize 0.01 → 533.75525 → 533.76）。
 * @param {number|string} price
 * @param {{ pricePrecision?: number; priceStep?: number }} [contractMeta]
 */
export function formatWeexPrice(price, contractMeta = {}) {
  const n = Number(price);
  if (!Number.isFinite(n) || n <= 0) return "";
  const step =
    Number(contractMeta.priceStep) > 0
      ? Number(contractMeta.priceStep)
      : 10 ** -(Number(contractMeta.pricePrecision ?? 2) || 2);
  const rounded = Math.round(n / step) * step;
  const places =
    Number(contractMeta.pricePrecision) >= 0
      ? Number(contractMeta.pricePrecision)
      : Math.max(0, (String(step).split(".")[1] ?? "").length);
  const fixed = rounded.toFixed(places);
  if (step >= 1) return fixed.replace(/\.?0+$/, "") || fixed;
  return fixed;
}

/** @param {Record<string, unknown>} cfg @param {"CROSSED"|"ISOLATED"} marginType @param {"long"|"short"} holdSide */
function readWeexActualLeverage(cfg, marginType, holdSide) {
  if (marginType === "CROSSED") return Number(cfg.crossLeverage ?? 0);
  if (holdSide === "short") return Number(cfg.isolatedShortLeverage ?? cfg.isolatedLongLeverage ?? 0);
  return Number(cfg.isolatedLongLeverage ?? cfg.isolatedShortLeverage ?? 0);
}

/** @param {WeexCredentials} creds */
export function createWeexClient(creds) {
  const baseUrl = (creds.baseUrl ?? config.weexBaseUrl ?? "https://api-contract.weex.com").replace(/\/$/, "");
  const timeoutMs = creds.timeoutMs ?? config.weexRequestTimeoutMs ?? 15_000;
  const proxyUrl = resolveWeexProxyUrl(creds.proxy);

  /** @param {string} url @param {import("undici").Dispatcher.RequestOptions} opts */
  async function httpRequest(url, opts) {
    const maxAttempts = 3;
    /** @type {unknown} */
    let lastErr = null;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const dispatcher = getWeexDispatcher(creds.proxy);
        return await request(url, { ...opts, dispatcher, headersTimeout: timeoutMs, bodyTimeout: timeoutMs });
      } catch (e) {
        lastErr = e;
        const code = e && typeof e === "object" && "code" in e ? String(e.code) : "";
        const retryable = ["ECONNRESET", "ETIMEDOUT", "ECONNREFUSED", "UND_ERR_CONNECT_TIMEOUT"].includes(code);
        if (attempt < maxAttempts && retryable) {
          if (code === "ECONNRESET") invalidateWeexDispatcher(creds.proxy);
          await new Promise((r) => setTimeout(r, 400 * attempt));
          continue;
        }
        throw wrapWeexNetworkError(e, proxyUrl);
      }
    }
    throw wrapWeexNetworkError(lastErr, proxyUrl);
  }

  /** @param {"GET"|"POST"|"DELETE"} method @param {string} requestPath @param {Record<string, string | number | undefined>} [query] @param {Record<string, unknown> | null} [body] */
  async function signedRequest(method, requestPath, query, body) {
    const timestamp = String(Date.now());
    const qs =
      query && Object.keys(query).length
        ? `?${new URLSearchParams(
            Object.entries(query)
              .filter(([, v]) => v != null && v !== "")
              .map(([k, v]) => [k, String(v)])
          ).toString()}`
        : "";
    const bodyStr = body ? JSON.stringify(body) : "";
    const prehash = timestamp + method.toUpperCase() + requestPath + qs + bodyStr;
    const sign = crypto.createHmac("sha256", creds.apiSecret).update(prehash).digest("base64");

    const res = await httpRequest(`${baseUrl}${requestPath}${qs}`, {
      method,
      headers: {
        "ACCESS-KEY": creds.apiKey,
        "ACCESS-SIGN": sign,
        "ACCESS-TIMESTAMP": timestamp,
        "ACCESS-PASSPHRASE": creds.passphrase,
        "Content-Type": "application/json",
        locale: "en-US",
      },
      body: method !== "GET" && bodyStr ? bodyStr : undefined,
    });

    const text = await res.body.text();
    /** @type {unknown} */
    let json = null;
    try {
      json = text ? JSON.parse(text) : null;
    } catch {
      json = { raw: text };
    }

    if (res.statusCode >= 400) {
      const msg =
        json && typeof json === "object" && json !== null && "msg" in json
          ? String(/** @type {Record<string, unknown>} */ (json).msg)
          : json && typeof json === "object" && json !== null && "errorMessage" in json
            ? String(/** @type {Record<string, unknown>} */ (json).errorMessage)
            : text.slice(0, 300);
      throw new Error(`WEEX HTTP ${res.statusCode}: ${msg}`);
    }

    if (json && typeof json === "object" && json !== null) {
      const o = /** @type {Record<string, unknown>} */ (json);
      if ("success" in o && o.success === false) {
        throw new Error(`WEEX API: ${String(o.errorMessage ?? o.errorCode ?? "unknown")}`);
      }
      if ("code" in o && o.code != null && !["200", "00000", "0"].includes(String(o.code))) {
        throw new Error(`WEEX API ${o.code}: ${String(o.msg ?? "unknown")}`);
      }
    }

    return json;
  }

  /** @param {Record<string, string | number | undefined>} [query] */
  async function publicGet(requestPath, query) {
    const qs =
      query && Object.keys(query).length
        ? `?${new URLSearchParams(
            Object.entries(query)
              .filter(([, v]) => v != null && v !== "")
              .map(([k, v]) => [k, String(v)])
          ).toString()}`
        : "";
    const res = await httpRequest(`${baseUrl}${requestPath}${qs}`, { method: "GET" });
    const text = await res.body.text();
    return text ? JSON.parse(text) : null;
  }

  return {
    /** @param {{ symbol: string }} p */
    async getTicker24h(p) {
      const raw = await publicGet("/capi/v3/market/ticker/24hr", { symbol: p.symbol });
      if (Array.isArray(raw)) return raw[0] ?? null;
      return raw;
    },

    /** @param {{ symbol: string }} p */
    async getContractInfo(p) {
      const raw = await publicGet("/capi/v3/market/exchangeInfo", { symbol: p.symbol });
      const symbols = raw?.symbols;
      if (Array.isArray(symbols) && symbols.length) return symbols[0];
      return null;
    },

    /** @param {{ symbol: string }} p */
    async getSymbolAccountConfig(p) {
      const raw = await signedRequest("GET", "/capi/v3/account/symbolConfig", { symbol: p.symbol }, null);
      const row = unwrapWeexRows(raw)[0];
      return row && typeof row === "object" ? /** @type {Record<string, unknown>} */ (row) : null;
    },

    /** @param {{ symbol: string; marginMode?: string }} p */
    async ensureMarginType(p) {
      const marginType = p.marginMode === "isolated" ? "ISOLATED" : "CROSSED";
      await signedRequest("POST", "/capi/v3/account/marginType", null, {
        symbol: p.symbol,
        marginType,
        separatedType: "COMBINED",
      });
    },

    /**
     * 下单前确保杠杆生效（兼容全仓/逐仓、账户已有配置）。
     * @param {{ symbol: string; marginMode?: string; leverage: number; holdSide?: "long"|"short" }} p
     * @returns {Promise<{ leverage: number; marginType: "CROSSED"|"ISOLATED" }>}
     */
    async ensureLeverage(p) {
      let lev = Math.max(1, Math.floor(Number(p.leverage)));
      const holdSide = p.holdSide === "short" ? "short" : "long";
      const wantMargin = p.marginMode === "isolated" ? "ISOLATED" : "CROSSED";

      try {
        const info = await this.getContractInfo({ symbol: p.symbol });
        const maxLev = Number(info?.maxLeverage ?? 0);
        if (maxLev > 0 && lev > maxLev) lev = maxLev;
      } catch {
        /* 公共接口失败时仍尝试设置 */
      }

      const levStr = String(lev);

      try {
        await this.ensureMarginType({ symbol: p.symbol, marginMode: p.marginMode });
      } catch {
        /* 有持仓或已是目标模式时会失败，后续按账户实际模式设置杠杆 */
      }

      /** @type {Record<string, unknown> | null} */
      let cfg = null;
      try {
        cfg = await this.getSymbolAccountConfig({ symbol: p.symbol });
      } catch {
        /* ignore */
      }

      const effectiveMargin =
        String(cfg?.marginType ?? wantMargin).toUpperCase() === "CROSSED" ? "CROSSED" : "ISOLATED";

      /** @type {Array<Record<string, string>>} */
      const attempts = [];
      if (effectiveMargin === "CROSSED") {
        attempts.push({ symbol: p.symbol, marginType: "CROSSED", crossLeverage: levStr });
      } else {
        attempts.push({
          symbol: p.symbol,
          marginType: "ISOLATED",
          isolatedLongLeverage: levStr,
          isolatedShortLeverage: levStr,
        });
        if (holdSide === "long") {
          attempts.push({ symbol: p.symbol, marginType: "ISOLATED", isolatedLongLeverage: levStr });
        } else {
          attempts.push({ symbol: p.symbol, marginType: "ISOLATED", isolatedShortLeverage: levStr });
        }
      }
      attempts.push({ symbol: p.symbol, marginType: wantMargin, crossLeverage: levStr });
      attempts.push({
        symbol: p.symbol,
        marginType: wantMargin,
        isolatedLongLeverage: levStr,
        isolatedShortLeverage: levStr,
      });
      attempts.push({ symbol: p.symbol, crossLeverage: levStr });
      attempts.push({ symbol: p.symbol, isolatedLongLeverage: levStr, isolatedShortLeverage: levStr });

      /** @type {string[]} */
      const errors = [];
      /** @type {Set<string>} */
      const seen = new Set();

      for (const body of attempts) {
        const key = JSON.stringify(body);
        if (seen.has(key)) continue;
        seen.add(key);

        try {
          const resp = await signedRequest("POST", "/capi/v3/account/leverage", null, body);
          const respRow = resp && typeof resp === "object" ? /** @type {Record<string, unknown>} */ (resp) : null;
          const appliedMargin =
            String(respRow?.marginType ?? cfg?.marginType ?? effectiveMargin).toUpperCase() === "CROSSED"
              ? "CROSSED"
              : "ISOLATED";
          const actualFromResp = respRow ? readWeexActualLeverage(respRow, appliedMargin, holdSide) : 0;
          if (actualFromResp > 0 && Math.abs(actualFromResp - lev) <= 0.01) {
            return { leverage: actualFromResp, marginType: appliedMargin };
          }

          try {
            const after = await this.getSymbolAccountConfig({ symbol: p.symbol });
            if (after) {
              const mt =
                String(after.marginType ?? appliedMargin).toUpperCase() === "CROSSED" ? "CROSSED" : "ISOLATED";
              const actual = readWeexActualLeverage(after, mt, holdSide);
              if (actual > 0 && Math.abs(actual - lev) <= 0.01) return { leverage: actual, marginType: mt };
            }
          } catch {
            /* ignore verify */
          }

          return { leverage: lev, marginType: appliedMargin };
        } catch (e) {
          errors.push(String(/** @type {Error} */ (e).message ?? e));
        }
      }

      throw new Error(errors.join(" | ") || "set leverage failed");
    },

    /** @param {{ symbol: string; side: "buy"|"sell"; holdSide: "long"|"short"; size: string; clientOid: string; slTriggerPrice?: string }} p */
    async placeMarketOrder(p) {
      const side = p.side === "sell" ? "SELL" : "BUY";
      const positionSide = p.holdSide === "short" ? "SHORT" : "LONG";
      /** @type {Record<string, string>} */
      const body = {
        symbol: p.symbol,
        side,
        positionSide,
        type: "MARKET",
        quantity: p.size,
        newClientOrderId: p.clientOid.slice(0, 36),
      };
      if (p.slTriggerPrice) {
        body.slTriggerPrice = p.slTriggerPrice;
        body.SlWorkingType = "MARK_PRICE";
      }
      return signedRequest("POST", "/capi/v3/order", null, body);
    },

    /** @param {{ symbol: string; holdSide: "long"|"short"; planType: "TAKE_PROFIT"|"STOP_LOSS"; triggerPrice: string; quantity?: string; clientOid: string }} p */
    async placeTpSlOrder(p) {
      const positionSide = p.holdSide === "short" ? "SHORT" : "LONG";
      const qty =
        p.quantity != null && String(p.quantity).trim() !== "" ? String(p.quantity).trim() : "0";
      /** @type {Record<string, string>} */
      const body = {
        symbol: p.symbol,
        clientAlgoId: p.clientOid.slice(0, 36),
        planType: p.planType,
        triggerPrice: p.triggerPrice,
        executePrice: "0",
        quantity: qty,
        positionSide,
        triggerPriceType: "MARK_PRICE",
      };

      const resp = await signedRequest("POST", "/capi/v3/placeTpSlOrder", null, body);
      const rows = Array.isArray(resp) ? resp : [resp];
      const row = rows[0];
      if (row && typeof row === "object" && row.success === false) {
        throw new Error(String(row.errorMessage ?? row.errorCode ?? "tpsl rejected"));
      }
      return row ?? resp;
    },

    /** @param {{ symbol: string }} p */
    async closePositions(p) {
      return signedRequest("POST", "/capi/v3/closePositions", null, { symbol: p.symbol });
    },

    async ping() {
      return publicGet("/capi/v3/market/ticker/24hr", { symbol: "BTCUSDT" });
    },
  };
}

export function getWeexProxyInUse() {
  return String(config.weexProxy || config.bitgetProxy || config.webhookForwardProxy || "").trim();
}
