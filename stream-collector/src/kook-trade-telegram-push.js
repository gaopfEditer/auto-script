/**
 * 配置的 Kook 群组出现「完整做单」消息时，经 Ollama 判断后 POST 到 Telegram 发送 API。
 */
import { isCompleteTradeSignal, normalizeTradeSignalText } from "../collector-ui-vue/src/lib/kookTradeSignalDetect.js";
import {
  classifyCompleteTradeByAi,
  KOOK_TRADE_SOCKET_SOURCES,
  mightBeTradeSignalRough,
} from "./kook-trade-ai-classify.js";
import { config } from "./config.js";
import { createSignalPublishHelper, resolveStyleIdsForGuild } from "./kook-signal-publish.js";
import { logPushBanner } from "./push-log-banner.js";

/**
 * @typedef {{
 *   messageId?: string;
 *   guildId?: string;
 *   channelId?: string;
 *   authorId?: string;
 *   authorNickname?: string | null;
 *   authorUsername?: string | null;
 *   createAtMs?: number;
 *   content?: string;
 *   source?: string;
 * }} TradePushRow
 */

/** @param {string} raw */
function parseGuildIdList(raw) {
  return String(raw ?? "")
    .split(/[,，\s|]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

function mergedPushGuildIds() {
  return [
    ...new Set([
      ...parseGuildIdList(config.kookGroupsPush),
      ...parseGuildIdList(config.kookTradePushGuildIds),
    ]),
  ];
}

/** @param {TradePushRow} row */
function isRealtimeSocketMessage(row) {
  const src = String(row.source ?? "").trim();
  return KOOK_TRADE_SOCKET_SOURCES.has(src);
}

/**
 * @param {TradePushRow} row
 * @param {{ summary?: string, kind?: "full" | "adjust" | "ignore" }} [ai]
 */
function formatTelegramText(row, ai = {}) {
  const summary = String(ai.summary ?? "").trim();
  const kind = ai.kind === "adjust" || ai.kind === "full" ? ai.kind : "full";
  const gid = String(row.guildId ?? "").trim();
  const author =
    String(row.authorNickname ?? "").trim() ||
    String(row.authorUsername ?? "").trim() ||
    String(row.authorId ?? "").trim();

  if (summary) {
    const tag = gid ? `[${gid}] ` : "";
    const who = author ? `${author}: ` : "";
    const prefix = kind === "adjust" ? "⚙ " : "";
    return `${tag}${who}${prefix}${summary}`;
  }

  const content = normalizeTradeSignalText(row.content ?? "");
  const lines = [];
  if (gid) lines.push(`[Kook 群组 ${gid}]`);
  if (author) lines.push(author);
  if (lines.length) lines.push("");
  lines.push(content.length > 500 ? `${content.slice(0, 500)}…` : content);
  return lines.join("\n");
}

/**
 * @param {string} content
 * @param {{ debug?: (s: string) => void }} log
 */
async function isCompleteTradeForPush(content, log) {
  if (!mightBeTradeSignalRough(content)) {
    return { push: false, reason: "rough_filter" };
  }

  if (config.ollamaTradeClassifyEnabled) {
    const ai = await classifyCompleteTradeByAi(content, {
      debug: (s) => log.debug?.(s),
    });
    if (ai) {
      return {
        push: ai.isSign,
        reason: ai.isSign ? `ai_${ai.kind}` : "ai_reject",
        summary: ai.content,
        kind: ai.kind,
        star: ai.star,
        via: ai.via,
      };
    }
    if (!config.ollamaTradeClassifyFallbackRegex) {
      return { push: false, reason: "ai_failed" };
    }
    log.debug?.("Ollama 分类失败，回退正则");
  }

  const regexOk = isCompleteTradeSignal(content);
  return { push: regexOk, reason: regexOk ? "regex" : "regex_reject", via: "fallback" };
}

/**
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 */
export function createKookTradeTelegramPush(log) {
  const guildIds = new Set(mergedPushGuildIds());
  const chatId = config.telegramPushChatId;
  const sendUrl = config.telegramSendUrl;
  const telegramEnabled = guildIds.size > 0 && chatId && sendUrl;
  const signalPublish = createSignalPublishHelper(log);
  const enabled = telegramEnabled || signalPublish.enabled;

  /** @type {Set<string>} */
  const pushedMessageIds = new Set();
  /** @type {Map<string, Promise<{ push: boolean }>>} */
  const inflightByMessageId = new Map();
  const MAX_TRACK = 12_000;

  function pruneDedup() {
    if (pushedMessageIds.size <= MAX_TRACK) return;
    for (const id of [...pushedMessageIds].slice(0, 6000)) pushedMessageIds.delete(id);
  }

  /**
   * @param {string} text
   */
  async function postTelegram(text, meta = {}) {
    logPushBanner(log, "info", `TELEGRAM_SEND_URL → POST ${sendUrl}`, [
      `chat_id: ${chatId}`,
      meta.guildId ? `guild_id: ${meta.guildId}` : "",
      meta.kind ? `kind: ${meta.kind}` : "",
      meta.styleIds?.length ? `style_ids: ${meta.styleIds.join(", ")}` : "",
      "--- 推送正文 ---",
      text,
    ].filter(Boolean));

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
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * @param {TradePushRow} row
   * @returns {Promise<{ ok?: boolean, skipped?: string, error?: string, ai?: string }>}
   */
  async function maybePush(row) {
    if (!enabled) return { skipped: "disabled" };

    const guildId = String(row.guildId ?? "").trim();
    const inTelegram = guildId && guildIds.has(guildId);
    const inSignal = guildId && signalPublish.signalGuilds.includes(guildId);
    if (!inTelegram && !inSignal) return { skipped: "guild" };

    if (!isRealtimeSocketMessage(row)) return { skipped: "not_socket" };

    const content = normalizeTradeSignalText(row.content ?? "");
    if (!content) return { skipped: "empty" };

    const messageId = String(row.messageId ?? "").trim();
    if (messageId && pushedMessageIds.has(messageId)) return { skipped: "dedup" };

    if (messageId && inflightByMessageId.has(messageId)) {
      return inflightByMessageId.get(messageId);
    }

    const run = async () => {
      const verdict = await isCompleteTradeForPush(content, log);
      if (!verdict.push) {
        return { skipped: verdict.reason, ai: verdict.summary };
      }

      let delivered = false;
      const errors = [];

      if (inSignal && signalPublish.enabled) {
        try {
          const sr = await signalPublish.maybePublish({ guildId, content });
          if (sr.ok) {
            delivered = true;
          }
        } catch (e) {
          const err = String(/** @type {Error} */ (e).message ?? e);
          errors.push(`signal: ${err}`);
          log.warn(`publish/signal 失败: ${err}`);
        }
      }

      if (inTelegram && telegramEnabled) {
        try {
          const styleIds =
            inSignal && signalPublish.enabled
              ? resolveStyleIdsForGuild(guildId, signalPublish.mapping)
              : [];
          await postTelegram(
            formatTelegramText(row, { summary: verdict.summary ?? "", kind: verdict.kind }),
            {
              guildId,
              kind: verdict.kind,
              styleIds,
            }
          );
          delivered = true;
        } catch (e) {
          const err = String(/** @type {Error} */ (e).message ?? e);
          errors.push(`telegram: ${err}`);
          log.warn(`Telegram 推送失败: ${err}`);
        }
      }

      if (delivered) {
        if (messageId) {
          pushedMessageIds.add(messageId);
          pruneDedup();
        }
        return { ok: true, ai: verdict.summary };
      }
      return { error: errors.join("; ") || "no_channel" };
    };

    const p = run();
    if (messageId) {
      inflightByMessageId.set(messageId, p);
      void p.finally(() => inflightByMessageId.delete(messageId));
    }
    return p;
  }

  if (enabled) {
    const parts = [];
    if (telegramEnabled) parts.push(`Telegram chat=${chatId}`);
    if (signalPublish.enabled) parts.push("publish/signal");
    log.info(
      `Kook 做单推送 | ${parts.join(" + ")} | AI=${config.ollamaTradeClassifyEnabled ? config.ollamaModel : "关"}`
    );
  }

  return {
    maybePush,
    enabled,
    guildIds: [...guildIds],
    chatId,
    sendUrl,
  };
}
