/**
 * 社区信息流：消息频道（卡片，Telegram 同格式）+ Twitter 短贴（AI 解析）。
 */
import { config } from "./config.js";
import { formatTelegramWithChannelLabel } from "./discord-telegram-push-config.js";
import { extractTwitterSignalWithAi } from "./community-twitter-ai.js";

/**
 * @param {Record<string, unknown> | null} row
 */
export function feedMessageToClient(row) {
  if (!row) return null;
  let parsed = row.parsed_json ?? row.parsedJson ?? null;
  let meta = row.meta_json ?? row.metaJson ?? null;
  if (typeof parsed === "string") {
    try {
      parsed = JSON.parse(parsed);
    } catch {
      parsed = null;
    }
  }
  if (typeof meta === "string") {
    try {
      meta = JSON.parse(meta);
    } catch {
      meta = null;
    }
  }
  return {
    id: Number(row.id),
    feedType: String(row.feed_type ?? row.feedType ?? ""),
    channelId: row.channel_id ?? row.channelId ?? null,
    channelName: row.channel_name ?? row.channelName ?? null,
    cardId: row.card_id != null ? Number(row.card_id) : null,
    tweetId: row.tweet_id ?? row.tweetId ?? null,
    authorKey: row.author_key ?? row.authorKey ?? null,
    authorHandle: row.author_handle ?? row.authorHandle ?? null,
    authorName: row.author_name ?? row.authorName ?? null,
    authorAvatar: row.author_avatar ?? row.authorAvatar ?? null,
    content: String(row.content ?? ""),
    rawContent: row.raw_content ?? row.rawContent ?? null,
    parsed: parsed && typeof parsed === "object" ? parsed : null,
    meta: meta && typeof meta === "object" ? meta : null,
    createdAt: row.created_at ?? row.createdAt ?? null,
  };
}

/**
 * @param {Record<string, unknown> | null} row
 */
export function twitterAuthorToClient(row) {
  if (!row) return null;
  return {
    authorKey: String(row.author_key ?? row.authorKey ?? ""),
    handle: String(row.handle ?? ""),
    displayName: String(row.display_name ?? row.displayName ?? ""),
    avatarUrl: String(row.avatar_url ?? row.avatarUrl ?? ""),
    note: String(row.note ?? ""),
    createdAt: row.created_at ?? row.createdAt ?? null,
    updatedAt: row.updated_at ?? row.updatedAt ?? null,
  };
}

/**
 * @param {ReturnType<typeof import("./store.js").openStore>} store
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {(channel: string, payload: Record<string, unknown>) => void} [broadcast]
 */
export function createCommunityFeedService(store, log, broadcast) {
  /**
   * 卡片 → 消息频道（正文与 Telegram 一致：【频道名】+ 风格文案）。
   * @param {{
   *   text: string,
   *   channelId?: string,
   *   channelName?: string,
   *   cardId?: number|null,
   *   symbol?: string,
   *   meta?: Record<string, unknown>,
   * }} input
   */
  async function publishCard(input) {
    if (store.offline || !store.insertCommunityFeedMessage) {
      return { skipped: "db_offline" };
    }
    const cardId = input.cardId != null ? Number(input.cardId) : null;
    // 同卡合并/补发：更新已有条目正文（与再次推 TG 对齐），否则新建
    if (cardId && store.findCommunityFeedByCardId) {
      const exists = await store.findCommunityFeedByCardId(cardId);
      if (exists) {
        const body = formatTelegramWithChannelLabel(
          input.text,
          input.channelId,
          input.channelName
        );
        if (!body.trim()) return { skipped: "empty" };
        const updated =
          (await store.updateCommunityFeedMessage?.(Number(exists.id), {
            content: body,
            rawContent: String(input.text ?? ""),
            channelId: input.channelId || exists.channel_id,
            channelName: input.channelName || exists.channel_name,
            metaJson: {
              symbol: input.symbol || null,
              ...(input.meta && typeof input.meta === "object" ? input.meta : {}),
              updatedAt: new Date().toISOString(),
            },
          })) || exists;
        const client = feedMessageToClient(updated);
        if (client) {
          broadcast?.("community", {
            kind: "feed_message_updated",
            feedType: "card",
            message: client,
          });
        }
        return { ok: true, updated: true, message: client };
      }
    }
    const body = formatTelegramWithChannelLabel(
      input.text,
      input.channelId,
      input.channelName
    );
    if (!body.trim()) return { skipped: "empty" };

    const row = await store.insertCommunityFeedMessage({
      feedType: "card",
      channelId: input.channelId || null,
      channelName: input.channelName || null,
      cardId: Number.isFinite(cardId) && cardId > 0 ? cardId : null,
      content: body,
      rawContent: String(input.text ?? ""),
      metaJson: {
        symbol: input.symbol || null,
        ...(input.meta && typeof input.meta === "object" ? input.meta : {}),
      },
    });
    const client = feedMessageToClient(row);
    broadcast?.("community", { kind: "feed_message", feedType: "card", message: client });
    log.info(
      `社区消息频道 card=#${cardId ?? "?"} channel=${input.channelName || input.channelId || "-"}`
    );
    return { ok: true, message: client };
  }

  /**
   * Twitter 短贴 → 社区 Twitter Tab；异步 AI 解析。
   * @param {{
   *   tweetId: string,
   *   text: string,
   *   tweetUrl?: string,
   *   listId?: string,
   *   listLabel?: string,
   *   handle?: string,
   *   displayName?: string,
   *   avatarUrl?: string,
   *   authorId?: string,
   *   tweetAt?: string|null,
   * }} tweet
   */
  async function publishTweet(tweet) {
    if (store.offline || !store.insertCommunityFeedMessage) {
      return { skipped: "db_offline" };
    }
    const tweetId = String(tweet.tweetId ?? "").trim();
    if (!tweetId) return { skipped: "no_tweet_id" };
    if (store.findCommunityFeedByTweetId) {
      const exists = await store.findCommunityFeedByTweetId(tweetId);
      if (exists) return { skipped: "duplicate", id: Number(exists.id) };
    }

    const handle = String(tweet.handle ?? "").replace(/^@/, "").trim();
    const authorKey = String(tweet.authorId || handle || tweetId).trim();
    const displayName = String(tweet.displayName || handle || "Twitter").trim();
    const avatarUrl = String(tweet.avatarUrl || "").trim();

    if (authorKey && store.upsertCommunityTwitterAuthor) {
      await store.upsertCommunityTwitterAuthor({
        authorKey,
        handle,
        displayName,
        avatarUrl,
      });
    }

    const who = displayName && handle ? `${displayName} (@${handle})` : `@${handle || authorKey}`;
    const content = [
      `【Twitter】${tweet.listLabel || ""}`.trim(),
      who,
      String(tweet.text || "").trim() || "(无文字)",
      tweet.tweetUrl || "",
    ]
      .filter(Boolean)
      .join("\n");

    const row = await store.insertCommunityFeedMessage({
      feedType: "twitter",
      channelId: tweet.listId || null,
      channelName: tweet.listLabel || null,
      tweetId,
      authorKey,
      authorHandle: handle || null,
      authorName: displayName || null,
      authorAvatar: avatarUrl || null,
      content,
      rawContent: String(tweet.text || ""),
      parsedJson: { status: "pending" },
      metaJson: {
        tweetUrl: tweet.tweetUrl || null,
        listId: tweet.listId || null,
      },
      createdAt: tweet.tweetAt || new Date().toISOString(),
    });

    let client = feedMessageToClient(row);
    broadcast?.("community", { kind: "feed_message", feedType: "twitter", message: client });

    // 异步 AI 解析（不阻塞抓取）
    void analyzeTweetAsync(Number(row?.id), String(tweet.text || ""), {
      handle,
      displayName,
      tweetUrl: tweet.tweetUrl,
    }).catch((e) => log.debug(`Twitter AI 解析: ${/** @type {Error} */ (e).message}`));

    return { ok: true, message: client };
  }

  /**
   * @param {number} feedId
   * @param {string} rawText
   * @param {{ handle?: string, displayName?: string, tweetUrl?: string }} ctx
   */
  async function analyzeTweetAsync(feedId, rawText, ctx) {
    if (!Number.isFinite(feedId) || feedId <= 0) return;
    if (!config.ollamaEnabled) {
      await store.updateCommunityFeedParsed?.(feedId, {
        status: "skipped",
        reason: "ollama_disabled",
      });
      return;
    }
    const parsed = await extractTwitterSignalWithAi(rawText, ctx);
    const status = parsed ? "ok" : "empty";
    const payload = parsed
      ? { status, ...parsed }
      : { status, reason: "no_signal" };
    const updated = await store.updateCommunityFeedParsed?.(feedId, payload);
    const client = feedMessageToClient(updated);
    if (client) {
      broadcast?.("community", { kind: "feed_message_updated", feedType: "twitter", message: client });
    }
  }

  /**
   * @param {{ feedType?: string, beforeId?: number, limit?: number }} [opts]
   */
  async function listFeed(opts = {}) {
    if (!store.listCommunityFeedMessages) return [];
    const rows = await store.listCommunityFeedMessages(opts);
    return rows.map((r) => feedMessageToClient(r)).filter(Boolean);
  }

  async function listAuthors(limit = 200) {
    if (!store.listCommunityTwitterAuthors) return [];
    const rows = await store.listCommunityTwitterAuthors(limit);
    return rows.map((r) => twitterAuthorToClient(r)).filter(Boolean);
  }

  /**
   * @param {{ authorKey: string, handle?: string, displayName?: string, avatarUrl?: string, note?: string }} body
   */
  async function upsertAuthor(body) {
    if (!store.upsertCommunityTwitterAuthor) return null;
    const row = await store.upsertCommunityTwitterAuthor(body);
    const client = twitterAuthorToClient(row);
    broadcast?.("community", { kind: "twitter_author_upserted", author: client });
    return client;
  }

  return {
    publishCard,
    publishTweet,
    listFeed,
    listAuthors,
    upsertAuthor,
    feedMessageToClient,
  };
}
