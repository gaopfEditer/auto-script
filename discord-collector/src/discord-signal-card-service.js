/**
 * 信号卡片：去重 → 解析 → AI 多风格 → 入库 → Telegram → WS 广播。
 */
import { getSignalChannelConfig, isSignalChannel } from "./discord-signal-config.js";
import { createChannelTextDedup, normalizeSignalText, signalTextHash } from "./discord-signal-dedup.js";
import { generateCardsByStyles, extractSignalWithAi } from "./discord-signal-ai.js";
import { JUNZHANG_SL_LINK_MS, parseSignalText } from "./discord-signal-parsers.js";
import { createDiscordSignalTelegramPush } from "./discord-signal-telegram.js";
import { executionFromParsed, formatManualRawContent, normalizeExecution } from "./discord-signal-execution.js";
import { buildCardFieldsFromExecution, extractSymbolFromPayload } from "./card-fields.js";
import {
  NUMERIC_DEDUP_WINDOW_MS,
  shouldSkipNumericDuplicate,
} from "./discord-signal-numeric-dedup.js";
import {
  STAGED_SYMBOL_DEDUP_MS,
  STAGED_REVERSE_WINDOW_MS,
  STAGED_TPSL_LINK_MS,
  cardAwaitingTpsl,
  cardRowDirection,
  cardRowParsed,
  cardRowSymbol,
  isOppositeDirection,
  isStagedTradeChannel,
  mergeStagedParsed,
} from "./discord-signal-staged-trade.js";
import { detectAssetClass, resolveVerifyMode } from "./card-verify-policy.js";
import { config } from "./config.js";
import { extractSignalCardRowId } from "./store.js";
import {
  isAutoTradeChannel,
  isAutoTradeExcludedMajorSymbol,
  shouldPushToTradePlatform,
} from "./trade-platform-toggles.js";
import { formatCardUid, stampCardFieldsUid, stampCardsByStyle } from "./card-uid.js";
import { buildCardSinkPayload, pickCardSinkText } from "./card-external-sink.js";

/** @param {Record<string, unknown>} row */
export function resolveMessageSignalAt(row) {
  const ms = Number(row.createdAtMs ?? row.created_at_ms ?? 0);
  if (Number.isFinite(ms) && ms > 0) {
    return new Date(ms).toISOString();
  }
  const received = row.receivedAt ?? row.received_at;
  if (received) {
    const d = new Date(String(received));
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return new Date().toISOString();
}

/** @param {Record<string, unknown>} row */
export function resolveCardSignalAt(row) {
  const msgMs = Number(row.message_created_at_ms ?? row.messageCreatedAtMs ?? 0);
  if (Number.isFinite(msgMs) && msgMs > 0) {
    return new Date(msgMs).toISOString();
  }
  const sa = row.signal_at ?? row.signalAt;
  if (sa) return String(sa);
  const ca = row.created_at ?? row.createdAt;
  return ca ? String(ca) : null;
}

/** @param {unknown} raw */
function parseJsonField(raw) {
  if (!raw) return null;
  if (typeof raw === "object") return /** @type {Record<string, unknown>} */ (raw);
  try {
    return /** @type {Record<string, unknown>} */ (JSON.parse(String(raw)));
  } catch {
    return null;
  }
}

/**
 * seven / 山寨之王：TP/SL 补充消息从最近开仓卡片补全 symbol / direction。
 * @param {ReturnType<typeof import("./store.js").openStore> extends Promise<infer S> ? S : never} store
 * @param {string} channelId
 * @param {Record<string, unknown>} parsed
 */
/**
 * @param {ReturnType<typeof import("./store.js").openStore> extends Promise<infer S> ? S : never} store
 * @param {string} channelId
 * @param {Record<string, unknown>} parsed
 * @param {number} [withinMs]
 */
async function enrichStagedFromRecentCard(store, channelId, parsed, withinMs = STAGED_TPSL_LINK_MS) {
  if (parsed.signalPhase !== "tpsl") return parsed;
  const sym = String(parsed.symbol ?? "").trim();
  const dir = String(parsed.direction ?? "").trim();
  if (sym && dir && dir !== "待确认") return parsed;
  if (!store.getRecentSignalCardByChannel) return parsed;

  let recent = null;
  if (sym && store.getRecentSignalCardBySymbolChannel) {
    recent = await store.getRecentSignalCardBySymbolChannel({
      symbol: sym,
      channelId,
      withinMs,
    });
  }
  if (!recent || !cardAwaitingTpsl(recent)) {
    recent = await store.getRecentSignalCardByChannel({ channelId, withinMs });
  }
  if (!recent || !cardAwaitingTpsl(recent)) return parsed;

  const prev = parseJsonField(recent.parsed_json ?? recent.parsedJson);
  if (!prev) return parsed;

  const out = { ...parsed };
  if (!sym && String(prev.symbol ?? "").trim()) out.symbol = String(prev.symbol).trim();
  if ((!dir || dir === "待确认") && String(prev.direction ?? "").trim()) {
    out.direction = String(prev.direction).trim();
  }
  return out;
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore> extends Promise<infer S> ? S : never} store
 * @param {string} channelId
 * @param {string} symbol
 */
/**
 * @param {ReturnType<typeof import("./store.js").openStore> extends Promise<infer S> ? S : never} store
 * @param {string} channelId
 * @param {string} symbol
 * @param {number} [withinMs]
 */
async function findStagedOpenCard(store, channelId, symbol, withinMs = STAGED_TPSL_LINK_MS) {
  if (symbol && store.getRecentSignalCardBySymbolChannel) {
    const row = await store.getRecentSignalCardBySymbolChannel({
      symbol,
      channelId,
      withinMs,
    });
    if (row && cardAwaitingTpsl(row)) return row;
  }
  if (store.getRecentSignalCardByChannel) {
    const row = await store.getRecentSignalCardByChannel({ channelId, withinMs });
    if (row && cardAwaitingTpsl(row)) return row;
  }
  return null;
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore> extends Promise<infer S> ? S : never} store
 * @param {string} channelId
 * @param {string} symbol
 * @param {string} direction
 */
async function detectStagedReverse(store, channelId, symbol, direction) {
  if (!symbol || !store.getRecentSignalCardBySymbolChannel) return null;
  const prev = await store.getRecentSignalCardBySymbolChannel({
    symbol,
    channelId,
    withinMs: STAGED_REVERSE_WINDOW_MS,
  });
  if (!prev) return null;
  const prevDir = cardRowDirection(prev);
  if (!isOppositeDirection(direction, prevDir)) return null;
  const prevParsed = cardRowParsed(prev);
  const prevBitget = prevParsed?.bitgetOrder;
  const prevWeex = prevParsed?.weexOrder;
  return {
    prevCardId: extractSignalCardRowId(prev.id ?? prev.ID),
    prevBitgetOrder: prevBitget && typeof prevBitget === "object" ? /** @type {Record<string, unknown>} */ (prevBitget) : null,
    prevWeexOrder: prevWeex && typeof prevWeex === "object" ? /** @type {Record<string, unknown>} */ (prevWeex) : null,
  };
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore> extends Promise<infer S> ? S : never} store
 * @param {string} channelId
 * @param {string} textHash
 */
async function shouldSkipStagedContentDup(store, channelId, textHash) {
  if (!store.getRecentSignalCardByChannel) return false;
  const recent = await store.getRecentSignalCardByChannel({ channelId, withinMs: STAGED_SYMBOL_DEDUP_MS });
  if (!recent) return false;
  const prevHash = String(recent.source_text_hash ?? recent.sourceTextHash ?? "");
  return prevHash === textHash;
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore> extends Promise<infer S> ? S : never} store
 * @param {string} channelId
 * @param {string} symbol
 */
async function shouldSkipStagedSymbolDup(store, channelId, symbol) {
  if (!symbol || !store.getRecentSignalCardBySymbolChannel) return false;
  const prev = await store.getRecentSignalCardBySymbolChannel({
    symbol,
    channelId,
    withinMs: STAGED_SYMBOL_DEDUP_MS,
  });
  return Boolean(prev);
}

/**
 * seven 频道常先发入场、再发止盈止损补充；从同频道最近卡片补全 symbol / direction。
 * @param {ReturnType<typeof import("./store.js").openStore> extends Promise<infer S> ? S : never} store
 * @param {string} channelId
 * @param {Record<string, unknown>} parsed
 */
async function enrichTwOpgFromRecentCard(store, channelId, parsed) {
  if (parsed.parser !== "tw_opg" || !store.getRecentSignalCardByChannel) return parsed;
  if (parsed.signalPhase === "tpsl") return enrichStagedFromRecentCard(store, channelId, parsed);

  const needSymbol = !String(parsed.symbol ?? "").trim();
  const dir = String(parsed.direction ?? "").trim();
  const needDirection = !dir || dir === "待确认";

  if (!needSymbol && !needDirection) return parsed;

  const recent = await store.getRecentSignalCardByChannel({ channelId, withinMs: 1_800_000 });
  if (!recent) return parsed;

  const prev = parseJsonField(recent.parsed_json ?? recent.parsedJson);
  if (!prev) return parsed;

  const out = { ...parsed };
  if (needSymbol && String(prev.symbol ?? "").trim()) {
    out.symbol = String(prev.symbol).trim();
  }
  if (needDirection && String(prev.direction ?? "").trim() && String(prev.direction) !== "待确认") {
    out.direction = String(prev.direction).trim();
  }
  const sym = String(out.symbol ?? "").trim();
  const d = String(out.direction ?? "").trim();
  if (sym || d) {
    out.title = sym ? `${sym} ${d || "信号"}` : String(out.title ?? "seven 信号");
  }
  return out;
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {(channel: string, payload: Record<string, unknown>) => void} [broadcast]
 * @param {{ bitgetOrder?: ReturnType<typeof import("./bitget-order-service.js").createBitgetOrderService>; weexOrder?: ReturnType<typeof import("./weex-order-service.js").createWeexOrderService>; cardSink?: ReturnType<typeof import("./card-external-sink.js").createCardExternalSink> }} [deps]
 */
export function createDiscordSignalCardService(store, log, broadcast, deps = {}) {
  const dedup = createChannelTextDedup(store);
  const telegram = createDiscordSignalTelegramPush(log);
  const bitgetOrder = deps.bitgetOrder ?? null;
  const weexOrder = deps.weexOrder ?? null;
  const cardSink = deps.cardSink ?? null;
  let hydrated = false;

  /**
   * @param {string | Record<string, unknown>} textOrPayload
   * @param {Record<string, unknown>} [meta]
   */
  async function pushExternal(textOrPayload, meta = {}) {
    if (!cardSink?.enabled) return;
    try {
      await cardSink.publish(textOrPayload, meta);
    } catch (e) {
      log.warn(`卡片外送异常: ${/** @type {Error} */ (e).message}`);
    }
  }

  /**
   * @param {{
   *   text: string,
   *   card: Record<string, unknown>,
   *   message: Record<string, unknown>,
   *   channelName: string,
   *   channelId: string,
   *   guildId?: string,
   *   event: string,
   *   parsed?: Record<string, unknown> | null,
   *   execution?: unknown,
   *   embed?: unknown,
   * }} input
   */
  async function pushExternalCard(input) {
    if (!cardSink?.enabled) return;
    try {
      const payload = buildCardSinkPayload(input);
      await cardSink.publish(payload);
    } catch (e) {
      log.warn(`卡片外送异常: ${/** @type {Error} */ (e).message}`);
    }
  }

  async function ensureHydrated() {
    if (hydrated) return;
    await dedup.hydrate();
    hydrated = true;
  }

  /**
   * @param {Record<string, unknown>} row
   * @param {{ skipDedup?: boolean; skipTelegram?: boolean; debugSimulate?: boolean; tradePlatforms?: { bitget?: boolean; weex?: boolean } }} [opts]
   * @returns {Promise<{ skipped?: string; card?: Record<string, unknown>; parsed?: Record<string, unknown>; bitgetResult?: unknown; merged?: boolean }>}
   */
  async function onMessage(row, opts = {}) {
    await ensureHydrated();

    const channelId = String(row.channelId ?? row.channel_id ?? "").trim();
    const messageId = String(row.messageId ?? row.message_id ?? "").trim();
    const content = normalizeSignalText(String(row.content ?? ""));
    const guildId = String(row.guildId ?? row.guild_id ?? "").trim();

    if (!channelId || !isSignalChannel(channelId)) return { skipped: "not_signal_channel" };
    if (!content) return { skipped: "empty" };

    const chCfg = getSignalChannelConfig(channelId);
    if (!chCfg) return { skipped: "no_config" };

    if (!opts.skipDedup && dedup.isDuplicate(channelId, content)) {
      log.debug(`信号跳过重复 channel=${channelId} preview=${content.slice(0, 80)}`);
      return { skipped: "duplicate_text" };
    }

    let parsed = parseSignalText(content, chCfg.parser);
    if (!parsed && config.ollamaEnabled && !opts.debugSimulate) {
      parsed = await extractSignalWithAi(content, chCfg.parser, chCfg.name, {
        debug: (s) => log.debug(s),
      });
    }
    if (parsed && chCfg.parser === "tw_opg") {
      parsed = await enrichTwOpgFromRecentCard(store, channelId, parsed);
    }
    if (parsed && chCfg.parser === "altcoin_king" && parsed.signalPhase === "tpsl") {
      parsed = await enrichStagedFromRecentCard(store, channelId, parsed);
    }
    if (parsed && chCfg.parser === "junzhang" && parsed.signalPhase === "tpsl") {
      parsed = await enrichStagedFromRecentCard(store, channelId, parsed, JUNZHANG_SL_LINK_MS);
    }
    if (!parsed) {
      log.info(`信号未识别 channel=${channelId} parser=${chCfg.parser} preview=${content.slice(0, 80)}`);
      return { skipped: "parse_failed" };
    }

    /** @type {unknown} */
    let bitgetResult = null;
    /** @type {unknown} */
    let weexResult = null;
    const textHash = signalTextHash(content);
    const isStagedChannel = isStagedTradeChannel(channelId);
    const isJunzhang = chCfg.parser === "junzhang";

    // 军长：约 2 分钟内止损补发 → 合并到待补全开仓卡，再推 Telegram
    if (isJunzhang && parsed.signalPhase === "tpsl") {
      const symForLink = extractSymbolFromPayload(parsed, executionFromParsed(parsed));
      const openCard = await findStagedOpenCard(store, channelId, symForLink, JUNZHANG_SL_LINK_MS);
      if (openCard) {
        const openId = extractSignalCardRowId(openCard.id ?? openCard.ID);
        const prevParsed = cardRowParsed(openCard) ?? {};
        const mergedParsed = mergeStagedParsed(prevParsed, parsed);
        const executionJson = executionFromParsed(mergedParsed);
        const symbol = extractSymbolFromPayload(mergedParsed, executionJson);
        const cardsByStyle = stampCardsByStyle(
          await generateCardsByStyles(mergedParsed, chCfg.styles, content, {
            debug: (s) => log.debug(s),
            fastFallback: true,
          }),
          openId
        );
        const cardFieldsJson = stampCardFieldsUid(
          buildCardFieldsFromExecution(executionJson, mergedParsed, content, {
            sourceType: "discord",
            sourceRef: channelId,
          }),
          openId
        );
        await store.updateSignalCard(openId, {
          parsedJson: mergedParsed,
          executionJson,
          cardsByStyle,
          cardFieldsJson,
        });
        const updated = await store.getSignalCardById?.(openId);
        const clientCard = signalCardToClient(updated ?? openCard);
        const mergeText =
          pickCardSinkText(clientCard, chCfg.telegramStyle) ||
          cardsByStyle[chCfg.telegramStyle] ||
          Object.values(cardsByStyle)[0] ||
          content;
        if (telegram.enabled && !opts.skipTelegram) {
          try {
            await telegram.send(String(mergeText), {
              channelId,
              channelName: chCfg.name,
              cardId: openId,
            });
            await store.markSignalCardTelegramSent?.(openId);
          } catch (e) {
            log.warn(`军长止损合并后 Telegram 失败: ${/** @type {Error} */ (e).message}`);
          }
        }
        await pushExternalCard({
          text: String(mergeText),
          card: clientCard,
          message: row,
          channelName: chCfg.name,
          channelId,
          guildId,
          event: "updated",
          parsed: mergedParsed,
          execution: executionJson,
          embed: cardFieldsJson,
        });
        broadcast?.("meta", { kind: "signal_card_updated", card: clientCard });
        log.info(
          `军长止损合并 → 卡片 #${openId} channel=${channelId} symbol=${symbol} sl=${mergedParsed.stopLoss}`
        );
        return { card: clientCard, merged: true, parsed: mergedParsed };
      }
      log.warn(
        `军长止损未找到 2 分钟内开仓卡 channel=${channelId} symbol=${symForLink || "-"} preview=${content.slice(0, 80)}`
      );
      return { skipped: "no_open_card_for_junzhang_sl", parsed };
    }

    if (isStagedChannel && parsed.signalPhase === "tpsl") {
      const symForLink = extractSymbolFromPayload(parsed, executionFromParsed(parsed));
      const openCard = await findStagedOpenCard(store, channelId, symForLink);
      if (openCard) {
        const openId = extractSignalCardRowId(openCard.id ?? openCard.ID);
        const prevParsed = cardRowParsed(openCard) ?? {};
        const mergedParsed = mergeStagedParsed(prevParsed, parsed);
        const prevBitgetOrder =
          prevParsed.bitgetOrder && typeof prevParsed.bitgetOrder === "object"
            ? /** @type {Record<string, unknown>} */ (prevParsed.bitgetOrder)
            : null;
        const prevWeexOrder =
          prevParsed.weexOrder && typeof prevParsed.weexOrder === "object"
            ? /** @type {Record<string, unknown>} */ (prevParsed.weexOrder)
            : null;
        const executionJson = executionFromParsed(mergedParsed);
        const symbol = extractSymbolFromPayload(mergedParsed, executionJson);
        const cardsByStyle = stampCardsByStyle(
          await generateCardsByStyles(mergedParsed, chCfg.styles, content, {
            debug: (s) => log.debug(s),
            fastFallback:
              opts.debugSimulate || String(mergedParsed.parser ?? "") === "junzhang",
          }),
          openId
        );
        const cardFieldsJson = stampCardFieldsUid(
          buildCardFieldsFromExecution(executionJson, mergedParsed, content, {
            sourceType: "discord",
            sourceRef: channelId,
          }),
          openId
        );
        await store.updateSignalCard(openId, {
          parsedJson: mergedParsed,
          executionJson,
          cardsByStyle,
          cardFieldsJson,
        });
        const skipMajorTpsl = isAutoTradeExcludedMajorSymbol(symbol);
        if (skipMajorTpsl && isAutoTradeChannel(channelId)) {
          bitgetResult = { skipped: "major_symbol_excluded", symbol };
          weexResult = { skipped: "major_symbol_excluded", symbol };
          log.info(`自动交易跳过主流币 TP/SL symbol=${symbol} card=#${openId}`);
        } else if (bitgetOrder?.onTpslUpdate && shouldPushToTradePlatform("bitget", channelId, opts)) {
          try {
            bitgetResult = await bitgetOrder.onTpslUpdate({
              cardId: openId,
              channelId,
              parsed: mergedParsed,
              channelName: chCfg.name,
              prevBitgetOrder,
            });
          } catch (e) {
            log.warn(`Bitget TP/SL 更新异常: ${/** @type {Error} */ (e).message}`);
          }
        } else if (bitgetOrder && isAutoTradeChannel(channelId) && !shouldPushToTradePlatform("bitget", channelId, opts)) {
          bitgetResult = { skipped: "platform_toggle_off", platform: "bitget" };
        }
        if (!skipMajorTpsl && weexOrder?.onTpslUpdate && shouldPushToTradePlatform("weex", channelId, opts)) {
          try {
            weexResult = await weexOrder.onTpslUpdate({
              cardId: openId,
              channelId,
              parsed: mergedParsed,
              channelName: chCfg.name,
              prevWeexOrder,
            });
          } catch (e) {
            log.warn(`WEEX TP/SL 更新异常: ${/** @type {Error} */ (e).message}`);
          }
        } else if (!skipMajorTpsl && weexOrder && isAutoTradeChannel(channelId) && !shouldPushToTradePlatform("weex", channelId, opts)) {
          weexResult = { skipped: "platform_toggle_off", platform: "weex" };
        }
        const updated = await store.getSignalCardById?.(openId);
        const clientCard = signalCardToClient(updated ?? openCard);
        const mergeText =
          pickCardSinkText(clientCard, chCfg.telegramStyle) ||
          cardsByStyle[chCfg.telegramStyle] ||
          Object.values(cardsByStyle)[0] ||
          content;
        await pushExternalCard({
          text: String(mergeText),
          card: clientCard,
          message: row,
          channelName: chCfg.name,
          channelId,
          guildId,
          event: "updated",
          parsed: mergedParsed,
          execution: executionJson,
          embed: cardFieldsJson,
        });
        broadcast?.("meta", { kind: "signal_card_updated", card: clientCard });
        log.info(`信号 TP/SL 合并 → 卡片 #${openId} channel=${channelId} symbol=${symbol}`);
        return { card: clientCard, merged: true, parsed: mergedParsed, bitgetResult, weexResult };
      }
      log.warn(
        `信号 TP/SL 未找到待合并开仓卡片 channel=${channelId} symbol=${symForLink || "-"} preview=${content.slice(0, 80)}`
      );
      return { skipped: "no_open_card_for_tpsl", parsed };
    }

    const cardsByStyle = await generateCardsByStyles(parsed, chCfg.styles, content, {
      debug: (s) => log.debug(s),
      // 军长 TP/SL 由规则算出，固定简体卡片格式，不走 Ollama（避免 Telegram 收到 JSON）
      fastFallback: opts.debugSimulate || String(parsed.parser ?? "") === "junzhang",
    });

    const executionJson = executionFromParsed(parsed);
    const symbol = extractSymbolFromPayload(parsed, executionJson);

    let isReverse = false;
    /** @type {Record<string, unknown> | null} */
    let prevBitgetOrder = null;
    /** @type {Record<string, unknown> | null} */
    let prevWeexOrder = null;
    /** @type {number | null} */
    let linkedCardId = null;

    if (isStagedChannel && parsed.signalPhase === "open" && !opts.debugSimulate) {
      const reverse = await detectStagedReverse(store, channelId, symbol, String(parsed.direction ?? ""));
      if (reverse) {
        isReverse = true;
        linkedCardId = reverse.prevCardId;
        prevBitgetOrder = reverse.prevBitgetOrder;
        prevWeexOrder = reverse.prevWeexOrder;
        parsed = { ...parsed, isReverse: true, linkedCardId, reverseNote: "5分钟内反向信号，触发反手" };
      } else {
        if (await shouldSkipStagedContentDup(store, channelId, textHash)) {
          log.debug(`分阶段跳过重复内容 channel=${channelId} symbol=${symbol}`);
          return { skipped: "duplicate_content_4h", parsed, symbol };
        }
        if (await shouldSkipStagedSymbolDup(store, channelId, symbol)) {
          log.debug(`分阶段跳过重复币种(4h) channel=${channelId} symbol=${symbol}`);
          return { skipped: "duplicate_symbol_4h", parsed, symbol };
        }
      }
    }

    const skipNumericDedup =
      (isStagedChannel || isJunzhang) &&
      (parsed.signalPhase === "open" || parsed.awaitingTpsl);

    if (symbol && store.getRecentSignalCardBySymbolChannel && !skipNumericDedup) {
      const prev = await store.getRecentSignalCardBySymbolChannel({
        symbol,
        channelId,
        withinMs: NUMERIC_DEDUP_WINDOW_MS,
      });
      if (
        prev &&
        shouldSkipNumericDuplicate(
          normalizeExecution(prev.execution_json ?? prev.executionJson, prev.parsed_json ?? prev.parsedJson),
          executionJson
        )
      ) {
        log.debug(
          `信号跳过数值重复 symbol=${symbol} channel=${channelId} blogger=${chCfg.name} preview=${content.slice(0, 80)}`
        );
        return { skipped: "duplicate_numeric" };
      }
    }

    const assetClass = detectAssetClass(symbol, parsed, executionJson, content);
    const verifyMode = resolveVerifyMode(assetClass, parsed.verifyMode);
    const cardFieldsJson = buildCardFieldsFromExecution(executionJson, parsed, content, {
      sourceType: "discord",
      sourceRef: channelId,
    });
    let cardRow = await store.insertSignalCard({
      messageId: messageId || `hash-${textHash.slice(0, 16)}`,
      channelId,
      guildId,
      sourceTextHash: textHash,
      rawContent: content,
      parsedJson: parsed,
      cardsByStyle,
      executionJson,
      source: "auto",
      status: "active",
      sourceType: "discord",
      sourceRef: channelId,
      symbol,
      cardFieldsJson,
      signalAt: resolveMessageSignalAt(row),
      verifyMode,
      assetClass,
    });

    let cardId = extractSignalCardRowId(cardRow?.id ?? cardRow?.ID);
    if (!cardId && messageId && store.getSignalCardByMessageId) {
      cardRow = await store.getSignalCardByMessageId(messageId);
      cardId = extractSignalCardRowId(cardRow?.id ?? cardRow?.ID);
    }
    if (!cardId) {
      log.warn(`信号卡片入库后缺少 id channel=${channelId} message=${messageId}`);
      return { skipped: "insert_no_id" };
    }

    const stampedStyles = stampCardsByStyle(cardsByStyle, cardId);
    const stampedFields = stampCardFieldsUid(cardFieldsJson, cardId);
    cardRow = await store.updateSignalCard(cardId, {
      cardsByStyle: stampedStyles,
      cardFieldsJson: stampedFields,
    });
    Object.assign(cardsByStyle, stampedStyles);

    const telegramStyle = chCfg.telegramStyle || chCfg.styles[0] || "cn_brief";
    const telegramText = stampedStyles[telegramStyle] ?? Object.values(stampedStyles)[0] ?? content;

    // 军长无止损时先入库，等约 2 分钟内止损补发再推 Telegram
    const deferJunzhangTelegram =
      isJunzhang && (parsed.signalPhase === "open" || parsed.awaitingTpsl === true);

    if (telegram.enabled && !opts.skipTelegram && !deferJunzhangTelegram) {
      try {
        await telegram.send(telegramText, {
          channelId,
          channelName: chCfg.name,
          cardId,
        });
        await store.markSignalCardTelegramSent(cardId);
        cardRow.telegram_sent_at = cardRow.telegramSentAt = new Date().toISOString();
      } catch (e) {
        log.warn(`Telegram 推送失败: ${/** @type {Error} */ (e).message}`);
      }
    } else if (deferJunzhangTelegram) {
      log.info(`军长开仓卡 #${cardId} 待止损（约 2 分钟内）后再推 Telegram symbol=${symbol}`);
    }

    await pushExternalCard({
      text: telegramText,
      card: signalCardToClient(cardRow),
      message: row,
      channelName: chCfg.name,
      channelId,
      guildId,
      event: "created",
      parsed,
      execution: executionJson,
      embed: stampedFields,
    });

    const skipMajor = isAutoTradeExcludedMajorSymbol(symbol);
    if (skipMajor && isAutoTradeChannel(channelId)) {
      bitgetResult = { skipped: "major_symbol_excluded", symbol };
      weexResult = { skipped: "major_symbol_excluded", symbol };
      log.info(`自动交易跳过主流币 symbol=${symbol} card=#${cardId}（BTC/ETH 不自动下单）`);
    } else {
      if (bitgetOrder && shouldPushToTradePlatform("bitget", channelId, opts)) {
        try {
          bitgetResult = await bitgetOrder.onSignalCardCreated({
            cardId,
            channelId,
            parsed,
            executionJson,
            symbol,
            channelName: chCfg.name,
            isReverse,
            prevBitgetOrder,
            linkedCardId: linkedCardId ?? undefined,
          });
          if (bitgetResult && !("skipped" in /** @type {Record<string, unknown>} */ (bitgetResult) && /** @type {Record<string, unknown>} */ (bitgetResult).skipped)) {
            const refreshed = await store.getSignalCardById?.(cardId);
            if (refreshed) cardRow = refreshed;
          }
        } catch (e) {
          log.warn(`Bitget 自动下单异常: ${/** @type {Error} */ (e).message}`);
        }
      } else if (bitgetOrder && isAutoTradeChannel(channelId) && !shouldPushToTradePlatform("bitget", channelId, opts)) {
        bitgetResult = { skipped: "platform_toggle_off", platform: "bitget" };
      }

      if (weexOrder && shouldPushToTradePlatform("weex", channelId, opts)) {
        try {
          weexResult = await weexOrder.onSignalCardCreated({
            cardId,
            channelId,
            parsed,
            channelName: chCfg.name,
            isReverse,
            prevWeexOrder,
          });
          if (weexResult && !("skipped" in /** @type {Record<string, unknown>} */ (weexResult) && /** @type {Record<string, unknown>} */ (weexResult).skipped)) {
            const refreshed = await store.getSignalCardById?.(cardId);
            if (refreshed) cardRow = refreshed;
          }
        } catch (e) {
          log.warn(`WEEX 自动下单异常: ${/** @type {Error} */ (e).message}`);
        }
      } else if (weexOrder && isAutoTradeChannel(channelId) && !shouldPushToTradePlatform("weex", channelId, opts)) {
        weexResult = { skipped: "platform_toggle_off", platform: "weex" };
      }
    }

    const clientCard = signalCardToClient(cardRow);
    broadcast?.("meta", { kind: "signal_card_created", card: clientCard });
    log.info(`信号卡片 #${cardId} channel=${channelId} styles=${Object.keys(cardsByStyle).join(",")}`);

    return { card: clientCard, parsed, bitgetResult, weexResult };
  }

  return { onMessage, dedup, telegram, signalCardToClient, ensureHydrated, formatManualRawContent, pushExternal, pushExternalCard };
}

/** @param {Record<string, unknown>} row */
export function signalCardToClient(row) {
  let cardsByStyle = row.cards_by_style ?? row.cardsByStyle;
  if (typeof cardsByStyle === "string") {
    try {
      cardsByStyle = JSON.parse(cardsByStyle);
    } catch {
      cardsByStyle = {};
    }
  }
  let parsedJson = row.parsed_json ?? row.parsedJson;
  if (typeof parsedJson === "string") {
    try {
      parsedJson = JSON.parse(parsedJson);
    } catch {
      parsedJson = null;
    }
  }
  const source = String(row.source ?? "auto");
  const messageId = String(row.message_id ?? row.messageId ?? "");
  const isManual = source === "manual" || messageId.startsWith("manual-");
  const id = extractSignalCardRowId(row.id ?? row.ID);
  return {
    id,
    uid: formatCardUid(id),
    messageId,
    channelId: String(row.channel_id ?? row.channelId ?? ""),
    guildId: String(row.guild_id ?? row.guildId ?? ""),
    rawContent: String(row.raw_content ?? row.rawContent ?? ""),
    parsedJson,
    cardsByStyle: cardsByStyle && typeof cardsByStyle === "object" ? cardsByStyle : {},
    status: String(row.status ?? "active"),
    expiresAt: row.expires_at ?? row.expiresAt ?? null,
    telegramSentAt: row.telegram_sent_at ?? row.telegramSentAt ?? null,
    note: row.note != null ? String(row.note) : "",
    execution: normalizeExecution(row.execution_json ?? row.executionJson, parsedJson),
    source,
    sourceType: String(row.source_type ?? row.sourceType ?? "discord"),
    sourceRef: row.source_ref ?? row.sourceRef ?? null,
    isManual,
    signalAt: resolveCardSignalAt(row),
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
  };
}
