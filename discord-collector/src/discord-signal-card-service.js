/**
 * 信号卡片：去重 → 解析 → AI 多风格 → 入库 → Telegram → WS 广播。
 */
import { getSignalChannelConfig, isSignalChannel } from "./discord-signal-config.js";
import { createChannelTextDedup, normalizeSignalText, signalTextHash } from "./discord-signal-dedup.js";
import { generateCardsByStyles } from "./discord-signal-ai.js";
import { parseSignalText } from "./discord-signal-parsers.js";
import { createDiscordSignalTelegramPush } from "./discord-signal-telegram.js";

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {(channel: string, payload: Record<string, unknown>) => void} [broadcast]
 */
export function createDiscordSignalCardService(store, log, broadcast) {
  const dedup = createChannelTextDedup(store);
  const telegram = createDiscordSignalTelegramPush(log);
  let hydrated = false;

  async function ensureHydrated() {
    if (hydrated) return;
    await dedup.hydrate();
    hydrated = true;
  }

  /**
   * @param {Record<string, unknown>} row
   * @param {{ skipDedup?: boolean }} [opts]
   * @returns {Promise<{ skipped?: string, card?: Record<string, unknown> }>}
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

    const parsed = parseSignalText(content, chCfg.parser);
    if (!parsed) {
      log.debug(`信号未识别 channel=${channelId} parser=${chCfg.parser}`);
      return { skipped: "parse_failed" };
    }

    const cardsByStyle = await generateCardsByStyles(parsed, chCfg.styles, content, {
      debug: (s) => log.debug(s),
    });

    const textHash = signalTextHash(content);
    const cardRow = await store.insertSignalCard({
      messageId: messageId || `hash-${textHash.slice(0, 16)}`,
      channelId,
      guildId,
      sourceTextHash: textHash,
      rawContent: content,
      parsedJson: parsed,
      cardsByStyle,
      status: "active",
    });

    const telegramStyle = chCfg.telegramStyle || chCfg.styles[0] || "cn_brief";
    const telegramText = cardsByStyle[telegramStyle] ?? Object.values(cardsByStyle)[0] ?? content;

    if (telegram.enabled) {
      try {
        await telegram.send(telegramText, { channelId, cardId: cardRow.id });
        await store.markSignalCardTelegramSent(cardRow.id);
        cardRow.telegramSentAt = new Date().toISOString();
      } catch (e) {
        log.warn(`Telegram 推送失败: ${/** @type {Error} */ (e).message}`);
      }
    }

    const clientCard = signalCardToClient(cardRow);
    broadcast?.("meta", { kind: "signal_card_created", card: clientCard });
    log.info(`信号卡片 #${cardRow.id} channel=${channelId} styles=${Object.keys(cardsByStyle).join(",")}`);

    return { card: clientCard };
  }

  return { onMessage, dedup, telegram, signalCardToClient, ensureHydrated };
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
  return {
    id: Number(row.id),
    messageId: String(row.message_id ?? row.messageId ?? ""),
    channelId: String(row.channel_id ?? row.channelId ?? ""),
    guildId: String(row.guild_id ?? row.guildId ?? ""),
    rawContent: String(row.raw_content ?? row.rawContent ?? ""),
    parsedJson,
    cardsByStyle: cardsByStyle && typeof cardsByStyle === "object" ? cardsByStyle : {},
    status: String(row.status ?? "active"),
    expiresAt: row.expires_at ?? row.expiresAt ?? null,
    telegramSentAt: row.telegram_sent_at ?? row.telegramSentAt ?? null,
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
  };
}
