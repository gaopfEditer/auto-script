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
import { getSignalChannelConfig } from "./discord-signal-config.js";
import { detectAssetClass, resolveVerifyMode } from "./card-verify-policy.js";

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
 */
export function createCardArchiveService(store, log, broadcast) {
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

    const clientCard = archiveCardToClient(row);
    broadcast?.("meta", { kind: "card_archived", card: clientCard });
    log.info(`卡片归档 #${clientCard.id} source=${sourceType} symbol=${symbol}`);
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

  return { archiveCard, archiveFromYoutube, archiveCardToClient };
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
  for (const [key, val] of [
    ["verify3h", verify3h],
    ["verify1m", verify1m],
    ["proximity", proximity],
  ]) {
    if (typeof val === "string") {
      try {
        if (key === "verify3h") verify3h = JSON.parse(val);
        if (key === "verify1m") verify1m = JSON.parse(val);
        if (key === "proximity") proximity = JSON.parse(val);
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
  };
}
