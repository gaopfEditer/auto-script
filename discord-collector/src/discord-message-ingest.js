/**
 * 从 Gateway WS 帧与 REST 响应中提取 Discord 消息并落库。
 */
import { config } from "./config.js";
import { createDiscordContextCache } from "./discord-context-cache.js";
import { isDebugMode } from "./discord-debug.js";
import { resolveGuildIconUrl } from "./discord-avatar.js";
import {
  extractGuildChannelFromGateway,
  extractGuildChannelFromRest,
} from "./discord-guild-sync.js";
import {
  extractMessageFromPayload,
  extractMessagesFromRestBody,
  isChannelDetailUrl,
  isChannelMessagesUrl,
  isDiscordApiUrl,
  isDiscordNoiseApiUrl,
  parseChannelIdFromMessagesUrl,
  parseChannelMessagesQuery,
  parseGuildChannelFromDiscordUrl,
} from "./discord-gateway.js";
import {
  logMessageIngest,
  logTraffic,
  messageContentPreview,
  messageRowToClient,
  messageRowToClientForPush,
} from "./discord-message-format.js";
import { createChannelMessageDedup, messageDedupKey } from "./discord-message-dedup.js";
import { normalizeSignalText } from "./discord-signal-dedup.js";
import { isSignalChannel, getSignalChannelConfig } from "./discord-signal-config.js";
import { isBlockedWsPayload } from "./ws-noise-filter.js";

/**
 * @typedef {ReturnType<import("./store.js").openStore>} Store
 * @typedef {ReturnType<import("./logger.js").createLogger>} Logger
 */

/**
 * @param {Store} store
 * @param {Logger} log
 * @param {(channel: string, payload: Record<string, unknown>) => void} [broadcast]
 * @param {{ signalCards?: ReturnType<typeof import("./discord-signal-card-service.js").createDiscordSignalCardService>, telegramPush?: ReturnType<typeof import("./discord-telegram-message-push.js").createDiscordTelegramMessagePush>, webhookForward?: ReturnType<typeof import("./discord-webhook-forward.js").createDiscordWebhookForward> }} [opts]
 */
export function createDiscordMessageIngest(store, log, broadcast, opts = {}) {
  const { signalCards, telegramPush, webhookForward } = opts;
  const guildFilter = new Set(config.monitoredGuildIds);
  const context = createDiscordContextCache();
  const messageDedup = createChannelMessageDedup(store);
  const messageDedupReady = messageDedup.hydrate().catch((e) => {
    log.warn(`消息去重缓存加载失败: ${/** @type {Error} */ (e).message}`);
  });
  /** @type {Map<string, { url: string, method: string, pageUrl?: string }>} */
  const netMetaByRequestId = new Map();
  /** @type {Map<string, string>} channelId → guildId（页面导航 / channel API 推断） */
  const channelGuildHints = new Map();
  /** CDP Discord 页签当前 guild / channel（来自 pageUrl） */
  let cdpPageChannelId = "";
  let cdpPageGuildId = "";

  /** @returns {{ cdpChannelId: string, cdpGuildId: string }} */
  function cdpPageContext() {
    return { cdpChannelId: cdpPageChannelId, cdpGuildId: cdpPageGuildId };
  }

  /** @param {string} pageUrl */
  function rememberPageChannelGuild(pageUrl) {
    const parsed = parseGuildChannelFromDiscordUrl(pageUrl);
    if (!parsed?.channelId || !parsed.guildId || parsed.guildId === "@me") return;
    channelGuildHints.set(parsed.channelId, parsed.guildId);
    cdpPageChannelId = parsed.channelId;
    cdpPageGuildId = parsed.guildId;
  }

  /** @param {string} channelId @param {string} [pageUrl] */
  function guildHintForChannel(channelId, pageUrl = "") {
    const cid = String(channelId ?? "").trim();
    if (!cid) return "";
    const cached = channelGuildHints.get(cid);
    if (cached) return cached;
    rememberPageChannelGuild(pageUrl);
    const fromPage = channelGuildHints.get(cid);
    if (fromPage) return fromPage;
    const parsed = parseGuildChannelFromDiscordUrl(pageUrl);
    if (parsed?.channelId === cid && parsed.guildId && parsed.guildId !== "@me") {
      channelGuildHints.set(cid, parsed.guildId);
      return parsed.guildId;
    }
    return "";
  }

  /**
   * @param {Array<{ channelId?: string, guildId?: string, [key: string]: unknown }>} rows
   * @param {string} channelId
   * @param {{ pageUrl?: string }} [meta]
   */
  function applyGuildHints(rows, channelId, meta = {}) {
    const cid = String(channelId ?? "").trim();
    if (!cid) return;
    const gid = guildHintForChannel(cid, String(meta.pageUrl ?? ""));
    if (!gid) return;
    for (const r of rows) {
      if (!String(r.guildId ?? "").trim()) r.guildId = gid;
    }
  }

  /** @param {string | null | undefined} channelName @param {string} channelId */
  function resolveChannelDisplayName(channelName, channelId) {
    const id = String(channelId ?? "").trim();
    const name = String(channelName ?? "").trim();
    if (name && name !== id && name !== id.slice(-6)) return name;
    const cached = id ? context.getChannel(id) : null;
    if (cached?.name) {
      const cn = String(cached.name).trim();
      if (cn && cn !== id && cn !== id.slice(-6)) return cn;
    }
    return "";
  }

  function broadcastCdpActiveChannel(channelId, guildId, source = "rest_api") {
    const cid = String(channelId ?? "").trim();
    if (!cid) return;
    broadcast?.("meta", {
      kind: "cdp_active_channel",
      guildId: String(guildId ?? "").trim(),
      channelId: cid,
      source,
    });
  }

  /**
   * @param {string} url
   * @param {ReturnType<typeof extractMessageFromPayload>[]} rows
   * @param {{ pageUrl?: string, inserted?: number }} [meta]
   */
  function broadcastRestChannelBatch(url, rows, meta = {}) {
    const restQuery = meta.restQuery ?? parseChannelMessagesQuery(url);
    const cid = String(restQuery.channelId ?? parseChannelIdFromMessagesUrl(url) ?? "").trim();
    const gid = guildHintForChannel(cid, String(meta.pageUrl ?? "")) || String(rows[0]?.guildId ?? "");
    /** @type {Map<string, { channelId: string, guildId: string, name: string, lastMessagePreview: string, lastMessageAtMs: number }>} */
    const channelUpdates = new Map();
    for (const r of rows) {
      if (cid) r.channelId = cid;
      const chId = cid || String(r.channelId ?? "").trim();
      if (!chId) continue;
      const atMs = Number(r.createdAtMs) || 0;
      const prev = channelUpdates.get(chId);
      if (prev && atMs <= prev.lastMessageAtMs) continue;
      channelUpdates.set(chId, {
        channelId: chId,
        guildId: String(r.guildId ?? gid),
        name: resolveChannelDisplayName(r.channelName, chId),
        lastMessagePreview: messageContentPreview(r),
        lastMessageAtMs: atMs,
      });
    }
    if (cid && !channelUpdates.has(cid)) {
      channelUpdates.set(cid, {
        channelId: cid,
        guildId: gid,
        name: resolveChannelDisplayName("", cid),
        lastMessagePreview: "",
        lastMessageAtMs: 0,
      });
    }
    broadcast?.("message", {
      kind: "discord_message_batch",
      debugMode: isDebugMode(),
      count: meta.inserted ?? 0,
      source: "rest_api",
      restQuery: { ...restQuery, channelId: cid || restQuery.channelId },
      ...cdpPageContext(),
      rows: rows.map((r) =>
        messageRowToClientForPush({
          message_id: r.messageId,
          guild_id: r.guildId ?? gid,
          guild_name: r.guildName,
          channel_id: cid || r.channelId,
          channel_name: r.channelName,
          author_id: r.authorId,
          author_username: r.authorUsername,
          author_global_name: r.authorGlobalName,
          author_avatar: r.authorAvatar,
          content: r.content,
          event_type: r.eventType,
          source: r.source,
          created_at_ms: r.createdAtMs,
          raw_json: r.rawJson,
        })
      ),
      channels: [...channelUpdates.values()],
    });
    broadcastCdpActiveChannel(cid, gid, "rest_api");
  }

  /** @param {{ guildId?: string }} row */
  function passesGuildFilter(row) {
    if (!guildFilter.size) return true;
    const g = String(row.guildId ?? "").trim();
    if (!g) return true;
    return guildFilter.has(g);
  }

  /** @param {ReturnType<typeof extractGuildChannelFromGateway>} bundle */
  async function persistGuildChannelBundle(bundle) {
    const { guilds, channels } = bundle;
    if (guilds.length) {
      const n = await store.upsertDiscordGuildsBatch(guilds);
      if (n > 0) {
        broadcast?.("meta", { kind: "guilds_updated", count: n });
      }
    }
    if (channels.length) {
      const n = await store.upsertDiscordChannelsBatch(
        channels.map((c) => ({
          channelId: c.channelId,
          guildId: c.guildId,
          name: c.name,
          type: c.type,
        }))
      );
      if (n > 0) {
        broadcast?.("meta", {
          kind: "channels_updated",
          guildId: channels[0]?.guildId ?? "",
          count: n,
        });
      }
    }
    if (guilds.length || channels.length) {
      await store.purgeMisclassifiedGuilds().catch(() => {});
    }
  }

  /** @param {Array<{ guildId?: string, channelId?: string, channelName?: string | null, guildName?: string | null, [key: string]: unknown }>} rows */
  async function resolveGuildIds(rows) {
    for (const r of rows) {
      if (String(r.guildId ?? "").trim()) continue;
      const cid = String(r.channelId ?? "").trim();
      if (!cid) continue;
      const hint = channelGuildHints.get(cid);
      if (hint) {
        r.guildId = hint;
        continue;
      }
      const cached = context.getChannel(cid);
      if (cached?.guildId) {
        r.guildId = cached.guildId;
        channelGuildHints.set(cid, cached.guildId);
        continue;
      }
      const db = await store.getChannelMeta(cid);
      if (db?.guild_id) {
        r.guildId = String(db.guild_id);
        channelGuildHints.set(cid, r.guildId);
      }
      if (!r.channelName && db?.name) r.channelName = String(db.name);
    }
  }

  /** @param {Array<{ guildId?: string, channelId?: string, channelName?: string | null, guildName?: string | null, createdAtMs?: number, content?: string, rawJson?: unknown }>} rows */
  async function ensureEntitiesFromMessages(rows) {
    /** @type {Map<string, { guildId: string, name: string, icon?: string | null, iconUrl?: string }>} */
    const guildMap = new Map();
    /** @type {Map<string, { channelId: string, guildId: string, name: string, type: number }>} */
    const channelMap = new Map();

    for (const r of rows) {
      const cid = String(r.channelId ?? "").trim();
      const gid = String(r.guildId ?? "").trim();
      if (cid) {
        const sigCfg = getSignalChannelConfig(cid);
        const name = sigCfg?.name ?? resolveChannelDisplayName(r.channelName, cid);
        channelMap.set(cid, {
          channelId: cid,
          guildId: gid,
          name,
          type: 0,
        });
      }
      if (gid) {
        const prev = guildMap.get(gid);
        const name = r.guildName
          ? String(r.guildName)
          : prev?.name ?? `Server ${gid.slice(-6)}`;
        guildMap.set(gid, {
          guildId: gid,
          name,
          icon: prev?.icon ?? null,
          iconUrl: prev?.iconUrl ?? resolveGuildIconUrl(gid, null),
        });
      }
    }

    await persistGuildChannelBundle({
      guilds: [...guildMap.values()],
      channels: [...channelMap.values()],
    });
  }

  /**
   * 正文去重仅用于 REST 批量；Gateway 实时消息始终入库/推送（靠 message_id 去重）。
   * @param {ReturnType<typeof extractMessageFromPayload>[]} rows
   */
  async function filterContentDuplicates(rows) {
    await messageDedupReady;
    const sorted = [...rows].sort(
      (a, b) => Number(a.createdAtMs ?? 0) - Number(b.createdAtMs ?? 0)
    );
    /** @type {ReturnType<typeof extractMessageFromPayload>[]} */
    const kept = [];
    let skipped = 0;
    for (const r of sorted) {
      const text = String(r.content ?? "").trim();
      const cid = String(r.channelId ?? "").trim();
      const isGateway = String(r.source ?? "") === "gateway_ws";

      if (isGateway) {
        kept.push(r);
        if (text && cid) await messageDedup.remember(cid, text);
        continue;
      }

      if (!text || !cid) {
        kept.push(r);
        continue;
      }
      if (messageDedup.isDuplicate(cid, text)) {
        skipped += 1;
        log.debug(
          `[discord-dedup] 跳过重复 channel=${cid} key=${messageDedupKey(text).slice(0, 80)}`
        );
        continue;
      }
      kept.push(r);
      await messageDedup.remember(cid, text);
    }
    if (skipped > 0) {
      log.info(`[discord-dedup] 过滤重复正文 ${skipped} 条（保留 ${kept.length} 条）`);
    }
    return kept;
  }

  /** @param {ReturnType<typeof extractMessageFromPayload>[]} rows @param {{ broadcastLimit?: number, restChannelMessages?: boolean, restQuery?: ReturnType<typeof parseChannelMessagesQuery>, restMeta?: { pageUrl?: string } }} [opts] */
  async function persist(rows, { broadcastLimit = 20, restChannelMessages = false, restQuery = null, restMeta = null } = {}) {
    const valid = rows.filter(Boolean);
    if (!valid.length) return { inserted: 0, duplicate: 0 };

    await resolveGuildIds(valid);
    const enriched = valid.map((r) => context.enrichMessage(r)).filter(passesGuildFilter);
    if (!enriched.length) {
      if (restChannelMessages && restQuery?.channelId) {
        broadcastRestChannelBatch(
          `https://discord.com/api/v9/channels/${restQuery.channelId}/messages`,
          [],
          { ...restMeta, inserted: 0, restQuery }
        );
      }
      return { inserted: 0, duplicate: 0 };
    }

    await ensureEntitiesFromMessages(enriched);

    const toPersist = await filterContentDuplicates(enriched);
    if (!toPersist.length) {
      if (restChannelMessages && restQuery?.channelId) {
        broadcastRestChannelBatch(
          `https://discord.com/api/v9/channels/${restQuery.channelId}/messages`,
          [],
          { ...restMeta, inserted: 0, restQuery }
        );
      }
      return { inserted: 0, duplicate: enriched.length };
    }

    const isRestBatch =
      restChannelMessages ||
      (toPersist.length > 1 && toPersist.every((r) => r.source === "rest_api"));
    if (isRestBatch) {
      const q = restQuery?.before ? " before 翻页" : "";
      log.info(
        `[discord-api←] 频道 ${toPersist[0]?.channelId ?? "?"} 消息 ${toPersist.length} 条${q}`
      );
    } else {
      for (const row of toPersist) {
        // Gateway 实时消息日志见 DISCORD_GATEWAY_MESSAGE_LOG（默认不打印）
        if (String(row.source ?? "") === "gateway_ws") continue;
        logMessageIngest(log, row);
      }
    }

    /**
     * @param {ReturnType<typeof extractMessageFromPayload>[]} rows
     * @param {{ onlyNew?: Set<string> }} [opts]
     */
    function enqueueTelegramGatewayRows(rows, opts = {}) {
      if (!telegramPush?.enabled || isRestBatch) return;
      for (const r of rows) {
        if (String(r.source ?? "") !== "gateway_ws") continue;
        if (!String(r.content ?? "").trim()) continue;
        const cid = String(r.channelId ?? "").trim();
        if (isSignalChannel(cid)) continue;
        const mid = String(r.messageId ?? "").trim();
        if (opts.onlyNew && mid && !opts.onlyNew.has(mid)) continue;
        telegramPush.enqueue(r);
      }
    }

    /**
     * @param {ReturnType<typeof extractMessageFromPayload>[]} rows
     * @param {{ onlyNew?: Set<string> }} [opts]
     */
    function enqueueWebhookGatewayRows(rows, opts = {}) {
      if (!webhookForward?.enabled || isRestBatch) return;
      for (const r of rows) {
        if (String(r.source ?? "") !== "gateway_ws") continue;
        const mid = String(r.messageId ?? "").trim();
        if (opts.onlyNew && mid && !opts.onlyNew.has(mid)) continue;
        webhookForward.enqueue(r);
      }
    }

    /** @type {Set<string> | null} */
    let forwardNewIds = null;
    if (config.telegramPriorityForward && !isRestBatch && (telegramPush?.enabled || webhookForward?.enabled)) {
      const existing = await store.findExistingDiscordMessageIds(
        toPersist.map((r) => String(r.messageId ?? ""))
      );
      forwardNewIds = new Set(
        toPersist
          .filter((r) => !existing.has(String(r.messageId ?? "")))
          .map((r) => String(r.messageId ?? ""))
          .filter(Boolean)
      );
      enqueueTelegramGatewayRows(toPersist, { onlyNew: forwardNewIds });
      enqueueWebhookGatewayRows(toPersist, { onlyNew: forwardNewIds });
    }

    const result = await store.insertDiscordMessagesBatch(toPersist);

    const pushRows = toPersist;

    /** @type {Map<string, { channelId: string, guildId: string, name: string, lastMessagePreview: string, lastMessageAtMs: number }>} */
    const channelUpdates = new Map();
    for (const r of pushRows) {
      const cid = String(r.channelId ?? "").trim();
      if (!cid) continue;
      const atMs = Number(r.createdAtMs) || 0;
      const prev = channelUpdates.get(cid);
      if (prev && atMs <= prev.lastMessageAtMs) continue;
      channelUpdates.set(cid, {
        channelId: cid,
        guildId: String(r.guildId ?? ""),
        name: resolveChannelDisplayName(r.channelName, cid),
        lastMessagePreview: messageContentPreview(r),
        lastMessageAtMs: atMs,
      });
    }

    const limit = isRestBatch ? toPersist.length : broadcastLimit;
    const isGatewayRealtime =
      !isRestBatch && pushRows.some((r) => String(r.source ?? "") === "gateway_ws");
    // Gateway 实时：即使 message_id 已存在（REST 先拉过）也要推前端 WS
    const shouldPushUi = isRestBatch || result.inserted > 0 || isGatewayRealtime;
    if (pushRows.length && shouldPushUi) {
      broadcast?.("message", {
        kind: "discord_message_batch",
        debugMode: isDebugMode(),
        count: result.inserted,
        source: isRestBatch ? "rest_api" : pushRows[0]?.source ?? "",
        restQuery: isRestBatch && restQuery ? restQuery : undefined,
        ...cdpPageContext(),
        rows: pushRows.slice(0, limit).map((r) =>
          messageRowToClientForPush({
            message_id: r.messageId,
            guild_id: r.guildId,
            guild_name: r.guildName,
            channel_id: r.channelId,
            channel_name: r.channelName,
            author_id: r.authorId,
            author_username: r.authorUsername,
            author_global_name: r.authorGlobalName,
            author_avatar: r.authorAvatar,
            content: r.content,
            event_type: r.eventType,
            source: r.source,
            created_at_ms: r.createdAtMs,
            raw_json: r.rawJson,
          })
        ),
        channels: [...channelUpdates.values()],
      });
      if (isRestBatch && restQuery?.channelId) {
        const cid = String(restQuery.channelId).trim();
        const gid =
          guildHintForChannel(cid, String(restMeta?.pageUrl ?? "")) ||
          String(pushRows[0]?.guildId ?? channelUpdates.get(cid)?.guildId ?? "");
        broadcastCdpActiveChannel(cid, gid, "rest_api");
      } else if (!isRestBatch && cdpPageChannelId) {
        const onCdpPage = pushRows.some((r) => String(r.channelId ?? "") === cdpPageChannelId);
        if (onCdpPage) {
          broadcastCdpActiveChannel(cdpPageChannelId, cdpPageGuildId, "gateway_ws");
        }
      }
    }

    if (result.inserted > 0 && !isDebugMode()) {
      log.info(`Discord 消息入库 +${result.inserted}（重复 ${result.duplicate}）`);
    }

    /** @param {ReturnType<typeof extractMessageFromPayload>[]} rows */
    async function runSignalCardPipeline(rows) {
      if (!signalCards || !rows.length) return;
      await signalCards.ensureHydrated();
      for (const r of rows) {
        const cid = String(r.channelId ?? "").trim();
        const content = normalizeSignalText(String(r.content ?? ""));
        if (!cid || !content) continue;
        if (!isSignalChannel(cid)) continue;
        if (signalCards.dedup.isDuplicate(cid, content)) {
          log.debug(`信号卡片跳过重复 channel=${cid} preview=${content.slice(0, 80)}`);
          continue;
        }
        const src = String(r.source ?? "");
        log.info(
          `信号卡片处理 channel=${cid} message=${r.messageId} source=${src || "unknown"} preview=${content.slice(0, 60)}`
        );
        void signalCards.onMessage(r, { skipDedup: true }).catch((e) => {
          log.warn(`signal card: ${/** @type {Error} */ (e).message}`);
        });
        await signalCards.dedup.remember(cid, content);
      }
    }

    if (signalCards) {
      const gatewayRows = isRestBatch
        ? []
        : toPersist.filter((r) => String(r.source ?? "") !== "rest_api");
      const restInserted = Array.isArray(result.insertedRows) ? result.insertedRows : [];
      await runSignalCardPipeline([...gatewayRows, ...restInserted]);
    }

    if (!config.telegramPriorityForward && telegramPush?.enabled && !isRestBatch && result.inserted > 0) {
      const insertedIds = new Set(
        (Array.isArray(result.insertedRows) ? result.insertedRows : [])
          .map((r) => String(r.messageId ?? ""))
          .filter(Boolean)
      );
      enqueueTelegramGatewayRows(toPersist, { onlyNew: insertedIds });
    }

    if (!config.telegramPriorityForward && webhookForward?.enabled) {
      const gatewayRows = isRestBatch
        ? []
        : toPersist.filter((r) => String(r.source ?? "") === "gateway_ws");
      const restInserted = Array.isArray(result.insertedRows) ? result.insertedRows : [];
      for (const r of [...gatewayRows, ...restInserted]) {
        webhookForward.enqueue(r);
      }
    }

    return result;
  }

  /**
   * @param {string} url
   * @param {ReturnType<typeof extractMessageFromPayload>[]} rows
   */
  async function ingestRestChannelMessages(url, rows, meta = {}) {
    const restQuery = parseChannelMessagesQuery(url);
    const authoritativeChannelId = String(restQuery.channelId ?? parseChannelIdFromMessagesUrl(url) ?? "").trim();
    if (authoritativeChannelId) {
      for (const r of rows) {
        r.channelId = authoritativeChannelId;
      }
    }
    applyGuildHints(rows, authoritativeChannelId, meta);

    if (!rows.length) {
      log.info(`[discord-api←] 频道 ${authoritativeChannelId || "?"} 消息 0 条`);
      broadcastRestChannelBatch(url, [], { ...meta, inserted: 0, restQuery });
      return;
    }

    await persist(rows, {
      restChannelMessages: true,
      restQuery,
      restMeta: meta,
    });
  }

  /** @param {unknown} json */
  async function ingestGatewayJson(json) {
    context.ingestGatewayFrame(json);
    await persistGuildChannelBundle(extractGuildChannelFromGateway(json));
  }

  /** @param {Record<string, unknown>} payload */
  async function onWsFrame(payload) {
    const body = payload.body;
    const json =
      body && typeof body === "object" && "json" in body ? /** @type {{ json?: unknown }} */ (body).json : null;
    if (json == null) return;
    if (isBlockedWsPayload(json)) return;

    const row = extractMessageFromPayload(json);
    if (row) {
      if (!String(row.guildId ?? "").trim() && cdpPageChannelId && String(row.channelId ?? "") === cdpPageChannelId) {
        row.guildId = cdpPageGuildId;
      }
      await persist([row]);
    }

    void ingestGatewayJson(json).catch((e) => {
      log.warn(`Gateway 上下文同步失败: ${/** @type {Error} */ (e).message}`);
    });
  }

  /** @param {Record<string, unknown>} evt */
  async function onDiag(evt) {
    const kind = String(evt.kind ?? "");
    const requestId = String(evt.requestId ?? "");

    if (kind === "page") {
      const phase = String(evt.phase ?? "");
      const pageUrl = String(evt.url ?? evt.pageUrl ?? "");
      if (pageUrl && (phase === "framenavigated" || phase === "domcontentloaded" || phase === "load")) {
        rememberPageChannelGuild(pageUrl);
        const parsed = parseGuildChannelFromDiscordUrl(pageUrl);
        if (parsed?.channelId && parsed.guildId && parsed.guildId !== "@me") {
          if (phase === "framenavigated" || phase === "domcontentloaded") {
            broadcastCdpActiveChannel(parsed.channelId, parsed.guildId, "page_nav");
          }
        }
      }
      return;
    }

    if (kind === "net_request" && requestId) {
      const reqUrl = String(evt.url ?? "");
      const pageUrl = String(evt.pageUrl ?? "");
      rememberPageChannelGuild(pageUrl);
      const parsed = parseGuildChannelFromDiscordUrl(pageUrl);
      const msgCid = parseChannelIdFromMessagesUrl(reqUrl);
      if (parsed?.channelId && msgCid && parsed.channelId === msgCid && parsed.guildId !== "@me") {
        channelGuildHints.set(msgCid, parsed.guildId);
      }
      netMetaByRequestId.set(requestId, {
        url: reqUrl,
        method: String(evt.method ?? "?"),
        pageUrl,
      });
      trimNetMeta();
      if (isDebugMode() && isDiscordApiUrl(reqUrl) && !isDiscordNoiseApiUrl(reqUrl)) {
        log.info(`[discord-api→] ${evt.method} ${reqUrl}`);
      }
      return;
    }

    if ((kind === "net_response" || kind === "net_response_body") && requestId) {
      const url = String(evt.url ?? netMetaByRequestId.get(requestId)?.url ?? "");
      if (url) {
        const prev = netMetaByRequestId.get(requestId) ?? { url, method: "?" };
        netMetaByRequestId.set(requestId, { ...prev, url });
      }
    }

    if (kind === "ws_frame_parsed" && evt.parsedJson != null) {
      if (isBlockedWsPayload(evt.parsedJson, String(evt.rawPreview ?? ""))) return;
      void ingestGatewayJson(evt.parsedJson).catch((e) => {
        log.warn(`Gateway 上下文同步失败: ${/** @type {Error} */ (e).message}`);
      });
      return;
    }

    if (kind !== "net_response_body") return;

    const meta = netMetaByRequestId.get(requestId) ?? { url: "", method: "?" };
    const pageUrl = String(meta.pageUrl ?? evt.pageUrl ?? "");

    if (isDiscordNoiseApiUrl(meta.url)) {
      if (requestId) netMetaByRequestId.delete(requestId);
      return;
    }

    if (evt.bodyError) {
      if (isChannelMessagesUrl(meta.url)) {
        log.warn(`[discord-api✗] ${meta.method} ${meta.url} 响应体读取失败: ${evt.bodyError}`);
      }
      if (requestId) netMetaByRequestId.delete(requestId);
      return;
    }

    const bodyJson = evt.bodyJson;
    if (bodyJson == null) {
      if (isChannelMessagesUrl(meta.url)) {
        log.warn(`[discord-api✗] ${meta.method} ${meta.url} 响应体无法解析为 JSON`);
      }
      if (requestId) netMetaByRequestId.delete(requestId);
      return;
    }

    if (meta.url) {
      context.ingestRestBody(bodyJson, meta.url);
      await persistGuildChannelBundle(extractGuildChannelFromRest(bodyJson, meta.url));
    }

    if (isChannelDetailUrl(meta.url) && bodyJson && typeof bodyJson === "object" && !Array.isArray(bodyJson)) {
      const ch = /** @type {Record<string, unknown>} */ (bodyJson);
      if (ch.id != null && ch.guild_id != null) {
        channelGuildHints.set(String(ch.id), String(ch.guild_id));
      }
    }

    const isMessagesList = isChannelMessagesUrl(meta.url);
    const isDiscordTraffic =
      isDiscordApiUrl(meta.url) ||
      /gateway\.discord\.gg/i.test(meta.url) ||
      isMessagesList;

    if (isDiscordTraffic) {
      if (isDebugMode()) {
        logTraffic(log, "api", bodyJson, meta);
      } else if (isDiscordApiUrl(meta.url)) {
        log.debug(`[discord-api←] ${meta.method} ${meta.url}`);
      }
    }

    if (isMessagesList) {
      const rows = extractMessagesFromRestBody(bodyJson, meta.url);
      await ingestRestChannelMessages(meta.url, rows, { pageUrl });
    } else {
      const rows = extractMessagesFromRestBody(bodyJson, meta.url);
      if (rows.length) await persist(rows);
    }

    if (requestId) netMetaByRequestId.delete(requestId);
  }

  function trimNetMeta() {
    while (netMetaByRequestId.size > 8000) {
      const k = netMetaByRequestId.keys().next().value;
      if (k === undefined) break;
      netMetaByRequestId.delete(k);
    }
  }

  return {
    onWsFrame,
    onDiag,
    persist,
    context,
    getCdpPage: cdpPageContext,
    enrichForApi: (row) => context.enrichMessage(messageRowToClient(row)),
  };
}
