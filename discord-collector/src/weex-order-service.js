/**
 * 信号卡片 → WEEX 自动下单（分阶段市价策略，参数与 Bitget 一致）。
 */
import { config } from "./config.js";
import { createWeexClient } from "./weex-api.js";
import { getWeexTradeStatus, loadWeexTradeConfig, resolveChannelWeexTrade } from "./weex-trade-config.js";
import {
  executeWeexStagedMarketOpen,
  executeWeexStagedReverse,
  executeWeexStagedTpslUpdate,
  executeWeexMoveSlToEntry,
} from "./weex-staged-order.js";
import { isStagedTradeSignal } from "./discord-signal-staged-trade.js";
import { isAutoTradeExcludedMajorSymbol } from "./trade-platform-toggles.js";

/** @param {ReturnType<typeof import("./store.js").openStore> extends Promise<infer S> ? S : never} store @param {ReturnType<typeof import("./logger.js").createLogger>} log */
export function createWeexOrderService(store, log) {
  let tradeCfg = loadWeexTradeConfig();

  function reloadConfig() {
    tradeCfg = loadWeexTradeConfig();
    return tradeCfg;
  }

  function credentials() {
    const key = config.weexApiKey;
    const secret = config.weexApiSecret;
    const passphrase = config.weexPassphrase;
    if (!key || !secret || !passphrase) return null;
    return {
      apiKey: key,
      apiSecret: secret,
      passphrase,
      baseUrl: config.weexBaseUrl,
      timeoutMs: config.weexRequestTimeoutMs,
    };
  }

  async function persistOrderResult(cardId, parsed, weexOrder) {
    if (!store?.updateSignalCard) return;
    let base = parsed;
    try {
      const card = await store.getSignalCardById?.(cardId);
      const raw = card?.parsed_json ?? card?.parsedJson;
      if (raw && typeof raw === "object") base = /** @type {Record<string, unknown>} */ (raw);
      else if (typeof raw === "string") {
        try {
          base = JSON.parse(raw);
        } catch {
          base = parsed;
        }
      }
    } catch {
      base = parsed;
    }
    const next = { ...base, weexOrder };
    try {
      await store.updateSignalCard(cardId, { parsedJson: next });
    } catch (e) {
      log.warn(`WEEX 下单结果写入卡片失败 #${cardId}: ${/** @type {Error} */ (e).message}`);
    }
  }

  async function runStagedTrade(input) {
    const creds = credentials();
    if (!creds) {
      log.warn(`WEEX 未配置 API 密钥，跳过 card=#${input.cardId}`);
      return { skipped: "credentials_missing" };
    }

    const client = createWeexClient(creds);
    const channelTrade = /** @type {Record<string, unknown>} */ ({ ...input.resolved.channel });
    const dryRun = input.resolved.dryRun;

    let result;
    if (input.isReverse && input.prevWeexOrder) {
      result = await executeWeexStagedReverse(client, {
        prevOrder: input.prevWeexOrder,
        parsed: input.parsed,
        channelTrade,
        cardId: input.cardId,
        dryRun,
      });
    } else if (input.parsed.signalPhase === "open" || input.parsed.awaitingTpsl) {
      result = await executeWeexStagedMarketOpen(client, {
        parsed: input.parsed,
        channelTrade,
        cardId: input.cardId,
        dryRun,
      });
    } else if (
      (input.parsed.signalPhase === "full" || input.parsed.signalPhase === "tpsl") &&
      input.prevWeexOrder
    ) {
      result = await executeWeexStagedTpslUpdate(client, {
        prevOrder: input.prevWeexOrder,
        parsed: input.parsed,
        channelTrade,
        cardId: input.cardId,
        dryRun,
      });
    } else if (input.parsed.signalPhase === "full") {
      result = await executeWeexStagedMarketOpen(client, {
        parsed: input.parsed,
        channelTrade,
        cardId: input.cardId,
        dryRun,
      });
      if (result.ok && result.record) {
        const tpsl = await executeWeexStagedTpslUpdate(client, {
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
      await persistOrderResult(input.cardId, input.parsed, {
        status: "failed",
        reason: result.reason,
        error: result.error ?? null,
        staged: true,
        exchange: "weex",
        at: new Date().toISOString(),
      });
      return { failed: true, reason: result.reason, error: result.error };
    }

    const record = {
      ...result.record,
      channelId: input.channelId,
      channelName: input.channelName ?? input.resolved.channel.name,
    };
    await persistOrderResult(input.cardId, input.parsed, record);
    log.info(
      `WEEX 分阶段 ${record.status} card=#${input.cardId} ${record.symbol ?? ""} ${input.isReverse ? "(反手)" : ""}${record.leverage ? ` lev=${record.leverage}x` : ""}`
    );
    if (record.status === "tpsl_partial" && record.tpslErrors) {
      log.warn(`WEEX TP/SL 部分失败 card=#${input.cardId}: ${JSON.stringify(record.tpslErrors)}`);
    }
    return { staged: true, record };
  }

  async function onSignalCardCreated(input) {
    reloadConfig();
    const resolved = resolveChannelWeexTrade(input.channelId, tradeCfg);
    if (!resolved) return { skipped: "channel_not_configured" };
    const autoTradeSym = String(input.parsed?.symbol ?? "").trim();
    if (isAutoTradeExcludedMajorSymbol(autoTradeSym)) {
      log.info(`WEEX 跳过主流币自动交易 symbol=${autoTradeSym} card=#${input.cardId}`);
      return { skipped: "major_symbol_excluded", symbol: autoTradeSym };
    }
    if (!isStagedTradeSignal(input.parsed) && !resolved.channel.stagedTrade) {
      return { skipped: "not_staged_signal" };
    }
    return runStagedTrade({
      cardId: input.cardId,
      channelId: input.channelId,
      parsed: input.parsed,
      channelName: input.channelName,
      resolved,
      isReverse: input.isReverse,
      prevWeexOrder: input.prevWeexOrder ?? null,
    });
  }

  async function onTpslUpdate(input) {
    reloadConfig();
    const resolved = resolveChannelWeexTrade(input.channelId, tradeCfg);
    if (!resolved) return { skipped: "channel_not_configured" };

    let prevWeex = input.prevWeexOrder ?? null;
    if (!prevWeex || typeof prevWeex !== "object") {
      const card = await store.getSignalCardById?.(input.cardId);
      const prevParsed = card?.parsed_json ?? card?.parsedJson;
      if (prevParsed && typeof prevParsed === "object") {
        prevWeex = /** @type {Record<string, unknown>} */ (prevParsed).weexOrder ?? null;
      } else if (typeof prevParsed === "string") {
        try {
          prevWeex = JSON.parse(prevParsed)?.weexOrder ?? null;
        } catch {
          prevWeex = null;
        }
      }
    }

    if (!prevWeex || typeof prevWeex !== "object") {
      log.info(`WEEX TP/SL 更新跳过 card=#${input.cardId}：无开仓记录`);
      return { skipped: "no_open_order" };
    }

    return runStagedTrade({
      cardId: input.cardId,
      channelId: input.channelId,
      parsed: input.parsed,
      channelName: input.channelName,
      resolved,
      prevWeexOrder: /** @type {Record<string, unknown>} */ (prevWeex),
    });
  }

  async function testConnection() {
    const creds = credentials();
    if (!creds) return { ok: false, error: "credentials_missing" };
    try {
      const client = createWeexClient(creds);
      return { ok: true, response: await client.ping() };
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
      input.parsed?.weexOrder && typeof input.parsed.weexOrder === "object"
        ? /** @type {Record<string, unknown>} */ (input.parsed.weexOrder)
        : null;
    if (!prev) return { skipped: "no_weex_order" };

    const creds = credentials();
    if (!creds) return { skipped: "credentials_missing" };

    const dryRun =
      input.dryRun === true ||
      String(prev.status) === "dry_run" ||
      loadWeexTradeConfig().dryRun === true;

    const client = createWeexClient(creds);
    const result = await executeWeexMoveSlToEntry(client, {
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
        `WEEX TP1保本 card=#${input.cardId} ${result.record?.symbol ?? ""} SL→${result.record?.breakevenEntryPrice ?? ""}`
      );
    } else if (!result.ok) {
      log.warn(`WEEX TP1保本失败 card=#${input.cardId}: ${result.error ?? result.reason}`);
    }
    return result;
  }

  return {
    onSignalCardCreated,
    onTpslUpdate,
    onTp1Breakeven,
    reloadConfig,
    getStatus: getWeexTradeStatus,
    testConnection,
    get tradeConfig() {
      return tradeCfg;
    },
  };
}
