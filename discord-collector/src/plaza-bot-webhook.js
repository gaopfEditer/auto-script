/**
 * 新交易信号卡 → OpenMausBot【main】币圈运营 webhook（广场筛选自动化）。
 */
import fs from "node:fs";

import { config } from "./config.js";
import { normalizeExecution } from "./discord-signal-execution.js";
import { isKolvipIngestSource } from "./discord-signal-card-source.js";
import { isKolvipTop10TelegramCardChannel } from "./kolvip-top10-telegram.js";
import { buildKolvipOperateEntryNarrative } from "./kolvip-operate-entry.js";
import { loadPlazaBotWebhookConfig } from "./plaza-bot-webhook-config.js";
import { isCdpSendChannel, isTelegramGroupChatId } from "./telegram-channel-profiles.js";

/** @type {Map<string, number>} */
const recentNotify = new Map();
const DEDUP_MS = Math.max(30_000, Number(process.env.PLAZA_BOT_WEBHOOK_DEDUP_MS ?? 120_000));
const TIMEOUT_MS = Math.max(3_000, Number(process.env.PLAZA_BOT_WEBHOOK_TIMEOUT_MS ?? 12_000));

let cachedCfg = /** @type {(ReturnType<typeof loadPlazaBotWebhookConfig> & { enabled: boolean }) | null} */ (null);
let cachedMtime = 0;

/**
 * @param {Record<string, unknown>} card
 * @param {{ source?: string }} [meta]
 */
export function shouldPlazaNotifySignalCard(card, meta = {}) {
  const channelId = String(card?.channelId ?? "").trim();
  const source = String(card?.source ?? meta.source ?? "").trim();
  const symbol = String(card?.symbol ?? "").trim();
  if (!symbol) return false;

  const telegramSend = isTelegramGroupChatId(channelId) && isCdpSendChannel(channelId);
  const kolvipTop10 = isKolvipTop10TelegramCardChannel(channelId);
  const kolvipSrc = isKolvipIngestSource(source);
  if (!telegramSend && !kolvipTop10 && !kolvipSrc) return false;

  const ex = normalizeExecution(card.execution, card.parsedJson ?? card.parsed_json);
  const direction = String(ex.direction ?? "").trim();
  return Boolean(direction);
}

/**
 * @param {unknown} iso
 */
function fmtSignalTimeShanghai(iso) {
  const s = String(iso ?? "").trim();
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/**
 * @param {string} channelId
 * @param {string} [channelName]
 * @param {string} [source]
 */
function resolveSourceLabel(channelId, channelName, source) {
  const name = String(channelName ?? "").trim();
  if (isTelegramGroupChatId(channelId) && isCdpSendChannel(channelId)) {
    return name ? `Telegram·${name}` : "Telegram·send白名单";
  }
  if (isKolvipIngestSource(source) || isKolvipTop10TelegramCardChannel(channelId)) {
    return name ? `KOLVIP·${name}` : "KOLVIP";
  }
  return name || source || channelId || "信号卡";
}

/**
 * @param {Record<string, unknown>} card
 * @param {{ channelName?: string; source?: string }} [meta]
 */
export function buildPlazaBotWebhookText(card, meta = {}) {
  const cardId = card?.id ?? "?";
  const channelId = String(card?.channelId ?? "");
  const ex = normalizeExecution(card.execution, card.parsedJson ?? card.parsed_json);
  const planned = ex.planned && typeof ex.planned === "object" ? ex.planned : {};
  const narrative = buildKolvipOperateEntryNarrative({
    symbol: String(card.symbol ?? ""),
    direction: String(ex.direction ?? ""),
    leverage: String(planned.leverage ?? ex.leverage ?? ""),
    entryRaw: String(planned.entryPrice ?? planned.entry ?? ""),
    bodyText: String(card.rawContent ?? card.body ?? ""),
  });
  const signalAt =
    card.signalAt ?? card.signal_at ?? card.createdAt ?? card.created_at ?? new Date().toISOString();
  const sourceLabel = resolveSourceLabel(channelId, meta.channelName, String(card.source ?? meta.source ?? ""));
  const lines = [
    `新交易信号卡 #${cardId}`,
    `来源：${sourceLabel}`,
    `发单：${fmtSignalTimeShanghai(signalAt)}（北京时间）`,
    `币种：${String(card.symbol ?? "").trim() || "—"}`,
    `方向：${String(ex.direction ?? "").trim() || "—"}`,
    "",
    narrative || String(card.rawContent ?? "").trim().slice(0, 800),
  ];
  return lines.join("\n").trim();
}

function loadConfigFresh() {
  const file = config.plazaBotWebhookFile;
  try {
    const st = fs.statSync(file);
    if (cachedCfg && st.mtimeMs === cachedMtime) return cachedCfg;
    cachedMtime = st.mtimeMs;
    cachedCfg = loadPlazaBotWebhookConfig(file);
    return cachedCfg;
  } catch {
    cachedCfg = loadPlazaBotWebhookConfig(file);
    cachedMtime = 0;
    return cachedCfg;
  }
}

/**
 * @param {Record<string, unknown>} card
 * @param {{ channelName?: string; source?: string; log?: { info?: (m: string) => void; warn?: (m: string) => void } }} [opts]
 */
export async function notifyPlazaBotSignalCard(card, opts = {}) {
  const log = opts.log;
  if (!shouldPlazaNotifySignalCard(card, opts)) return { skipped: "not_plaza_source" };

  const cardId = String(card?.id ?? "").trim();
  if (cardId) {
    const now = Date.now();
    const prev = recentNotify.get(cardId);
    if (prev && now - prev < DEDUP_MS) return { skipped: "dedup" };
    recentNotify.set(cardId, now);
    if (recentNotify.size > 400) {
      for (const [k, t] of recentNotify) {
        if (now - t > DEDUP_MS) recentNotify.delete(k);
      }
    }
  }

  const cfg = loadConfigFresh();
  if (!cfg.enabled || !cfg.url) return { skipped: "webhook_disabled" };

  const text = buildPlazaBotWebhookText(card, opts);
  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "text/plain; charset=utf-8" };
  const bearer = String(cfg.authorization_bearer ?? "").trim();
  if (bearer) headers.Authorization = `Bearer ${bearer}`;

  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), TIMEOUT_MS);
  try {
    const res = await fetch(cfg.url, {
      method: "POST",
      headers,
      body: text,
      signal: ac.signal,
    });
    if (!res.ok) {
      const snippet = (await res.text()).slice(0, 120);
      log?.warn?.(`[plaza-bot-webhook] HTTP ${res.status} card=#${cardId} ${snippet}`);
      return { ok: false, status: res.status };
    }
    log?.info?.(`[plaza-bot-webhook] 已通知广场筛选 card=#${cardId} symbol=${card.symbol ?? ""}`);
    return { ok: true };
  } catch (e) {
    log?.warn?.(`[plaza-bot-webhook] 请求失败 card=#${cardId}: ${/** @type {Error} */ (e).message}`);
    return { ok: false, error: /** @type {Error} */ (e).message };
  } finally {
    clearTimeout(timer);
  }
}

/** @param {void} */
export function resetPlazaBotWebhookStateForTest() {
  recentNotify.clear();
  cachedCfg = null;
  cachedMtime = 0;
}