/**

 * Bitget Mix v2 REST API（HMAC 签名）。

 * @see https://www.bitget.com/api-doc/contract/trade/Place-Order

 */

import crypto from "node:crypto";

import { ProxyAgent, request } from "undici";

import { config } from "./config.js";



/**

 * @typedef {{

 *   apiKey: string;

 *   apiSecret: string;

 *   passphrase: string;

 *   baseUrl?: string;

 *   timeoutMs?: number;

 *   proxy?: string;

 * }} BitgetCredentials

 */



/** @type {Map<string, import("undici").Dispatcher>} */

const dispatcherCache = new Map();



/** @param {string} [proxyUrl] */

function getBitgetDispatcher(proxyUrl) {

  const proxy =

    String(proxyUrl ?? config.bitgetProxy ?? "").trim() ||

    String(config.webhookForwardProxy ?? "").trim();

  if (!proxy) return undefined;

  let d = dispatcherCache.get(proxy);

  if (!d) {

    d = new ProxyAgent(proxy);

    dispatcherCache.set(proxy, d);

  }

  return d;

}



/** @param {unknown} err */

function wrapBitgetNetworkError(err) {

  const code = err && typeof err === "object" && "code" in err ? String(err.code) : "";

  if (code === "ECONNRESET" || code === "ETIMEDOUT" || code === "ECONNREFUSED") {

    const proxyHint = config.bitgetProxy || config.webhookForwardProxy;

    return new Error(

      `Bitget 网络连接失败 (${code})${proxyHint ? "" : "，请在 .env 设置 COMMON_PROXY 或 BITGET_PROXY（如 http://127.0.0.1:7890）"}`

    );

  }

  return err instanceof Error ? err : new Error(String(err));

}



/**

 * @param {BitgetCredentials} creds

 */

export function createBitgetClient(creds) {

  const baseUrl = (creds.baseUrl ?? config.bitgetBaseUrl ?? "https://api.bitget.com").replace(/\/$/, "");

  const timeoutMs = creds.timeoutMs ?? config.bitgetRequestTimeoutMs ?? 15_000;

  const dispatcher = getBitgetDispatcher(creds.proxy);



  /**

   * @param {string} url

   * @param {import("undici").Dispatcher.RequestOptions} opts

   */

  async function httpRequest(url, opts) {

    try {

      return await request(url, {

        ...opts,

        dispatcher,

        headersTimeout: timeoutMs,

        bodyTimeout: timeoutMs,

      });

    } catch (e) {

      throw wrapBitgetNetworkError(e);

    }

  }



  /**

   * @param {"GET"|"POST"} method

   * @param {string} requestPath

   * @param {Record<string, string | number | undefined>} [query]

   * @param {Record<string, unknown> | null} [body]

   */

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



    const url = `${baseUrl}${requestPath}${qs}`;

    const res = await httpRequest(url, {

      method,

      headers: {

        "ACCESS-KEY": creds.apiKey,

        "ACCESS-SIGN": sign,

        "ACCESS-TIMESTAMP": timestamp,

        "ACCESS-PASSPHRASE": creds.passphrase,

        "Content-Type": "application/json",

        locale: "en-US",

      },

      body: method === "POST" && bodyStr ? bodyStr : undefined,

    });



    const text = await res.body.text();

    let json = null;

    try {

      json = text ? JSON.parse(text) : null;

    } catch {

      json = { raw: text };

    }



    if (res.statusCode >= 400) {

      const msg = json && typeof json === "object" && "msg" in json ? String(json.msg) : text.slice(0, 200);

      throw new Error(`Bitget HTTP ${res.statusCode}: ${msg}`);

    }

    if (json && typeof json === "object" && "code" in json && String(json.code) !== "00000") {

      throw new Error(`Bitget API ${json.code}: ${String(json.msg ?? "unknown")}`);

    }

    return json;

  }



  return {

    /** @param {{ symbol: string; productType: string; marginCoin: string; marginMode?: string; leverage?: number; holdSide?: string; longLeverage?: number; shortLeverage?: number }} p */
    async setLeverage(p) {
      /** @type {Record<string, string>} */
      const body = {
        symbol: p.symbol,
        productType: p.productType,
        marginCoin: p.marginCoin,
      };
      if (p.marginMode) body.marginMode = p.marginMode;
      if (p.leverage != null) body.leverage = String(p.leverage);
      if (p.longLeverage != null) body.longLeverage = String(p.longLeverage);
      if (p.shortLeverage != null) body.shortLeverage = String(p.shortLeverage);
      if (p.holdSide) body.holdSide = p.holdSide;
      return signedRequest("POST", "/api/v2/mix/account/set-leverage", null, body);
    },

    /** @param {{ symbol: string; productType: string; marginCoin: string }} p */
    async getMixAccount(p) {
      return signedRequest("GET", "/api/v2/mix/account/account", {
        symbol: p.symbol,
        productType: p.productType,
        marginCoin: p.marginCoin,
      }, null);
    },

    /**
     * 下单前确保杠杆生效（兼容单向/双向、全仓/逐仓）。
     * @param {{ symbol: string; productType: string; marginCoin: string; leverage: number; holdSide?: "long"|"short"; marginMode?: string }} p
     */
    async ensureLeverage(p) {
      const lev = Number(p.leverage);
      const marginMode = p.marginMode === "crossed" ? "crossed" : "isolated";
      const base = {
        symbol: p.symbol,
        productType: p.productType,
        marginCoin: p.marginCoin,
        marginMode,
      };
      const holdSide = p.holdSide === "short" ? "short" : p.holdSide === "long" ? "long" : undefined;
      /** @type {Error[]} */
      const errors = [];

      const trySet = async (payload) => {
        try {
          await this.setLeverage(payload);
          return true;
        } catch (e) {
          errors.push(/** @type {Error} */ (e));
          return false;
        }
      };

      /** @type {Array<Record<string, unknown>>} */
      const attempts =
        marginMode === "crossed"
          ? [{ ...base, leverage: lev }]
          : [
              { ...base, leverage: lev },
              ...(holdSide ? [{ ...base, leverage: lev, holdSide }] : []),
              ...(holdSide === "long" ? [{ ...base, longLeverage: lev, holdSide: "long" }] : []),
              ...(holdSide === "short" ? [{ ...base, shortLeverage: lev, holdSide: "short" }] : []),
              { ...base, longLeverage: lev, shortLeverage: lev },
            ];

      for (const payload of attempts) {
        if (!(await trySet(payload))) continue;
        try {
          const resp = await this.getMixAccount(base);
          const data = resp?.data && typeof resp.data === "object" ? /** @type {Record<string, unknown>} */ (resp.data) : null;
          if (data) {
            const accountMode = String(data.marginMode ?? marginMode);
            let actual = 0;
            if (accountMode === "crossed") {
              actual = Number(data.crossMarginLeverage ?? data.leverage ?? 0);
            } else if (holdSide === "short") {
              actual = Number(data.shortLeverage ?? data.shortLeveage ?? 0);
            } else {
              actual = Number(data.longLeverage ?? data.leverage ?? 0);
            }
            if (actual > 0 && Math.abs(actual - lev) > 0.01) {
              throw new Error(`杠杆校验失败：期望 ${lev}x，账户实际 ${actual}x (${accountMode})`);
            }
          }
        } catch (e) {
          const msg = String(/** @type {Error} */ (e).message ?? e);
          if (msg.includes("杠杆校验失败")) throw e;
        }
        return;
      }

      const detail = errors.map((e) => e.message).join(" | ");
      throw new Error(`设置杠杆 ${lev}x 失败: ${detail || "unknown"}`);
    },



    /**

     * @param {{

     *   symbol: string;

     *   productType: string;

     *   marginMode: string;

     *   marginCoin: string;

     *   size: string;

     *   side: "buy" | "sell";

     *   tradeSide: "open" | "close";

     *   orderType: "limit" | "market";

     *   price?: string;

     *   force?: string;

     *   clientOid?: string;

     *   presetStopSurplusPrice?: string;

     *   presetStopLossPrice?: string;

     * }} p

     */

    async placeOrder(p) {

      /** @type {Record<string, unknown>} */

      const body = {

        symbol: p.symbol,

        productType: p.productType,

        marginMode: p.marginMode,

        marginCoin: p.marginCoin,

        size: p.size,

        side: p.side,

        tradeSide: p.tradeSide,

        orderType: p.orderType,

        force: p.force ?? "gtc",

        clientOid: p.clientOid,

      };

      if (p.orderType === "limit" && p.price) body.price = p.price;

      if (p.presetStopSurplusPrice) body.presetStopSurplusPrice = p.presetStopSurplusPrice;

      if (p.presetStopLossPrice) body.presetStopLossPrice = p.presetStopLossPrice;

      return signedRequest("POST", "/api/v2/mix/order/place-order", null, body);

    },



    async ping() {

      return signedRequest("GET", "/api/v2/spot/public/time", null, null);

    },



    /** @param {{ symbol: string; productType: string }} p */

    async getMixTicker(p) {

      const url = `${baseUrl}/api/v2/mix/market/ticker?symbol=${encodeURIComponent(p.symbol)}&productType=${encodeURIComponent(p.productType)}`;

      const res = await httpRequest(url, { method: "GET" });

      const text = await res.body.text();

      let json = null;

      try {

        json = text ? JSON.parse(text) : null;

      } catch {

        json = null;

      }

      if (json && typeof json === "object" && "code" in json && String(json.code) !== "00000") {

        throw new Error(`Bitget ticker ${json.code}: ${String(json.msg ?? "unknown")}`);

      }

      const row = Array.isArray(json?.data) ? json.data[0] : json?.data;

      return row;

    },



    /** @param {{ symbol: string; productType: string }} p */

    async getMixContract(p) {

      const url = `${baseUrl}/api/v2/mix/market/contracts?symbol=${encodeURIComponent(p.symbol)}&productType=${encodeURIComponent(p.productType)}`;

      const res = await httpRequest(url, { method: "GET" });

      const text = await res.body.text();

      let json = null;

      try {

        json = text ? JSON.parse(text) : null;

      } catch {

        json = null;

      }

      if (json && typeof json === "object" && "code" in json && String(json.code) !== "00000") {

        throw new Error(`Bitget contract ${json.code}: ${String(json.msg ?? "unknown")}`);

      }

      const row = Array.isArray(json?.data) ? json.data[0] : json?.data;

      return row;

    },

    /**
     * @param {{
     *   symbol: string;
     *   productType: string;
     *   marginCoin: string;
     *   planType: "profit_plan" | "loss_plan";
     *   triggerPrice: string;
     *   triggerType?: string;
     *   executePrice?: string;
     *   holdSide: "long" | "short";
     *   size: string;
     *   clientOid?: string;
     * }} p
     */
    async placeTpslOrder(p) {
      const body = {
        symbol: p.symbol,
        productType: p.productType,
        marginCoin: p.marginCoin,
        planType: p.planType,
        triggerPrice: p.triggerPrice,
        triggerType: p.triggerType ?? "mark_price",
        executePrice: p.executePrice ?? p.triggerPrice,
        holdSide: p.holdSide,
        size: p.size,
        clientOid: p.clientOid,
      };
      return signedRequest("POST", "/api/v2/mix/order/place-tpsl-order", null, body);
    },

    /**
     * 仓位止盈止损（可覆盖开仓 preset SL，支持分批止盈数量）。
     * @param {{
     *   symbol: string;
     *   productType: string;
     *   marginCoin: string;
     *   holdSide: string;
     *   stopSurplusTriggerPrice?: string;
     *   stopSurplusSize?: string;
     *   stopLossTriggerPrice?: string;
     *   stopLossSize?: string;
     *   stopSurplusClientOid?: string;
     *   stopLossClientOid?: string;
     * }} p
     */
    async placePosTpsl(p) {
      /** @type {Record<string, string>} */
      const body = {
        symbol: p.symbol,
        productType: p.productType,
        marginCoin: p.marginCoin,
        holdSide: p.holdSide,
      };
      if (p.stopSurplusTriggerPrice) {
        body.stopSurplusTriggerPrice = p.stopSurplusTriggerPrice;
        body.stopSurplusTriggerType = "mark_price";
        body.stopSurplusExecutePrice = "0";
        if (p.stopSurplusSize) body.stopSurplusSize = p.stopSurplusSize;
      }
      if (p.stopLossTriggerPrice) {
        body.stopLossTriggerPrice = p.stopLossTriggerPrice;
        body.stopLossTriggerType = "mark_price";
        body.stopLossExecutePrice = "0";
        if (p.stopLossSize) body.stopLossSize = p.stopLossSize;
      }
      if (p.stopSurplusClientOid) body.stopSurplusClientOid = p.stopSurplusClientOid;
      if (p.stopLossClientOid) body.stopLossClientOid = p.stopLossClientOid;
      return signedRequest("POST", "/api/v2/mix/order/place-pos-tpsl", null, body);
    },

    /**
     * 兼容单向持仓 holdSide=buy/sell 与双向 long/short。
     * @param {(holdSide: string) => Promise<unknown>} fn
     * @param {string} holdSide
     */
    async withHoldSideFallback(fn, holdSide) {
      try {
        return await fn(holdSide);
      } catch (e) {
        const alt =
          holdSide === "long" ? "buy" : holdSide === "short" ? "sell" : holdSide === "buy" ? "long" : holdSide === "sell" ? "short" : "";
        if (!alt) throw e;
        return await fn(alt);
      }
    },



    /** @param {{ symbol: string; productType: string; holdSide?: "long" | "short" }} p */

    async closePositions(p) {

      return signedRequest("POST", "/api/v2/mix/order/close-positions", null, {

        symbol: p.symbol,

        productType: p.productType,

        holdSide: p.holdSide,

      });

    },



    /**

     * @param {{

     *   productType: string;

     *   symbol?: string;

     *   pageSize?: number;

     *   startTime?: string;

     *   endTime?: string;

     * }} q

     */

    async getOrdersHistory(q) {

      return signedRequest("GET", "/api/v2/mix/order/orders-history", {

        productType: q.productType,

        symbol: q.symbol,

        pageSize: q.pageSize ?? 50,

        startTime: q.startTime,

        endTime: q.endTime,

      }, null);

    },



    /** @param {{ productType: string; symbol?: string }} q */

    async getOrdersPending(q) {

      return signedRequest("GET", "/api/v2/mix/order/orders-pending", {

        productType: q.productType,

        symbol: q.symbol,

      }, null);

    },

  };

}



/** @returns {string} */

export function getBitgetProxyInUse() {

  return String(config.bitgetProxy || config.webhookForwardProxy || "").trim();

}


