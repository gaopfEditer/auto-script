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
import { getSignalChannelConfig, COIN_ACTION_SIGNAL_CHANNEL_ID, isSignalChannel } from "./discord-signal-config.js";
import { detectAssetClass, resolveVerifyMode } from "./card-verify-policy.js";
import { stampCardFieldsUid, stampCardsByStyle } from "./card-uid.js";
import { buildCardSinkPayload, pickCardSinkText } from "./card-external-sink.js";
import { extractSignalCardRowId } from "./store.js";
import { messageContentPreview, messageRowToClientForPush } from "./discord-message-format.js";
import { isDebugMode } from "./discord-debug.js";
import { config } from "./config.js";
import {
  COIN_ACTION_DEDUP_WINDOW_MS,
  COIN_ACTION_ENTRY_SIMILAR_PCT,
  isSimilarEntryPrice,
  shouldSkipSimilarCoinAction,
} from "./discord-signal-numeric-dedup.js";
import {
  buildSignalCardMergePatch,
  findMergeTargetCard,
  resolveAuthorKey,
} from "./card-signal-merge.js";

/** Discord 雪花频道 ID（排除 api/youtube 等占位） */
function isDiscordChannelId(id) {
  return /^\d{16,22}$/.test(String(id ?? "").trim());
}

const CARD_FEED_PLACEHOLDER_IDS = new Set([
  "api",
  "youtube",
  "telegram",
  "discord",
  "manual",
  "external",
  "paste",
]);

/** 可写入 Show 时间线的频道 id（Discord 雪花 / Telegram 群 id 等） */
function isCardFeedChannelId(id) {
  const s = String(id ?? "").trim();
  if (!s || CARD_FEED_PLACEHOLDER_IDS.has(s.toLowerCase())) return false;
  if (isDiscordChannelId(s)) return true;
  return /^-?\d{8,22}$/.test(s);
}

/**
 * 非 Discord 来源的虚拟服务器（Show 左侧栏）。
 * @param {string} sourceType
 */
function resolveVirtualGuildForCardSource(sourceType) {
  const t = resolveSourcePlatform(sourceType);
  if (t === "telegram") return { guildId: "telegram", guildName: "Telegram" };
  if (t === "youtube") return { guildId: "youtube", guildName: "YouTube" };
  if (t === "x") return { guildId: "x", guildName: "X" };
  if (t === "api" || t === "manual") return { guildId: "external", guildName: "外部来源" };
  return null;
}

/**
 * 卡片 → Show 频道时间线正文。
 * @param {ReturnType<typeof archiveCardToClient>} card
 */
export function formatCardAsChannelMessage(card) {
  const text = pickCardSinkText(card);
  if (text) return String(text).trim().slice(0, 1900);
  const symbol = String(card.symbol ?? "").trim();
  const ex = card.execution && typeof card.execution === "object" ? card.execution : null;
  const dir = String(ex?.direction ?? "").trim();
  const entry = String(ex?.planned?.entryPrice ?? "").trim();
  const parts = ["【卡片】"];
  if (symbol) parts.push(symbol);
  if (dir) parts.push(dir);
  if (entry) parts.push(`入场 ${entry}`);
  const raw = String(card.rawContent ?? "").trim();
  if (raw) parts.push(raw.slice(0, 400));
  return parts.filter(Boolean).join("\n").slice(0, 1900) || "【卡片】";
}

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

export const SOURCE_TYPES = /** @type {const} */ ([
  "discord",
  "youtube",
  "telegram",
  "x",
  "api",
  "manual",
]);

/** 与 discord_signal_cards.source_type VARCHAR(32) 对齐 */
export const MAX_CARD_SOURCE_TYPE_LEN = 32;

/**
 * 复合来源里的平台段（twitter → x）。
 * @param {unknown} raw
 */
export function normalizeSourcePlatform(raw) {
  const s = String(raw ?? "").trim().toLowerCase();
  if (s === "twitter") return "x";
  return s;
}

/**
 * 开放 API `source` / `sourceType` 归一化。
 * 支持：`x`、`python-ai-operate:x`（项目:平台，twitter → x）。
 * @param {unknown} raw
 */
export function normalizeCardSourceType(raw) {
  const s = String(raw ?? "api").trim().toLowerCase();
  if (!s) return "api";
  const colon = s.indexOf(":");
  if (colon > 0) {
    const project = s.slice(0, colon).trim();
    const platform = normalizeSourcePlatform(s.slice(colon + 1));
    if (project && platform) {
      const out = `${project}:${platform}`;
      return out.length > MAX_CARD_SOURCE_TYPE_LEN ? out.slice(0, MAX_CARD_SOURCE_TYPE_LEN) : out;
    }
  }
  return normalizeSourcePlatform(s);
}

/**
 * @param {unknown} raw
 */
export function isValidCardSourceType(raw) {
  const s = normalizeCardSourceType(raw);
  if (!s) return false;
  if (s.length > MAX_CARD_SOURCE_TYPE_LEN) return false;
  if (SOURCE_TYPES.includes(/** @type {typeof SOURCE_TYPES[number]} */ (s))) return true;
  const colon = s.indexOf(":");
  if (colon <= 0 || colon >= s.length - 1) return false;
  const project = s.slice(0, colon);
  const platform = s.slice(colon + 1);
  if (!/^[a-z0-9][a-z0-9._-]*$/i.test(project)) return false;
  return SOURCE_TYPES.includes(/** @type {typeof SOURCE_TYPES[number]} */ (platform));
}

/**
 * 复合来源的平台段；纯平台名则原样返回。
 * @param {unknown} raw
 */
export function resolveSourcePlatform(raw) {
  const s = normalizeCardSourceType(raw);
  if (SOURCE_TYPES.includes(/** @type {typeof SOURCE_TYPES[number]} */ (s))) return s;
  const colon = s.indexOf(":");
  return colon > 0 ? s.slice(colon + 1) : s;
}

/**
 * 非 Discord 网关采集的卡片（外部 API / Telegram / X / YouTube / 手动等）允许删除。
 * @param {Record<string, unknown> | null | undefined} row
 */
export function isExternallySourcedCard(row) {
  if (!row || typeof row !== "object") return false;
  const sourceType = normalizeCardSourceType(row.source_type ?? row.sourceType ?? "discord");
  return resolveSourcePlatform(sourceType) !== "discord";
}

/**
 * 复合来源的项目段；无冒号则空串。
 * @param {unknown} raw
 */
export function resolveSourceProject(raw) {
  const s = normalizeCardSourceType(raw);
  const colon = s.indexOf(":");
  return colon > 0 ? s.slice(0, colon) : "";
}

/**
 * 归档卡片来源日志（排查用：频道 / YouTube / API 等）。
 * @param {ReturnType<typeof archiveCardToClient>} card
 * @param {{
 *   sourceType: string,
 *   channelId: string,
 *   guildId?: string,
 *   sourceRef?: string,
 *   messageId?: string,
 *   symbol?: string,
 *   assetClass?: string,
 *   verifyMode?: string,
 *   source?: string,
 *   note?: string,
 * }} meta
 */
export function formatCardSourceLog(card, meta) {
  const uid = card?.uid || (card?.id != null ? `#${card.id}` : "?");
  const sourceType = String(meta.sourceType || card?.sourceType || "?").toLowerCase();
  const channelId = String(meta.channelId || card?.channelId || "").trim();
  const channelName =
    String(card?.channelName || "").trim() || resolveCardChannelName(channelId, null) || "";
  const sourceRef = String(meta.sourceRef || card?.sourceRef || "").trim();
  const guildId = String(meta.guildId || "").trim();
  const messageId = String(meta.messageId || card?.messageId || "").trim();
  const symbol = String(meta.symbol || card?.symbol || "").trim();
  const assetClass = String(meta.assetClass || card?.assetClass || "").trim();
  const verifyMode = String(meta.verifyMode || card?.verifyMode || "").trim();
  const pipeline = String(meta.source || card?.source || "").trim();
  const note = String(meta.note || card?.note || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);

  /** @type {string[]} */
  const parts = [`卡片归档 ${uid}`, `sourceType=${sourceType}`];

  if (resolveSourcePlatform(sourceType) === "discord") {
    parts.push(
      channelName ? `discord频道=${channelName}(${channelId || "?"})` : `discord频道Id=${channelId || "?"}`
    );
    if (guildId) parts.push(`guildId=${guildId}`);
  } else if (resolveSourcePlatform(sourceType) === "youtube") {
    parts.push(`youtube=${sourceRef || channelId || "?"}`);
    if (channelId && channelId !== "youtube" && channelId !== sourceRef) {
      parts.push(`channelId=${channelId}${channelName ? `(${channelName})` : ""}`);
    }
  } else if (resolveSourcePlatform(sourceType) === "telegram") {
    const project = resolveSourceProject(sourceType);
    parts.push(
      project
        ? `telegram项目=${project}`
        : channelName
          ? `telegram=${channelName}(${channelId || sourceRef || "?"})`
          : `telegram=${sourceRef || channelId || "?"}`
    );
    if (channelName) parts.push(`channel=${channelName}(${channelId || "?"})`);
  } else if (resolveSourcePlatform(sourceType) === "x") {
    const project = resolveSourceProject(sourceType);
    parts.push(
      project
        ? `x项目=${project}`
        : channelName
          ? `x=${channelName}(${channelId || sourceRef || "?"})`
          : `x=${sourceRef || channelId || "?"}`
    );
    if (channelName) parts.push(`channel=${channelName}(${channelId || "?"})`);
  } else if (sourceType === "api" || resolveSourcePlatform(sourceType) === "api") {
    parts.push(`api来源=${sourceRef || channelId || "external"}`);
    if (channelId) parts.push(`channelId=${channelId}`);
  } else if (sourceType === "manual" || resolveSourcePlatform(sourceType) === "manual") {
    parts.push(`manual=${sourceRef || channelId || "ui"}`);
  } else {
    if (channelId) parts.push(`channelId=${channelId}${channelName ? `(${channelName})` : ""}`);
    if (sourceRef) parts.push(`sourceRef=${sourceRef}`);
  }

  if (messageId) parts.push(`messageId=${messageId}`);
  if (symbol) parts.push(`symbol=${symbol}`);
  if (assetClass) parts.push(`asset=${assetClass}`);
  if (verifyMode) parts.push(`verify=${verifyMode}`);
  if (pipeline) parts.push(`pipeline=${pipeline}`);
  if (note) parts.push(`note=${note}`);

  return parts.join(" ");
}

/**
 * Telegram 推送附带来源追溯行（API / Telegram 等经开放 API 归档的卡片）。
 * @param {ReturnType<typeof archiveCardToClient> | Record<string, unknown> | null | undefined} card
 */
export function formatTelegramCardSourceTrace(card) {
  if (!card || typeof card !== "object") return "";
  const sourceType = normalizeCardSourceType(card.sourceType ?? card.source_type ?? "api");
  const platform = resolveSourcePlatform(sourceType);
  const project = resolveSourceProject(sourceType);
  const sourceRef = String(card.sourceRef ?? card.source_ref ?? "").trim();
  const channelId = String(card.channelId ?? card.channel_id ?? "").trim();
  const channelName =
    String(card.channelName ?? card.channel_name ?? "").trim() ||
    resolveCardChannelName(channelId, null);
  const uid =
    card.uid != null && String(card.uid).trim()
      ? String(card.uid).trim()
      : card.id != null
        ? `#${card.id}`
        : "";

  /** @type {string[]} */
  const parts = [];

  if (project) parts.push(`项目=${project}`);

  if (platform === "api") {
    parts.push("API");
    if (sourceRef) parts.push(`ref=${sourceRef}`);
    if (channelName && channelId && channelId !== "api") {
      parts.push(`频道=${channelName}(${channelId})`);
    } else if (channelName) {
      parts.push(`频道=${channelName}`);
    } else if (channelId && channelId !== "api") {
      parts.push(`channelId=${channelId}`);
    }
  } else if (platform === "telegram") {
    parts.push("Telegram");
    if (channelName) parts.push(`群=${channelName}`);
    if (channelId) parts.push(`chat=${channelId}`);
    if (sourceRef) parts.push(`ref=${sourceRef}`);
  } else {
    parts.push(`source=${sourceType}`);
    if (sourceRef) parts.push(`ref=${sourceRef}`);
    if (channelName || channelId) {
      parts.push(
        channelName && channelId
          ? `频道=${channelName}(${channelId})`
          : channelName || `channelId=${channelId}`
      );
    }
  }

  if (uid) parts.push(`卡片${uid}`);

  return parts.length ? `【追溯】${parts.join(" · ")}` : "";
}

/**
 * 经开放 API 归档且需推 Telegram 的来源平台。
 * @param {unknown} sourceType
 */
export function shouldPushArchivedCardToTelegram(sourceType) {
  const platform = resolveSourcePlatform(sourceType);
  return platform === "telegram" || platform === "api";
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {(channel: string, payload: Record<string, unknown>) => void} [broadcast]
 * @param {{ cardSink?: ReturnType<typeof import("./card-external-sink.js").createCardExternalSink>, communityFeed?: ReturnType<typeof import("./community-feed-service.js").createCommunityFeedService>, telegram?: ReturnType<typeof import("./discord-signal-telegram.js").createDiscordSignalTelegramPush> }} [deps]
 */
export function createCardArchiveService(store, log, broadcast, deps = {}) {
  const cardSink = deps.cardSink ?? null;
  const communityFeed = deps.communityFeed ?? null;
  const telegram = deps.telegram ?? null;

  /**
   * 经开放 API 归档的卡片（API / Telegram 等）→ 推送到 TELEGRAM_PUSH_CHAT_ID，正文末尾附【追溯】来源行。
   * @param {ReturnType<typeof archiveCardToClient>} clientCard
   */
  async function pushArchivedCardToTelegram(clientCard) {
    if (!telegram?.enabled) return { skipped: "telegram_disabled" };
    const sourceType = normalizeCardSourceType(clientCard.sourceType);
    if (!shouldPushArchivedCardToTelegram(sourceType)) {
      return { skipped: "not_pushable_source" };
    }

    const text = pickCardSinkText(clientCard) || formatCardAsChannelMessage(clientCard);
    if (!String(text ?? "").trim()) return { skipped: "empty" };

    const channelId = String(clientCard.channelId ?? "").trim();
    const channelName = resolveCardChannelName(channelId, clientCard.channelName);
    const cardId = extractSignalCardRowId(clientCard.id);
    const platform = resolveSourcePlatform(sourceType);

    const trace = formatTelegramCardSourceTrace(clientCard);
    let bodyText = String(text).trim();
    if (trace && !bodyText.includes(trace)) {
      bodyText = `${bodyText}\n\n${trace}`;
    }

    const skipChannelLabel =
      platform === "api" &&
      (!channelId || channelId === "api" || CARD_FEED_PLACEHOLDER_IDS.has(channelId));

    try {
      await telegram.send(bodyText, {
        channelId,
        channelName,
        cardId: cardId ?? undefined,
        skipChannelLabel,
      });
      if (cardId && store.markSignalCardTelegramSent) {
        await store.markSignalCardTelegramSent(cardId);
      }
      log.info(
        `Telegram 推送归档卡片 #${cardId ?? "?"} source=${sourceType} channel=${channelName || channelId}`
      );
      return { ok: true };
    } catch (e) {
      log.warn(`Telegram 推送归档卡片失败: ${/** @type {Error} */ (e).message}`);
      return { error: String(/** @type {Error} */ (e).message ?? e) };
    }
  }

  /**
   * API/归档卡片写入对应频道时间线（按 signalAt/当前时间排序为最新）。
   * 频道不存在时自动创建虚拟服务器/频道（Telegram 等）。
   * @param {ReturnType<typeof archiveCardToClient>} clientCard
   * @param {{ force?: boolean }} [opts]
   */
  async function publishCardToChannelFeed(clientCard, opts = {}) {
    if (!config.cardApiInjectChannelMessage && !opts.force) {
      log.info("卡片→频道消息 跳过: CARD_API_INJECT_CHANNEL_MESSAGE=0");
      return { skipped: "disabled" };
    }
    const channelId = String(clientCard.channelId ?? "").trim();
    const sourceType = String(clientCard.sourceType ?? "api").trim().toLowerCase();
    const symbol = String(clientCard.symbol ?? "").trim();
    const cardUid = clientCard.uid || (clientCard.id != null ? `#${clientCard.id}` : "?");

    log.info(
      `收到卡片消息 ${cardUid} source=${sourceType} channelId=${channelId} symbol=${symbol || "-"} name=${String(clientCard.channelName ?? "").trim() || "-"}`
    );

    if (!isCardFeedChannelId(channelId)) {
      log.info(`卡片→频道消息 跳过: channelId=${channelId || "?"} 非可注入频道`);
      return { skipped: "not_feed_channel" };
    }

    let meta = store.getChannelMeta ? await store.getChannelMeta(channelId) : null;
    const knownBefore = Boolean(meta) || isSignalChannel(channelId);
    let channelCreated = false;
    let guildCreated = false;

    const channelName =
      String(clientCard.channelName ?? meta?.name ?? "").trim() ||
      resolveCardChannelName(channelId, null);

    if (!knownBefore) {
      let guildId = String(clientCard.guildId ?? meta?.guild_id ?? meta?.guildId ?? "").trim();
      let guildName = "";

      if (!guildId) {
        const virtual = resolveVirtualGuildForCardSource(sourceType);
        if (virtual) {
          guildId = virtual.guildId;
          guildName = virtual.guildName;
        }
      }

      if (guildId && guildName && store.upsertDiscordGuildsBatch) {
        const gn = await store.upsertDiscordGuildsBatch([{ guildId, name: guildName }]);
        if (gn > 0) {
          guildCreated = true;
          log.info(`卡片→创建服务器 ${guildName}(${guildId})`);
          broadcast?.("meta", { kind: "guilds_updated", count: gn });
        }
      }

      if (store.upsertDiscordChannelsBatch) {
        await store.upsertDiscordChannelsBatch([
          {
            channelId,
            guildId,
            name: channelName,
            type: 0,
          },
        ]);
        channelCreated = true;
        log.info(
          `卡片→创建频道 ${channelName}(${channelId}) guild=${guildId || "(空)"} source=${sourceType}`
        );
        if (guildId) {
          broadcast?.("meta", { kind: "channels_updated", guildId, count: 1 });
        }
      }

      meta = store.getChannelMeta ? await store.getChannelMeta(channelId) : null;
    } else {
      log.info(`卡片→频道已存在 ${channelName}(${channelId})`);
    }

    const guildId = String(
      clientCard.guildId ?? meta?.guild_id ?? meta?.guildId ?? ""
    ).trim();
    const signalIso = clientCard.signalAt || new Date().toISOString();
    const createdAtMs = Date.parse(String(signalIso)) || Date.now();
    const content = formatCardAsChannelMessage(clientCard);
    const messageId = `card-api-${clientCard.id ?? clientCard.uid ?? Date.now()}`;

    const row = {
      messageId,
      guildId,
      guildName: null,
      channelId,
      channelName,
      authorId: "card-api",
      authorUsername: "CardAPI",
      authorGlobalName: "卡片 API",
      authorAvatar: String(clientCard.channelAvatar ?? "").trim() || null,
      content,
      eventType: "MESSAGE_CREATE",
      source: "card_api",
      createdAtMs,
      receivedAt: new Date().toISOString(),
      rawJson: {
        cardApi: true,
        cardId: clientCard.id ?? null,
        cardUid: clientCard.uid ?? null,
        symbol: clientCard.symbol ?? null,
      },
    };

    if (store.insertDiscordMessagesBatch) {
      await store.insertDiscordMessagesBatch([row]);
    }

    broadcast?.("message", {
      kind: "discord_message_batch",
      debugMode: isDebugMode(),
      count: 1,
      source: "card_api",
      rows: [
        messageRowToClientForPush({
          message_id: row.messageId,
          guild_id: row.guildId,
          guild_name: row.guildName,
          channel_id: row.channelId,
          channel_name: row.channelName,
          author_id: row.authorId,
          author_username: row.authorUsername,
          author_global_name: row.authorGlobalName,
          author_avatar: row.authorAvatar,
          content: row.content,
          event_type: row.eventType,
          source: row.source,
          created_at_ms: row.createdAtMs,
          raw_json: row.rawJson,
        }),
      ],
      channels: [
        {
          channelId,
          guildId,
          name: channelName,
          lastMessagePreview: messageContentPreview(row),
          lastMessageAtMs: createdAtMs,
        },
      ],
    });

    // 与自动建卡一致，方便 Show 信号栏 upsert
    broadcast?.("meta", { kind: "signal_card_created", card: clientCard, source: "card_api" });
    log.info(
      `卡片→写入频道消息 ok channel=${channelName}(${channelId}) msg=${messageId} createdChannel=${channelCreated} createdGuild=${guildCreated} preview=${content.slice(0, 80)}`
    );
    return {
      ok: true,
      messageId,
      channelId,
      createdAtMs,
      channelCreated,
      guildCreated,
      channelExisted: !channelCreated,
    };
  }

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
   *   injectChannelMessage?: boolean,
   *   channelName?: string,
   *   channelAvatar?: string,
   *   images?: string[],
   * }} input
   */
  async function archiveCard(input) {
    const sourceType = normalizeCardSourceType(input.sourceType ?? "api");
    if (!isValidCardSourceType(sourceType)) {
      throw new Error(`invalid sourceType: ${sourceType}`);
    }
    const sourceProject = resolveSourceProject(sourceType);

    const execution = normalizeExecution(input.execution ?? input.executionJson ?? input, input.parsedJson);
    const symbol = normalizeSymbol(input.symbol ?? execution.symbol ?? extractSymbolFromPayload(input.parsedJson, execution));
    if (symbol) execution.symbol = symbol.replace("USDT", "");

    const rawContent = String(input.rawContent ?? "").trim();
    const channelNameIn = String(input.channelName ?? "").trim();
    const channelAvatarIn = String(input.channelAvatar ?? "").trim();
    const imagesIn = Array.isArray(input.images)
      ? input.images.map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];
    const prevParsed =
      input.parsedJson && typeof input.parsedJson === "object" && !Array.isArray(input.parsedJson)
        ? /** @type {Record<string, unknown>} */ (input.parsedJson)
        : {};
    const parsedJson = {
      ...prevParsed,
      ...(channelNameIn ? { channelName: channelNameIn } : {}),
      ...(channelAvatarIn ? { channelAvatar: channelAvatarIn } : {}),
      ...(imagesIn.length ? { images: imagesIn } : {}),
    };

    const cardFields =
      input.cardFields && typeof input.cardFields === "object"
        ? input.cardFields
        : buildCardFieldsFromExecution(execution, parsedJson, rawContent, {
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
        : detectAssetClass(symbol, parsedJson, execution, rawContent);
    const verifyMode = resolveVerifyMode(assetClass, input.verifyMode);
    const signalAtIso = input.signalAt ?? new Date().toISOString();
    const authorKey = resolveAuthorKey({
      parsedJson,
      note: input.note,
      sender: parsedJson.sender,
    });
    if (authorKey) parsedJson.authorKey = authorKey;

    if (symbol && authorKey) {
      const signalAtMs = new Date(signalAtIso).getTime();
      const mergeTarget = await findMergeTargetCard(store, {
        channelId,
        symbol,
        authorKey,
        direction: String(execution.direction ?? parsedJson.direction ?? ""),
        signalAtMs,
      });
      if (mergeTarget) {
        const openId = extractSignalCardRowId(mergeTarget.id ?? mergeTarget.ID);
        if (openId) {
          const patch = buildSignalCardMergePatch({
            prevRow: mergeTarget,
            parsedJson,
            executionJson: execution,
            rawContent: rawContent || String(cardFields.title ?? "归档卡片"),
            signalAt: signalAtIso,
            authorKey,
          });
          const mergedParsed = /** @type {Record<string, unknown>} */ (patch.parsedJson);
          const mergedExecution = patch.executionJson;
          const mergedRaw = patch.rawContent;
          const mergedFields = buildCardFieldsFromExecution(mergedExecution, mergedParsed, mergedRaw, {
            sourceType,
            sourceRef: input.sourceRef,
            note: input.note,
          });
          const mergedStyles = stampCardsByStyle(
            input.cardsByStyle ?? { archive: mergedRaw || String(mergedFields.title ?? "") },
            openId
          );
          const stampedFields = stampCardFieldsUid(mergedFields, openId);
          const updated =
            (await store.updateSignalCard(openId, {
              parsedJson: mergedParsed,
              executionJson: mergedExecution,
              rawContent: mergedRaw,
              signalAt: patch.signalAt,
              symbol: patch.symbol || symbol,
              cardsByStyle: mergedStyles,
              cardFieldsJson: stampedFields,
            })) ?? mergeTarget;
          if (!updated) {
            throw new Error(`合并更新卡片失败 openId=${openId}`);
          }
          const clientCard = archiveCardToClient(updated);
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
                    event: "updated",
                    parsed: mergedParsed,
                    execution: clientCard.execution,
                    embed: clientCard.cardFields,
                  })
                );
              } catch (e) {
                log.warn(`卡片外送异常: ${/** @type {Error} */ (e).message}`);
              }
            }
          }
          broadcast?.("meta", { kind: "signal_card_updated", card: clientCard });
          log.info(
            `归档雷同合并 → #${openId} channel=${channelId} symbol=${symbol} author=${authorKey}`
          );
          if (communityFeed?.publishCard) {
            try {
              const text =
                pickCardSinkText(clientCard) || formatCardAsChannelMessage(clientCard);
              await communityFeed.publishCard({
                text,
                channelId: String(clientCard.channelId ?? channelId),
                channelName: String(clientCard.channelName ?? ""),
                cardId: openId,
                symbol: String(clientCard.symbol ?? symbol ?? ""),
              });
            } catch (e) {
              log.warn(`社区消息频道(合并)失败: ${/** @type {Error} */ (e).message}`);
            }
          }
          await pushArchivedCardToTelegram(clientCard);
          return Object.assign(clientCard, { channelMessage: null, merged: true });
        }
      }
    }

    const row = await store.insertSignalCard({
      messageId,
      channelId,
      guildId: String(input.guildId ?? "").trim(),
      sourceTextHash: textHash,
      rawContent: rawContent || String(cardFields.title ?? "归档卡片"),
      parsedJson,
      cardsByStyle: input.cardsByStyle ?? { archive: rawContent || String(cardFields.title ?? "") },
      executionJson: execution,
      source: input.source ?? (sourceType === "manual" ? "manual" : "auto"),
      status: input.status ?? "active",
      note: input.note ?? null,
      sourceType,
      sourceRef: input.sourceRef ? String(input.sourceRef) : sourceProject || null,
      symbol,
      cardFieldsJson: cardFields,
      signalAt: signalAtIso,
      verifyMode,
      assetClass,
    });

    if (!row) {
      const offlineHint = store.offline
        ? "MySQL 未连接（collect:ui 离线模式），无法持久化卡片。请启动 MySQL 并重启 collect:ui。"
        : "insertSignalCard 返回空，建卡失败";
      throw new Error(offlineHint);
    }

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
    if (!clientCard?.id) {
      throw new Error("archiveCard: 建卡后无有效 id");
    }
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
    log.info(formatCardSourceLog(clientCard, {
      sourceType,
      channelId,
      guildId: String(input.guildId ?? "").trim(),
      sourceRef: input.sourceRef ? String(input.sourceRef) : "",
      messageId,
      symbol,
      assetClass,
      verifyMode,
      source: input.source ?? (sourceType === "manual" ? "manual" : "auto"),
      note: input.note != null ? String(input.note) : "",
    }));

    if (communityFeed?.publishCard) {
      try {
        const text =
          pickCardSinkText(clientCard) ||
          formatCardAsChannelMessage(clientCard);
        await communityFeed.publishCard({
          text,
          channelId: String(clientCard.channelId ?? channelId),
          channelName: String(clientCard.channelName ?? ""),
          cardId: clientCard.id != null ? Number(clientCard.id) : null,
          symbol: String(clientCard.symbol ?? symbol ?? ""),
        });
      } catch (e) {
        log.warn(`社区消息频道(归档)失败: ${/** @type {Error} */ (e).message}`);
      }
    }

    await pushArchivedCardToTelegram(clientCard);

    /** @type {Awaited<ReturnType<typeof publishCardToChannelFeed>> | null} */
    let channelMessage = null;
    const injectFlag = (() => {
      const v = input.injectChannelMessage;
      if (v === undefined || v === null || v === "") return undefined;
      if (v === true || v === 1 || v === "1" || v === "true") return true;
      if (v === false || v === 0 || v === "0" || v === "false") return false;
      return undefined;
    })();
    const injectPlatforms = new Set(["api", "manual", "youtube", "telegram", "x"]);
    const wantInject =
      injectFlag === true ||
      (injectFlag !== false && injectPlatforms.has(resolveSourcePlatform(sourceType)));
    if (wantInject) {
      try {
        channelMessage = await publishCardToChannelFeed(clientCard, {
          force: injectFlag === true,
        });
        if (channelMessage?.skipped) {
          log.info(
            `卡片→频道消息未写入: ${channelMessage.skipped}${channelMessage.error ? ` (${channelMessage.error})` : ""}`
          );
        }
      } catch (e) {
        log.warn(`卡片写入频道消息失败: ${/** @type {Error} */ (e).message}`);
        channelMessage = { skipped: "error", error: /** @type {Error} */ (e).message };
      }
    } else {
      log.info(`卡片→频道消息 跳过: injectChannelMessage=false source=${sourceType}`);
    }

    return Object.assign(clientCard, { channelMessage });
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
        if (row) {
          const client = archiveCardToClient(row);
          cards.push(client);
          log.info(
            formatCardSourceLog(client, {
              sourceType: "youtube",
              channelId: COIN_ACTION_SIGNAL_CHANNEL_ID,
              sourceRef,
              messageId,
              symbol: normalizeSymbol(symbol) || symbol,
              note: `${note} · 更新已有卡片`,
              source: "coin-action-update",
            })
          );
        }
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

  async function deleteCard(cardId) {
    const id = Number(cardId);
    if (!Number.isFinite(id) || id <= 0) throw new Error("invalid card id");
    const row = await store.getSignalCardById(id);
    if (!row) throw new Error("not found");
    if (!isExternallySourcedCard(row)) {
      throw new Error("Discord 采集卡片不可删除（仅外部 API / Telegram / X 等来源可删）");
    }

    const messageId = String(row.message_id ?? row.messageId ?? "").trim();
    const channelId = String(row.channel_id ?? row.channelId ?? "").trim();

    if (store.deleteDiscordMessageIfCardApi) {
      await store.deleteDiscordMessageIfCardApi(messageId);
    }
    if (store.deleteCommunityFeedByCardId) {
      await store.deleteCommunityFeedByCardId(id);
    }
    const deleted = await store.deleteSignalCard(id);
    if (!deleted) throw new Error("delete failed");

    broadcast?.("meta", {
      kind: "signal_card_deleted",
      cardId: id,
      channelId,
      messageId,
    });
    log.info(
      `删除外部卡片 #${id} sourceType=${row.source_type ?? row.sourceType} channel=${channelId}`
    );
    return { id, deleted: true, channelId, messageId };
  }

  async function deleteCards(cardIds) {
    const ids = Array.isArray(cardIds) ? cardIds : [];
    let deleted = 0;
    let skipped = 0;
    /** @type {Array<{ id: number, error: string }>} */
    const errors = [];
    for (const raw of ids) {
      const id = Number(raw);
      if (!Number.isFinite(id) || id <= 0) {
        skipped += 1;
        continue;
      }
      try {
        await deleteCard(id);
        deleted += 1;
      } catch (e) {
        const msg = String(/** @type {Error} */ (e).message ?? e);
        if (msg === "not found" || msg.includes("不可删除")) {
          skipped += 1;
        } else {
          errors.push({ id, error: msg });
        }
      }
    }
    return { deleted, skipped, failed: errors.length, errors };
  }

  return {
    archiveCard,
    archiveFromYoutube,
    archiveCardToClient,
    registerCoinActionWatches,
    publishCardToChannelFeed,
    deleteCard,
    deleteCards,
  };
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
  let progress = row.progress_json ?? row.progressJson;
  for (const [key, val] of [
    ["verify3h", verify3h],
    ["verify1m", verify1m],
    ["proximity", proximity],
    ["backtest", backtest],
    ["progress", progress],
  ]) {
    if (typeof val === "string") {
      try {
        if (key === "verify3h") verify3h = JSON.parse(val);
        if (key === "verify1m") verify1m = JSON.parse(val);
        if (key === "proximity") proximity = JSON.parse(val);
        if (key === "backtest") backtest = JSON.parse(val);
        if (key === "progress") progress = JSON.parse(val);
      } catch {
        /* ignore */
      }
    }
  }

  const channelId = String(row.channel_id ?? row.channelId ?? base.channelId ?? "").trim();
  const dbChannelName = row.channel_name ?? row.channelName ?? null;
  const parsed =
    base.parsedJson && typeof base.parsedJson === "object"
      ? /** @type {Record<string, unknown>} */ (base.parsedJson)
      : {};
  const parsedChannelName = String(parsed.channelName ?? "").trim();
  const channelAvatar = String(parsed.channelAvatar ?? "").trim();
  const images = Array.isArray(parsed.images)
    ? parsed.images.map((x) => String(x ?? "").trim()).filter(Boolean)
    : [];

  return {
    ...base,
    /** 正文（与 rawContent 同值） */
    body: String(base.rawContent ?? row.raw_content ?? row.rawContent ?? ""),
    channelId,
    channelName:
      parsedChannelName || resolveCardChannelName(channelId, dbChannelName),
    channelAvatar: channelAvatar || null,
    images,
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
    progress: progress && typeof progress === "object" ? progress : null,
  };
}
