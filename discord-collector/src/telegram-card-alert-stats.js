/**
 * Telegram 交易卡片 → OI 形态胜率库登记（与 pattern_alert_stats 共用分批回溯）。
 */
import { config } from "./config.js";
import {
  readTelegramChannelProfiles,
  telegramChatIdsMatch,
} from "./telegram-channel-profiles.js";
import { createLogger } from "./logger.js";

const log = createLogger("tg-card-stats");

/** 非交易信号频道（如 twitter 先行）不参与胜率统计 */
const STATS_EXCLUDE_CHAT_IDS = new Set(["-1004346465376"]);

/** @param {unknown} chatId */
export function isStatsTrackedTelegramChannel(chatId) {
  const id = String(chatId ?? "").trim();
  if (!id) return false;
  for (const ex of STATS_EXCLUDE_CHAT_IDS) {
    if (telegramChatIdsMatch(ex, id)) return false;
  }
  const { channels } = readTelegramChannelProfiles();
  for (const ch of channels) {
    if (telegramChatIdsMatch(ch.chatId, id)) return true;
  }
  return false;
}

/**
 * @param {Record<string, unknown> | null | undefined} clientCard
 * @returns {Promise<{ ok: boolean, skipped?: string, error?: string }>}
 */
export async function recordTelegramCardAlertStats(clientCard) {
  if (!clientCard || typeof clientCard !== "object") {
    return { ok: false, skipped: "no_card" };
  }
  const channelId = String(clientCard.channelId ?? "").trim();
  if (!isStatsTrackedTelegramChannel(channelId)) {
    return { ok: false, skipped: "channel_not_tracked" };
  }
  const cardId = clientCard.id ?? clientCard.cardId;
  if (cardId == null || String(cardId).trim() === "") {
    return { ok: false, skipped: "no_card_id" };
  }

  const base = config.oiWebBaseUrl.replace(/\/$/, "");
  const url = `${base}/api/pattern-alert-stats/record-card`;
  const timeoutMs = Math.max(2000, config.oiHealthTimeoutMs || 3000);

  /** @type {AbortSignal | undefined} */
  let signal;
  /** @type {ReturnType<typeof setTimeout> | undefined} */
  let timer;
  if (typeof AbortSignal !== "undefined" && AbortSignal.timeout) {
    signal = AbortSignal.timeout(timeoutMs);
  } else if (typeof AbortController !== "undefined") {
    const ac = new AbortController();
    timer = setTimeout(() => ac.abort(), timeoutMs);
    signal = ac.signal;
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ card: clientCard }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      log.warn(
        `TG交易卡胜率登记失败 #${cardId} channel=${channelId} HTTP ${res.status}${body ? `: ${body.slice(0, 120)}` : ""}`,
      );
      return { ok: false, error: `http_${res.status}` };
    }
    const body = /** @type {{ ok?: boolean }} */ (await res.json().catch(() => ({})));
    if (body?.ok) {
      log.info(`TG交易卡胜率登记 #${cardId} channel=${channelId}`);
      return { ok: true };
    }
    return { ok: false, error: "oi_rejected" };
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message ?? e);
    log.warn(`TG交易卡胜率登记异常 #${cardId}: ${msg}`);
    return { ok: false, error: msg };
  } finally {
    if (timer) clearTimeout(timer);
  }
}
