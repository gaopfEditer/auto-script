/**
 * Promat 有效交易 → Telegram + SIGNAL_PUBLISH_URL（群组/style 映射同 kook-signal-publish）。
 */
import { PROMAT_ANALYSIS } from "./promat-analysis-config.js";
import { config } from "./config.js";
import { buildGuildStyleMapping, resolveStyleIdsForGuild } from "./kook-signal-publish.js";
import { logPushBanner } from "./push-log-banner.js";

/** @returns {{ url: string, strategyId: string, composeMode: string, publish: boolean, timeoutSec: number }} */
function resolvePromatPublishConfig() {
  const pub = PROMAT_ANALYSIS.publish;
  return {
    url: config.signalPublishUrl,
    strategyId: config.signalPublishStrategyId,
    composeMode: config.signalPublishComposeMode,
    publish: config.signalPublishPublish,
    timeoutSec: pub.timeoutSec,
  };
}

/**
 * @param {{
 *   is_signal: boolean;
 *   username: string;
 *   symbol: string;
 *   market_price: string;
 *   entry_price: string;
 *   exit_price: string;
 * }} parsed
 * @param {{ guildId?: string; authorDisplay?: string }} meta
 */
export function formatPromatTelegramText(parsed, meta = {}) {
  const gid = String(meta.guildId ?? "").trim();
  const author =
    String(parsed.username ?? "").trim() ||
    String(meta.authorDisplay ?? "").trim();
  const parts = [
    parsed.symbol || "",
    parsed.market_price ? `市价${parsed.market_price}` : "",
    parsed.entry_price ? `入场${parsed.entry_price}` : "",
    parsed.exit_price ? `出场${parsed.exit_price}` : "",
  ].filter(Boolean);
  const summary = parts.join(" ") || "做单信号";
  const tag = gid ? `[${gid}] ` : "";
  const who = author ? `${author}: ` : "";
  return `${tag}${who}${summary}`;
}

/**
 * @param {{
 *   signal: string;
 *   guildId: string;
 *   channelId?: string;
 *   messageId?: string;
 *   styleIds: string[];
 *   promat: Record<string, unknown>;
 *   strategyId?: string;
 *   composeMode?: string;
 *   publish?: boolean;
 * }} body
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 */
export async function postPromatDeparture(body, log) {
  const pub = resolvePromatPublishConfig();
  const url = pub.url;
  if (!url) throw new Error("未配置 SIGNAL_PUBLISH_URL");

  const payload = {
    signal: body.signal,
    style_ids: body.styleIds,
    strategy_id: body.strategyId ?? pub.strategyId,
    compose_mode: body.composeMode ?? pub.composeMode,
    publish: body.publish ?? pub.publish,
    promat: body.promat,
    guild_id: body.guildId,
    channel_id: body.channelId ?? "",
    message_id: body.messageId ?? "",
  };

  logPushBanner(log, "info", `SIGNAL_PUBLISH_URL → POST ${url}`, [
    `guild_id (KOOK_GROUPS_PUSH): ${body.guildId}`,
    `channel_id: ${body.channelId || "(空)"}`,
    `message_id: ${body.messageId || "(空)"}`,
    `style_ids: ${body.styleIds.join(", ") || "(空)"}`,
    `strategy_id: ${payload.strategy_id}`,
    `compose_mode: ${payload.compose_mode}`,
    `publish: ${payload.publish}`,
    "--- promat 结构化 ---",
    JSON.stringify(body.promat, null, 2),
    "--- signal 正文（原文）---",
    body.signal,
  ]);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), pub.timeoutSec * 1000);
  try {
    const r = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
      signal: controller.signal,
    });
    const text = await r.text().catch(() => "");
    if (!r.ok) {
      logPushBanner(log, "error", `SIGNAL_PUBLISH_URL 失败 HTTP ${r.status}`, [
        `guild_id: ${body.guildId}`,
        `message_id: ${body.messageId || "(空)"}`,
        text ? `response: ${text.slice(0, 500)}` : "",
      ]);
      throw new Error(`HTTP ${r.status}${text ? `: ${text.slice(0, 200)}` : ""}`);
    }
    logPushBanner(log, "info", "SIGNAL_PUBLISH_URL 成功", [
      `guild_id: ${body.guildId}`,
      `message_id: ${body.messageId || "(空)"}`,
      `style_ids: ${body.styleIds.join(", ")}`,
      text ? `response: ${text.slice(0, 300)}` : "",
    ]);
    return text;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {string} text
 * @param {{ guildId?: string; styleIds?: string[] }} meta
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 */
async function postPromatTelegram(text, meta, log) {
  const chatId = config.telegramPushChatId;
  const sendUrl = config.telegramSendUrl;
  if (!chatId || !sendUrl) return { skipped: "telegram_disabled" };

  logPushBanner(log, "info", `TELEGRAM_SEND_URL → POST ${sendUrl}`, [
    `chat_id: ${chatId}`,
    meta.guildId ? `guild_id: ${meta.guildId}` : "",
    meta.styleIds?.length ? `style_ids: ${meta.styleIds.join(", ")}` : "",
    "--- 推送正文 ---",
    text,
  ]);

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), config.telegramSendTimeoutMs);
  try {
    const r = await fetch(sendUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
      signal: controller.signal,
    });
    const body = await r.text().catch(() => "");
    if (!r.ok) {
      logPushBanner(log, "error", `TELEGRAM_SEND_URL 失败 HTTP ${r.status}`, [
        `chat_id: ${chatId}`,
        body ? `response: ${body.slice(0, 300)}` : "",
      ]);
      throw new Error(`HTTP ${r.status}${body ? `: ${body.slice(0, 200)}` : ""}`);
    }
    logPushBanner(log, "info", "TELEGRAM_SEND_URL 成功", [
      `chat_id: ${chatId}`,
      meta.guildId ? `guild_id: ${meta.guildId}` : "",
    ]);
    return { ok: true };
  } finally {
    clearTimeout(timer);
  }
}

/** @param {ReturnType<typeof import("./logger.js").createLogger>} log */
export function createPromatPublishHelper(log) {
  const mapping = buildGuildStyleMapping();
  const signalGuilds = new Set(mapping.orderedGuilds);
  const pubCfg = resolvePromatPublishConfig();
  const telegramEnabled =
    Boolean(config.telegramPushChatId) && Boolean(config.telegramSendUrl);
  const enabled =
    PROMAT_ANALYSIS.publish.enabled && Boolean(pubCfg.url) && signalGuilds.size > 0;

  if (enabled) {
    const pairs = mapping.orderedGuilds.map(
      (g) => `${g}→${resolveStyleIdsForGuild(g, mapping).join(",") || mapping.defaultStyle}`
    );
    const parts = [`publish/signal ${pubCfg.url}`];
    if (telegramEnabled) parts.push(`Telegram chat=${config.telegramPushChatId}`);
    log.info(`Promat 有效交易推送 | ${parts.join(" + ")} | ${pairs.join(" | ")}`);
  }

  /**
   * @param {{
   *   guildId: string;
   *   channelId?: string;
   *   messageId?: string;
   *   content?: string;
   *   authorDisplay?: string;
   *   parsed: {
   *     is_signal: boolean;
   *     username: string;
   *     symbol: string;
   *     market_price: string;
   *     entry_price: string;
   *     exit_price: string;
   *   };
   * }} row
   */
  async function maybePublish(row) {
    if (!PROMAT_ANALYSIS.publish.enabled) return { skipped: "promat_publish_disabled" };
    if (!row.parsed?.is_signal) return { skipped: "not_signal" };

    const guildId = String(row.guildId ?? "").trim();
    if (!guildId || !signalGuilds.has(guildId)) {
      logPushBanner(log, "info", "Promat 推送跳过 · guild 不在 KOOK_GROUPS_PUSH", [
        `guild_id: ${guildId || "(空)"}`,
        row.messageId ? `message_id: ${row.messageId}` : "",
        `已配置群组: ${[...signalGuilds].join(", ") || "(无)"}`,
      ]);
      return { skipped: "promat_guild" };
    }

    const styleIds = resolveStyleIdsForGuild(guildId, mapping);
    if (!styleIds.length) return { skipped: "no_style" };

    const authorDisplay = String(row.authorDisplay ?? "").trim();
    const promat = {
      ...row.parsed,
      username: row.parsed.username || authorDisplay || "",
      guild_id: guildId,
      channel_id: String(row.channelId ?? "").trim(),
      message_id: String(row.messageId ?? "").trim(),
    };
    /** publish/signal 使用消息原文 */
    const signal = String(row.content ?? "").trim();
    if (!signal) return { skipped: "empty" };

    const telegramText = formatPromatTelegramText(row.parsed, {
      guildId,
      authorDisplay,
    });

    let delivered = false;
    const errors = [];

    if (pubCfg.url) {
      try {
        await postPromatDeparture(
          {
            signal,
            guildId,
            channelId: row.channelId,
            messageId: row.messageId,
            styleIds,
            promat,
          },
          log
        );
        delivered = true;
      } catch (e) {
        errors.push(`signal: ${/** @type {Error} */ (e).message}`);
      }
    }

    if (telegramEnabled) {
      try {
        await postPromatTelegram(telegramText, { guildId, styleIds }, log);
        delivered = true;
      } catch (e) {
        errors.push(`telegram: ${/** @type {Error} */ (e).message}`);
      }
    }

    if (delivered) return { ok: true, styleIds };
    return { error: errors.join("; ") || "no_channel" };
  }

  return { maybePublish, enabled, signalGuilds: [...signalGuilds], mapping };
}
