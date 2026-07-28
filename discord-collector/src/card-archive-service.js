/**
 * 统一卡片归档：Discord / YouTube / 外部 API → 同一套 Discord 字段结构。
 */
import { signalTextHash } from "./discord-signal-dedup.js";
import {
  buildCardFieldsFromExecution,
  buildDiscordCardFields,
  extractSymbolFromPayload,
  normalizeSymbol,
} from "./card-fields.js";
import { executionFromParsed, normalizeExecution, normalizePriceList } from "./discord-signal-execution.js";
import { signalCardToClient, resolveCardSignalAt } from "./discord-signal-card-service.js";
import { getSignalChannelConfig, COIN_ACTION_SIGNAL_CHANNEL_ID } from "./discord-signal-config.js";
import { detectAssetClass, resolveVerifyMode } from "./card-verify-policy.js";
import { stampCardFieldsUid, stampCardsByStyle } from "./card-uid.js";
import { buildCardSinkPayload, pickCardSinkText } from "./card-external-sink.js";
import { extractSignalCardRowId } from "./store.js";
import {
  COIN_ACTION_DEDUP_WINDOW_MS,
  COIN_ACTION_ENTRY_SIMILAR_PCT,
  isSimilarEntryPrice,
  shouldSkipSimilarCoinAction,
} from "./discord-signal-numeric-dedup.js";

/** @param {string} channelId @param {string|null|undefined} [dbName] */
export function resolveCardChannelName(channelId, dbName) {
  const id = String(channelId ?? "").trim();
  if (!id) return "";
  const cfgName = getSignalChannelConfig(id)?.name;
  if (cfgName) return cfgName;
  const dn = String(dbName ?? "").trim();
  if (dn) return dn;
  return id;
}

export const SOURCE_TYPES = /** @type {const} */ (["discord", "youtube", "api", "manual"]);

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {(channel: string, payload: Record<string, unknown>) => void} [broadcast]
 * @param {{ cardSink?: ReturnType<typeof import("./card-external-sink.js").createCardExternalSink> }} [deps]
 */
export function createCardArchiveService(store, log, broadcast, deps = {}) {
  const cardSink = deps.cardSink ?? null;
  /**
   * @param {{
   *   messageId?: string,
   *   channelId?: string,
   *   guildId?: string,
   *   sourceType: string,
   *   sourceRef?: string,
   *   rawContent?: string,
   *   parsedJson?: unknown,
   *   cardsByStyle?: Record<string, string>,
   *   execution?: unknown,
   *   executionJson?: unknown,
   *   cardFields?: unknown,
   *   symbol?: string,
   *   status?: string,
   *   note?: string | null,
   *   signalAt?: string | null,
   *   source?: string,
   * }} input
   */
  async function archiveCard(input) {
    const sourceType = String(input.sourceType ?? "api").trim().toLowerCase();
    if (!SOURCE_TYPES.includes(/** @type {typeof SOURCE_TYPES[number]} */ (sourceType))) {
      throw new Error(`invalid sourceType: ${sourceType}`);
    }

    const execution = normalizeExecution(input.execution ?? input.executionJson ?? input, input.parsedJson);
    const symbol = normalizeSymbol(input.symbol ?? execution.symbol ?? extractSymbolFromPayload(input.parsedJson, execution));
    if (symbol) execution.symbol = symbol.replace("USDT", "");

    const rawContent = String(input.rawContent ?? "").trim();
    const cardFields =
      input.cardFields && typeof input.cardFields === "object"
        ? input.cardFields
        : buildCardFieldsFromExecution(execution, input.parsedJson, rawContent, {
            sourceType,
            sourceRef: input.sourceRef,
            note: input.note,
          });

    const messageId =
      String(input.messageId ?? "").trim() ||
      `${sourceType}-${input.sourceRef || Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;

    const channelId = String(input.channelId ?? input.sourceRef ?? sourceType).trim() || sourceType;
    const textHash = signalTextHash(rawContent || JSON.stringify(cardFields));
    const assetClass =
      input.assetClass === "stock" || input.assetClass === "crypto"
        ? input.assetClass
        : detectAssetClass(symbol, input.parsedJson, execution, rawContent);
    const verifyMode = resolveVerifyMode(assetClass, input.verifyMode);

    const row = await store.insertSignalCard({
      messageId,
      channelId,
      guildId: String(input.guildId ?? "").trim(),
      sourceTextHash: textHash,
      rawContent: rawContent || String(cardFields.title ?? "归档卡片"),
      parsedJson: input.parsedJson ?? null,
      cardsByStyle: input.cardsByStyle ?? { archive: rawContent || String(cardFields.title ?? "") },
      executionJson: execution,
      source: input.source ?? (sourceType === "manual" ? "manual" : "auto"),
      status: input.status ?? "active",
      note: input.note ?? null,
      sourceType,
      sourceRef: input.sourceRef ? String(input.sourceRef) : null,
      symbol,
      cardFieldsJson: cardFields,
      signalAt: input.signalAt ?? new Date().toISOString(),
      verifyMode,
      assetClass,
    });

    const cardId = extractSignalCardRowId(row?.id ?? row?.ID);
    let stampedRow = row;
    if (cardId) {
      const styles = stampCardsByStyle(
        input.cardsByStyle ?? { archive: rawContent || String(cardFields.title ?? "") },
        cardId
      );
      const fields = stampCardFieldsUid(cardFields, cardId);
      stampedRow = (await store.updateSignalCard(cardId, {
        cardsByStyle: styles,
        cardFieldsJson: fields,
      })) ?? row;
    }

    const clientCard = archiveCardToClient(stampedRow);
    if (cardSink?.enabled) {
      const text = pickCardSinkText(clientCard);
      if (text) {
        try {
          await cardSink.publish(
            buildCardSinkPayload({
              text,
              card: clientCard,
              channelId: String(clientCard.channelId ?? ""),
              channelName: String(clientCard.channelName ?? ""),
              event: "archived",
              parsed:
                clientCard.parsedJson && typeof clientCard.parsedJson === "object"
                  ? /** @type {Record<string, unknown>} */ (clientCard.parsedJson)
                  : null,
              execution: clientCard.execution,
              embed: clientCard.cardFields,
            })
          );
        } catch (e) {
          log.warn(`卡片外送异常: ${/** @type {Error} */ (e).message}`);
        }
      }
    }
    broadcast?.("meta", { kind: "card_archived", card: clientCard });
    log.info(`卡片归档 ${clientCard.uid || `#${clientCard.id}`} source=${sourceType} symbol=${symbol}`);
    return clientCard;
  }

  /**
   * 从 YouTube 文稿/摘要创建交易卡片。
   * @param {{
   *   videoId: string,
   *   title?: string,
   *   symbol: string,
   *   direction?: string,
   *   entry?: string,
   *   targets?: string[],
   *   stopLoss?: string,
   *   note?: string,
   *   rawContent?: string,
   * }} body
   */
  async function archiveFromYoutube(body) {
    const videoId = String(body.videoId ?? "").trim();
    if (!videoId) throw new Error("videoId required");

    const execution = normalizeExecution({
      symbol: body.symbol,
      direction: body.direction,
      planned: {
        entryPrice: body.entry,
        takeProfitPrices: normalizePriceList(body.targets),
        stopLossPrice: body.stopLoss,
      },
      outcome: "pending",
    });

    const parsedJson = {
      youtube: true,
      videoId,
      title: body.title,
      symbol: execution.symbol,
      direction: execution.direction,
      entry: execution.planned.entryPrice,
      targets: execution.planned.takeProfitPrices,
      stopLoss: execution.planned.stopLossPrice,
    };

    const cardFields = buildDiscordCardFields({
      symbol: body.symbol,
      direction: body.direction,
      entry: body.entry,
      targets: normalizePriceList(body.targets),
      stopLoss: body.stopLoss,
      title: body.title || `YouTube 信号 · ${videoId}`,
      description: body.rawContent?.slice(0, 2000),
      sourceType: "youtube",
      sourceRef: videoId,
      note: body.note,
    });

    return archiveCard({
      messageId: `yt-${videoId}-${Date.now().toString(36)}`,
      channelId: "youtube",
      sourceType: "youtube",
      sourceRef: videoId,
      rawContent: body.rawContent || body.title || videoId,
      parsedJson,
      execution,
      cardFields,
      symbol: body.symbol,
      note: body.note,
      assetClass: body.assetClass,
      verifyMode: body.verifyMode,
    });
  }

  /** YouTube 文稿 coin-action 入场监听默认 ±5%、每 5min */
  const COIN_WATCH_BAND_PCT = 5;
  const COIN_WATCH_CHECK_MS = 300_000;

  /**
   * 将 paste 预览中的 coinActions 注册为可监听的归档卡片（仅入场 ±band）。
   * 只在文稿解析后调用；只同步币种操作结构化字段，不同步文稿全文。
   * 近 1 小时内同币种 + 入场价相近（≤1%）则跳过。
   * @param {{
   *   sourceRef: string,
   *   title?: string,
   *   rawContent?: string,
   *   coinActions?: Array<Record<string, unknown>>,
   *   bandPct?: number,
   * }} input
   */
  async function registerCoinActionWatches(input) {
    const sourceRef = String(input.sourceRef ?? "").trim();
    if (!sourceRef) throw new Error("sourceRef required");

    if (store.migrateCoinActionPasteCards) {
      const moved = await store.migrateCoinActionPasteCards(COIN_ACTION_SIGNAL_CHANNEL_ID);
      if (moved > 0) {
        log.info(`coin-action 卡片迁移至颜驰 channel=${COIN_ACTION_SIGNAL_CHANNEL_ID} count=${moved}`);
      }
    }

    const bandPct = Number(input.bandPct) > 0 ? Number(input.bandPct) : COIN_WATCH_BAND_PCT;
    const list = Array.isArray(input.coinActions) ? input.coinActions : [];
    /** @type {ReturnType<typeof archiveCardToClient>[]} */
    const cards = [];
    /** @type {Array<{ symbol: string, entry: string, reason: string }>} */
    const skipped = [];
    /** 本批次已同步的 entry，避免同文多条重复 */
    /** @type {Array<{ symbol: string, entry: string, execution: unknown }>} */
    const sessionSynced = [];

    for (let i = 0; i < list.length; i++) {
      const coin = /** @type {Record<string, unknown>} */ (list[i]);
      const symbol = String(coin.symbol ?? "").trim();
      const entry = String(coin.entry ?? "").trim();
      const actionType = String(coin.actionType ?? "new");
      if (!symbol || !entry || actionType === "end") continue;

      const safeRef = sourceRef.replace(/[^a-zA-Z0-9._-]+/g, "_").slice(0, 80);
      const messageId = `yt-paste-${safeRef}-${symbol}-${actionType}-${i}`.slice(0, 180);
      const direction = String(coin.direction ?? "").trim();
      const targets = normalizePriceList(coin.targets);
      const stopLoss = String(coin.stopLoss ?? "").trim();
      const coinNote = String(coin.description ?? "").trim().slice(0, 200);
      const typeLabel = actionTypeLabel(actionType);
      const bodyText = formatCoinActionCardBody({
        actionLabel: typeLabel,
        direction,
        entry,
        targets,
        stopLoss,
        bandPct,
        note: coinNote,
      });

      const execution = normalizeExecution({
        symbol,
        direction: coin.direction,
        planned: {
          entryPrice: entry,
          takeProfitPrices: targets,
          stopLossPrice: stopLoss || coin.stopLoss,
        },
        outcome: "pending",
      });

      const existing = store.getSignalCardByMessageId
        ? await store.getSignalCardByMessageId(messageId)
        : null;

      // 同文件重新解析 → 允许更新已有卡片；新建则做 1h 去重
      if (!existing) {
        const dupInSession = sessionSynced.find(
          (s) =>
            s.symbol === normalizeSymbol(symbol) &&
            isSimilarEntryPrice(s.entry, entry, COIN_ACTION_ENTRY_SIMILAR_PCT)
        );
        if (dupInSession) {
          skipped.push({ symbol, entry, reason: "同批文稿内币种+相近入场价" });
          continue;
        }

        const recentDup = await findRecentSimilarCoinAction(symbol, execution);
        if (recentDup) {
          skipped.push({
            symbol,
            entry,
            reason: `近1小时已有相近信号 #${recentDup.id ?? ""}`.trim(),
          });
          continue;
        }
      }

      const parsedJson = {
        youtube: true,
        paste: true,
        blogger: "颜驰",
        sourceRef,
        sourceTitle: String(input.title ?? "").slice(0, 200),
        coinActionIndex: i,
        actionType,
        description: coinNote || undefined,
        coinWatch: {
          entryOnly: true,
          bandPct,
          checkIntervalMs: COIN_WATCH_CHECK_MS,
        },
      };

      const cardFields = buildDiscordCardFields({
        symbol,
        direction,
        entry,
        targets,
        stopLoss,
        title: `${symbol} · ${typeLabel}`,
        description: bodyText,
        sourceType: "文章",
        sourceRef,
        note: `颜驰 · 文稿 coin-action · 入场监听 ±${bandPct}% · 每 5min`,
      });

      const cardsByStyle = { archive: bodyText };
      const note = `颜驰 · 文稿 coin-action · 入场监听 ±${bandPct}% · 每 5min`;

      if (existing) {
        const id = Number(existing.id ?? existing.ID);
        await store.updateSignalCard(id, {
          channelId: COIN_ACTION_SIGNAL_CHANNEL_ID,
          executionJson: execution,
          parsedJson,
          cardFieldsJson: cardFields,
          cardsByStyle: stampCardsByStyle(cardsByStyle, id),
          rawContent: bodyText,
          symbol: normalizeSymbol(symbol),
          status: "active",
          note,
        });
        const row = await store.getSignalCardById(id);
        if (row) cards.push(archiveCardToClient(row));
        sessionSynced.push({ symbol: normalizeSymbol(symbol), entry, execution });
        continue;
      }

      const created = await archiveCard({
        messageId,
        channelId: COIN_ACTION_SIGNAL_CHANNEL_ID,
        sourceType: "youtube",
        sourceRef,
        rawContent: bodyText,
        cardsByStyle,
        parsedJson,
        execution,
        cardFields,
        symbol,
        note,
        signalAt: new Date().toISOString(),
      });
      cards.push(created);
      sessionSynced.push({ symbol: normalizeSymbol(symbol), entry, execution });
    }

    log.info(
      `coin-action 监听注册 source=${sourceRef} registered=${cards.length} skipped=${skipped.length} total=${list.length}`
    );
    return { cards, registered: cards.length, skipped: skipped.length, skippedItems: skipped };
  }

  /**
   * @param {string} symbol
   * @param {unknown} execution
   */
  async function findRecentSimilarCoinAction(symbol, execution) {
    if (!store.listSignalCards) return null;
    const cutoff = Date.now() - COIN_ACTION_DEDUP_WINDOW_MS;
    const rows = await store.listSignalCards({
      channelId: COIN_ACTION_SIGNAL_CHANNEL_ID,
      symbol: normalizeSymbol(symbol) || symbol,
      limit: 100,
    });
    for (const row of rows) {
      const t = Math.max(
        rowTimeMs(row.signal_at ?? row.signalAt),
        rowTimeMs(row.created_at ?? row.createdAt),
        rowTimeMs(row.updated_at ?? row.updatedAt)
      );
      if (t < cutoff) continue;

      const prevEx = row.execution_json ?? row.executionJson;
      if (shouldSkipSimilarCoinAction(prevEx, execution, COIN_ACTION_ENTRY_SIMILAR_PCT)) {
        return row;
      }
      const rawParsed = row.parsed_json ?? row.parsedJson;
      const prevParsed =
        rawParsed && typeof rawParsed === "object"
          ? /** @type {Record<string, unknown>} */ (rawParsed)
          : typeof rawParsed === "string"
            ? (() => {
                try {
                  return /** @type {Record<string, unknown>} */ (JSON.parse(rawParsed));
                } catch {
                  return {};
                }
              })()
            : {};
      const prevEntry =
        normalizeExecution(prevEx).planned.entryPrice || String(prevParsed.entry ?? "");
      const nextEntry = normalizeExecution(execution).planned.entryPrice;
      if (isSimilarEntryPrice(prevEntry, nextEntry, COIN_ACTION_ENTRY_SIMILAR_PCT)) {
        return row;
      }
    }
    return null;
  }

  /** @param {unknown} v */
  function rowTimeMs(v) {
    if (v instanceof Date) return v.getTime();
    if (typeof v === "number" && Number.isFinite(v)) return v;
    const n = Date.parse(String(v ?? ""));
    return Number.isFinite(n) ? n : 0;
  }

  /** @param {string} type */
  function actionTypeLabel(type) {
    switch (String(type)) {
      case "new":
        return "新开仓";
      case "continue":
        return "持仓更新";
      case "toend":
        return "临近目标";
      case "end":
        return "已结束";
      default:
        return String(type || "信号");
    }
  }

  return { archiveCard, archiveFromYoutube, archiveCardToClient, registerCoinActionWatches };
}

/**
 * 币种操作 → 卡片正文（不含文稿全文）
 * @param {{
 *   actionLabel: string,
 *   direction?: string,
 *   entry?: string,
 *   targets?: string[],
 *   stopLoss?: string,
 *   bandPct?: number,
 *   note?: string,
 * }} opts
 */
export function formatCoinActionCardBody(opts) {
  /** @type {string[]} */
  const lines = [];
  if (opts.actionLabel) lines.push(String(opts.actionLabel));
  if (opts.direction) lines.push(String(opts.direction));
  if (opts.bandPct) lines.push(`监听 ±${opts.bandPct}%`);
  if (opts.entry) lines.push(`入场 ${opts.entry}`);
  const tps = Array.isArray(opts.targets) ? opts.targets.filter(Boolean) : [];
  if (tps.length) lines.push(`止盈 ${tps.join(" / ")}`);
  if (opts.stopLoss) lines.push(`止损 ${opts.stopLoss}`);
  if (opts.note) lines.push(`备注 ${opts.note}`);
  return lines.join("\n");
}

/** @param {Record<string, unknown>} row */
export function archiveCardToClient(row) {
  const base = signalCardToClient(row);
  let cardFields = row.card_fields_json ?? row.cardFieldsJson;
  if (typeof cardFields === "string") {
    try {
      cardFields = JSON.parse(cardFields);
    } catch {
      cardFields = null;
    }
  }
  let verify3h = row.verify_3h_json ?? row.verify3hJson;
  let verify1m = row.verify_1m_json ?? row.verify1mJson;
  let proximity = row.proximity_json ?? row.proximityJson;
  let backtest = row.backtest_json ?? row.backtestJson;
  for (const [key, val] of [
    ["verify3h", verify3h],
    ["verify1m", verify1m],
    ["proximity", proximity],
    ["backtest", backtest],
  ]) {
    if (typeof val === "string") {
      try {
        if (key === "verify3h") verify3h = JSON.parse(val);
        if (key === "verify1m") verify1m = JSON.parse(val);
        if (key === "proximity") proximity = JSON.parse(val);
        if (key === "backtest") backtest = JSON.parse(val);
      } catch {
        /* ignore */
      }
    }
  }

  const channelId = String(row.channel_id ?? row.channelId ?? base.channelId ?? "").trim();
  const dbChannelName = row.channel_name ?? row.channelName ?? null;

  return {
    ...base,
    channelId,
    channelName: resolveCardChannelName(channelId, dbChannelName),
    sourceType: String(row.source_type ?? row.sourceType ?? "discord"),
    sourceRef: row.source_ref ?? row.sourceRef ?? null,
    symbol: String(row.symbol ?? base.execution?.symbol ?? "").toUpperCase(),
    assetClass: String(row.asset_class ?? row.assetClass ?? "crypto"),
    verifyMode: String(row.verify_mode ?? row.verifyMode ?? "1d"),
    cardFields: cardFields && typeof cardFields === "object" ? cardFields : null,
    signalAt: resolveCardSignalAt(row) ?? base.createdAt,
    verify3h: verify3h && typeof verify3h === "object" ? verify3h : null,
    verify1m: verify1m && typeof verify1m === "object" ? verify1m : null,
    proximity: proximity && typeof proximity === "object" ? proximity : null,
    backtest: backtest && typeof backtest === "object" ? backtest : null,
  };
}
