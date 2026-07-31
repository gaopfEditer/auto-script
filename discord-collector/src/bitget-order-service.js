/**

 * 信号卡片建卡后 → Bitget 自动下单（含分阶段市价策略）。

 */

import { config } from "./config.js";

import { createBitgetClient } from "./bitget-api.js";

import { buildBitgetOrderPlan } from "./bitget-order-from-signal.js";

import {

  getBitgetTradeStatus,

  loadBitgetTradeConfig,

  resolveChannelBitgetTrade,

} from "./bitget-trade-config.js";

import {

  executeStagedMarketOpen,

  executeStagedReverse,

  executeStagedTpslUpdate,

  executeBitgetMoveSlToEntry,

  hasBitgetSymbolExposure,

} from "./bitget-staged-order.js";

import { isStagedTradeSignal } from "./discord-signal-staged-trade.js";

import { isAutoTradeExcludedMajorSymbol } from "./trade-platform-toggles.js";



/**

 * @param {ReturnType<typeof import("./store.js").openStore> extends Promise<infer S> ? S : never} store

 * @param {ReturnType<typeof import("./logger.js").createLogger>} log

 */

export function createBitgetOrderService(store, log) {

  let tradeCfg = loadBitgetTradeConfig();



  function reloadConfig() {

    tradeCfg = loadBitgetTradeConfig();

    return tradeCfg;

  }



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



  /**

   * @param {number} cardId

   * @param {Record<string, unknown>} parsed

   * @param {Record<string, unknown>} bitgetOrder

   */

  async function persistOrderResult(cardId, parsed, bitgetOrder) {

    if (!store?.updateSignalCard) return;

    const next = { ...parsed, bitgetOrder };

    try {

      await store.updateSignalCard(cardId, { parsedJson: next });

    } catch (e) {

      log.warn(`Bitget 下单结果写入卡片失败 #${cardId}: ${/** @type {Error} */ (e).message}`);

    }

  }



  /**

   * @param {{

   *   cardId: number;

   *   channelId: string;

   *   parsed: Record<string, unknown>;

   *   channelName?: string;

   *   resolved: NonNullable<ReturnType<typeof resolveChannelBitgetTrade>>;

   *   prevBitgetOrder?: Record<string, unknown> | null;

   *   isReverse?: boolean;

   * }} input

   */

  async function runStagedTrade(input) {

    const creds = credentials();

    if (!creds) {

      log.warn(`Bitget 未配置 API 密钥，跳过 card=#${input.cardId}`);

      return { skipped: "credentials_missing" };

    }



    const client = createBitgetClient(creds);

    const channelTrade = /** @type {Record<string, unknown>} */ ({ ...input.resolved.channel });

    const dryRun = input.resolved.dryRun;



    let result;

    if (input.isReverse && input.prevBitgetOrder) {

      result = await executeStagedReverse(client, {

        prevOrder: input.prevBitgetOrder,

        parsed: input.parsed,

        channelTrade,

        cardId: input.cardId,

        dryRun,

      });

    } else if (input.parsed.signalPhase === "open" || input.parsed.awaitingTpsl) {

      result = await executeStagedMarketOpen(client, {

        parsed: input.parsed,

        channelTrade,

        cardId: input.cardId,

        dryRun,

      });

    } else if (
      (input.parsed.signalPhase === "full" || input.parsed.signalPhase === "tpsl") &&
      input.prevBitgetOrder
    ) {
      result = await executeStagedTpslUpdate(client, {
        prevOrder: input.prevBitgetOrder,
        parsed: input.parsed,
        channelTrade,
        cardId: input.cardId,
        dryRun,
      });
    } else if (input.parsed.signalPhase === "full") {

      result = await executeStagedMarketOpen(client, {

        parsed: input.parsed,

        channelTrade,

        cardId: input.cardId,

        dryRun,

      });

      if (result.ok && result.record) {

        const tpsl = await executeStagedTpslUpdate(client, {

          prevOrder: result.record,

          parsed: input.parsed,

          channelTrade,

          cardId: input.cardId,

          dryRun,

        });

        if (tpsl.ok && tpsl.record) result.record = tpsl.record;

      }

    } else {

      return { skipped: "staged_phase_unknown" };

    }



    if (!result.ok) {

      log.warn(

        `Bitget 分阶段失败 card=#${input.cardId} reason=${result.reason} attempts=${result.attempts ?? "-"} err=${result.error ?? "-"}`

      );

      await persistOrderResult(input.cardId, input.parsed, {

        status: "failed",

        reason: result.reason,

        error: result.error ?? null,

        attempts: result.attempts ?? null,

        staged: true,

        at: new Date().toISOString(),

      });

      return { failed: true, reason: result.reason, error: result.error, attempts: result.attempts };

    }



    const record = {

      ...result.record,

      channelId: input.channelId,

      channelName: input.channelName ?? input.resolved.channel.name,

    };

    await persistOrderResult(input.cardId, input.parsed, record);

    log.info(

      `Bitget 分阶段 ${record.status} card=#${input.cardId} ${record.symbol ?? ""} ${input.isReverse ? "(反手)" : ""}${record.leverage ? ` lev=${record.leverage}x` : ""}${record.openAttempts ? ` attempts=${record.openAttempts}` : ""}`

    );

    if (record.status === "tpsl_partial" && record.tpslErrors) {

      log.warn(`Bitget TP/SL 部分失败 card=#${input.cardId}: ${JSON.stringify(record.tpslErrors)}`);

    }

    return { staged: true, record };

  }



  /**

   * @param {{

   *   cardId: number;

   *   channelId: string;

   *   parsed: Record<string, unknown>;

   *   executionJson: unknown;

   *   symbol?: string;

   *   channelName?: string;

   *   isReverse?: boolean;

   *   prevBitgetOrder?: Record<string, unknown> | null;

   *   linkedCardId?: number;

   * }} input

   */

  async function onSignalCardCreated(input) {

    reloadConfig();

    const resolved = resolveChannelBitgetTrade(input.channelId, tradeCfg);

    if (!resolved) return { skipped: "channel_not_configured" };




    const autoTradeSym = String(input.symbol ?? input.parsed?.symbol ?? "").trim();

    if (isAutoTradeExcludedMajorSymbol(autoTradeSym)) {

      log.info(`Bitget 跳过主流币自动交易 symbol=${autoTradeSym} card=#${input.cardId}`);

      return { skipped: "major_symbol_excluded", symbol: autoTradeSym };

    }

    if (isStagedTradeSignal(input.parsed) || resolved.channel.stagedTrade) {

      return runStagedTrade({

        cardId: input.cardId,

        channelId: input.channelId,

        parsed: input.parsed,

        channelName: input.channelName,

        resolved,

        isReverse: input.isReverse,

        prevBitgetOrder: input.prevBitgetOrder ?? null,

      });

    }



    const creds = credentials();

    if (!creds) {

      log.warn(`Bitget 未配置 API 密钥，跳过下单 card=#${input.cardId}`);

      return { skipped: "credentials_missing" };

    }



    const built = buildBitgetOrderPlan({

      parsed: input.parsed,

      executionJson: input.executionJson,

      channelTrade: resolved.channel,

      cardId: input.cardId,

    });



    if (!built.ok) {

      log.info(

        `Bitget 跳过 card=#${input.cardId} channel=${input.channelId} reason=${built.reason} symbol=${input.symbol ?? ""}`

      );

      await persistOrderResult(input.cardId, input.parsed, {

        status: "skipped",

        reason: built.reason,

        at: new Date().toISOString(),

      });

      return { skipped: built.reason };

    }



    const { plan } = built;

    /** @type {Record<string, unknown>} */

    const orderRecord = {

      status: resolved.dryRun ? "dry_run" : "pending",

      channelId: input.channelId,

      channelName: input.channelName ?? resolved.channel.name,

      plan: {

        symbol: plan.symbol,

        side: plan.side,

        orderType: plan.orderType,

        price: plan.price,

        size: plan.size,

        leverage: plan.leverage,

        takeProfitPrice: plan.takeProfitPrice,

        stopLossPrice: plan.stopLossPrice,

        orderSizeUsdt: plan.orderSizeUsdt,

      },

      at: new Date().toISOString(),

    };



    if (resolved.dryRun) {

      log.info(

        `[dry-run] Bitget 下单 card=#${input.cardId} ${plan.symbol} ${plan.side} size=${plan.size} price=${plan.price ?? "market"} lev=${plan.leverage}x`

      );

      orderRecord.status = "dry_run";

      await persistOrderResult(input.cardId, input.parsed, orderRecord);

      return { dryRun: true, plan };

    }



    const client = createBitgetClient(creds);

    try {

      await client.ensureLeverage({

        symbol: plan.symbol,

        productType: plan.productType,

        marginCoin: plan.marginCoin,

        leverage: plan.leverage,

        holdSide: plan.side === "buy" ? "long" : "short",

        marginMode: plan.marginMode,

      });

    } catch (e) {

      const errMsg = String(/** @type {Error} */ (e).message ?? e);

      log.warn(`Bitget 设置杠杆失败，取消下单: ${errMsg}`);

      await persistOrderResult(input.cardId, input.parsed, {

        status: "failed",

        reason: "set_leverage_failed",

        error: errMsg,

        at: new Date().toISOString(),

      });

      return { failed: true, reason: "set_leverage_failed", error: errMsg };

    }



    try {

      const holdSide = plan.side === "buy" ? "long" : "short";

      const maxAttempts = 3;

      /** @type {string[]} */

      const attemptErrors = [];

      let placedOk = false;

      let orderId = null;

      let lastResp = null;

      for (let attempt = 1; attempt <= maxAttempts; attempt++) {

        if (attempt > 1) {

          try {

            if (

              await hasBitgetSymbolExposure(client, {

                symbol: plan.symbol,

                productType: plan.productType,

                holdSide,

                marginCoin: plan.marginCoin,

              })

            ) {

              placedOk = true;

              orderRecord.openRecoveredFromQuery = true;

              break;

            }

          } catch {

            /* continue */

          }

          await new Promise((r) => setTimeout(r, 400 * attempt));

        }

        try {

          const clientOid = `${String(plan.clientOid)}-r${attempt}`.slice(0, 50);

          const resp = await client.placeOrder({

            symbol: plan.symbol,

            productType: plan.productType,

            marginMode: plan.marginMode,

            marginCoin: plan.marginCoin,

            size: plan.size,

            side: plan.side,

            tradeSide: plan.tradeSide,

            orderType: plan.orderType,

            price: plan.price != null ? String(plan.price) : undefined,

            clientOid,

            presetStopSurplusPrice: plan.takeProfitPrice ?? undefined,

            presetStopLossPrice: plan.stopLossPrice ?? undefined,

          });

          const data = resp && typeof resp === "object" && "data" in resp ? /** @type {Record<string, unknown>} */ (resp.data) : {};

          orderId = data.orderId ?? data.order_id ?? null;

          lastResp = resp;

          await new Promise((r) => setTimeout(r, 500 * attempt));

          const exposed = await hasBitgetSymbolExposure(client, {

            symbol: plan.symbol,

            productType: plan.productType,

            holdSide,

            marginCoin: plan.marginCoin,

          });

          if (exposed) {

            placedOk = true;

            orderRecord.status = "placed";

            orderRecord.orderId = orderId;

            orderRecord.clientOid = clientOid;

            orderRecord.response = resp;

            orderRecord.openAttempts = attempt;

            break;

          }

          attemptErrors.push(`attempt ${attempt}: api ok but no position/pending`);

        } catch (e) {

          attemptErrors.push(`attempt ${attempt}: ${String(/** @type {Error} */ (e).message ?? e)}`);

        }

      }

      if (!placedOk) {

        const errMsg = attemptErrors.join(" | ") || "place failed after retries";

        log.warn(`Bitget 下单失败（已重试 ${maxAttempts} 次） card=#${input.cardId}: ${errMsg}`);

        orderRecord.status = "failed";

        orderRecord.reason = "place_failed";

        orderRecord.error = errMsg;

        orderRecord.attempts = maxAttempts;

        await persistOrderResult(input.cardId, input.parsed, orderRecord);

        return { failed: true, reason: "place_failed", error: errMsg };

      }

      if (!orderRecord.status) {

        orderRecord.status = "placed";

        orderRecord.orderId = orderId;

        orderRecord.response = lastResp;

      }

      log.info(

        `Bitget 已下单 card=#${input.cardId} ${plan.symbol} ${plan.side} orderId=${orderRecord.orderId ?? "-"} attempts=${orderRecord.openAttempts ?? 1}`

      );

      await persistOrderResult(input.cardId, input.parsed, orderRecord);

      return { placed: true, orderId: orderRecord.orderId, plan };

    } catch (e) {

      const errMsg = String(/** @type {Error} */ (e).message ?? e);

      orderRecord.status = "failed";

      orderRecord.error = errMsg;

      log.warn(`Bitget 下单失败 card=#${input.cardId}: ${errMsg}`);

      await persistOrderResult(input.cardId, input.parsed, orderRecord);

      return { failed: true, error: errMsg };

    }

  }



  /**

   * @param {{

   *   cardId: number;

   *   channelId: string;

   *   parsed: Record<string, unknown>;

   *   channelName?: string;

   *   prevBitgetOrder?: Record<string, unknown> | null;

   * }} input

   */

  async function onTpslUpdate(input) {

    reloadConfig();

    const resolved = resolveChannelBitgetTrade(input.channelId, tradeCfg);

    if (!resolved) return { skipped: "channel_not_configured" };



    let prevBitget = input.prevBitgetOrder ?? null;

    if (!prevBitget || typeof prevBitget !== "object") {

      const card = await store.getSignalCardById?.(input.cardId);

      const prevParsed = card?.parsed_json ?? card?.parsedJson;

      if (prevParsed && typeof prevParsed === "object") {

        prevBitget = /** @type {Record<string, unknown>} */ (prevParsed).bitgetOrder ?? null;

      } else if (typeof prevParsed === "string") {

        try {

          prevBitget = JSON.parse(prevParsed)?.bitgetOrder ?? null;

        } catch {

          prevBitget = null;

        }

      }

    }



    if (!prevBitget || typeof prevBitget !== "object") {

      log.info(`Bitget TP/SL 更新跳过 card=#${input.cardId}：无开仓记录`);

      return { skipped: "no_open_order" };

    }



    return runStagedTrade({

      cardId: input.cardId,

      channelId: input.channelId,

      parsed: input.parsed,

      channelName: input.channelName,

      resolved,

      prevBitgetOrder: /** @type {Record<string, unknown>} */ (prevBitget),

    });

  }



  async function testConnection() {

    const creds = credentials();

    if (!creds) return { ok: false, error: "credentials_missing" };

    try {

      const client = createBitgetClient(creds);

      const resp = await client.ping();

      return { ok: true, response: resp };

    } catch (e) {

      return { ok: false, error: String(/** @type {Error} */ (e).message ?? e) };

    }

  }



  /**
   * TP1 触达 → 止损移至开仓价（保本）。
   * @param {{ cardId: number; parsed: Record<string, unknown>; dryRun?: boolean }} input
   */
  async function onTp1Breakeven(input) {
    const prev =
      input.parsed?.bitgetOrder && typeof input.parsed.bitgetOrder === "object"
        ? /** @type {Record<string, unknown>} */ (input.parsed.bitgetOrder)
        : null;
    if (!prev) return { skipped: "no_bitget_order" };

    const creds = credentials();
    if (!creds) return { skipped: "credentials_missing" };

    const dryRun =
      input.dryRun === true ||
      String(prev.status) === "dry_run" ||
      loadBitgetTradeConfig().dryRun === true;

    const client = createBitgetClient(creds);
    const result = await executeBitgetMoveSlToEntry(client, {
      prevOrder: prev,
      parsed: input.parsed,
      cardId: input.cardId,
      dryRun,
    });

    if (result.record) {
      await persistOrderResult(input.cardId, input.parsed, result.record);
    }
    if (result.ok && !result.skipped) {
      log.info(
        `Bitget TP1保本 card=#${input.cardId} ${result.record?.symbol ?? ""} SL→${result.record?.breakevenEntryPrice ?? ""}`
      );
    } else if (!result.ok) {
      log.warn(
        `Bitget TP1保本失败 card=#${input.cardId}: ${result.error ?? result.reason}`
      );
    }
    return result;
  }

  return {

    onSignalCardCreated,

    onTpslUpdate,

    onTp1Breakeven,

    reloadConfig,

    getStatus: getBitgetTradeStatus,

    testConnection,

    get tradeConfig() {

      return tradeCfg;

    },

  };

}

