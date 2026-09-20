/**
 * Telegram 交易信号 → python-ai-operate：AI 短评 + OI 截图 + CDP 发布。
 * POST http://127.0.0.1:8787/api/v1/trade-signal/publish
 *
 * 白名单：telegram/channel_profiles.json 的 `send` 数组（来源群 id）。
 * 在 pushArchivedCardToTelegram 成功后触发；CDP 正文去掉首行【频道/人员名】（TG 推送仍保留）。
 */
import { config } from "./config.js";
import { isCdpSendChannel } from "./telegram-channel-profiles.js";
import {
  isTelegramPushBypassMessage,
  resolveTelegramMessageRef,
} from "./telegram-card-push-dedup.js";
import { formatSendCdpLog } from "./signal-pipeline-log.js";

/** @type {Map<string, number>} */
const recentPublish = new Map();
const DEDUP_MS = Math.max(60_000, Number(process.env.TRADE_SIGNAL_AI_PUBLISH_DEDUP_MS ?? 600_000));

/** CDP 发布到平台时去掉首行【频道名/发言人】 */
const CDP_HEADER_LINE_RE = /^【[^】\n]{1,120}】\s*\n?/;

/** @param {unknown} text */
export function stripCdpPlatformHeader(text) {
  const s = String(text ?? "").trim();
  if (!s) return "";
  return s.replace(CDP_HEADER_LINE_RE, "").trimStart();
}

/** @param {unknown} raw */
function isTelegramSource(raw) {
  const s = String(raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/_/g, ":");
  if (!s) return false;
  if (s === "telegram") return true;
  return s.split(":")[0] === "telegram";
}

/** @param {string} key */
function markPublished(key) {
  const now = Date.now();
  recentPublish.set(key, now);
  if (recentPublish.size > 500) {
    for (const [k, t] of recentPublish) {
      if (now - t > DEDUP_MS) recentPublish.delete(k);
    }
  }
}

/** @param {string} key */
function wasRecentlyPublished(key) {
  const t = recentPublish.get(key);
  if (!t) return false;
  if (Date.now() - t > DEDUP_MS) {
    recentPublish.delete(key);
    return false;
  }
  return true;
}

/**
 * @param {Record<string, unknown>} card
 * @param {string} event
 */
function buildDedupKey(card, event, ingestSourceRef) {
  const msgRef = resolveTelegramMessageRef(card, ingestSourceRef);
  if (msgRef) {
    const ch = String(card?.channelId ?? "").trim();
    return `cdp:ch:${ch}:ref:${msgRef}:${event}`;
  }
  const id = card?.id;
  if (id != null && String(id).trim()) return `id:${id}:${event}`;
  const ch = String(card?.channelId ?? "").trim();
  const sym = String(card?.symbol ?? "").trim();
  const hash = String(card?.sourceTextHash ?? "").trim();
  return `ch:${ch}:${sym}:${hash}:${event}`;
}

/**
 * @param {Record<string, unknown>} card
 * @param {{ event?: string, log?: { info: Function, warn: Function }, narrativeOverride?: string }} [opts]
 */
/**
 * @param {Record<string, unknown>} card
 * @param {{ log?: { info: Function, warn: Function, debug?: Function }, event?: string, ingestSourceRef?: string }} opts
 * @param {string} reason
 */
function skipCdp(card, opts, reason) {
  const channelId = String(card?.channelId ?? "").trim();
  if (!isCdpSendChannel(channelId)) return;
  const msgRef = resolveTelegramMessageRef(card, opts.ingestSourceRef);
  opts.log?.info?.(
    formatSendCdpLog("cdp_skip", {
      cardId: card?.id ?? "?",
      channelId,
      symbol: String(card?.symbol ?? ""),
      sourceRef: msgRef || String(card?.sourceRef ?? ""),
      event: String(opts.event || "entry").trim() || "entry",
      reason,
    }),
  );
}

/**
 * @param {Record<string, unknown>} card
 * @param {{ event?: string, log?: { info: Function, warn: Function, debug?: Function }, narrativeOverride?: string, ingestSourceRef?: string }} [opts]
 * @returns {boolean} 是否已发起请求
 */
export function notifyTradeSignalAiPublish(card, opts = {}) {
  const channelId = String(card?.channelId ?? "").trim();
  const inSendWhitelist = isCdpSendChannel(channelId);

  if (!config.tradeSignalAiPublishEnabled) {
    skipCdp(card, opts, "TRADE_SIGNAL_AI_PUBLISH=0（请在 .env 设为 1 并重启 collect:ui）");
    return false;
  }
  if (!isTelegramSource(card?.sourceType ?? card?.source_type ?? "")) {
    skipCdp(card, opts, `非 Telegram 来源 sourceType=${card?.sourceType ?? card?.source_type ?? "?"}`);
    return false;
  }

  if (!inSendWhitelist) {
    return false;
  }

  const symbol = String(card?.symbol ?? "").trim();
  if (!symbol || symbol === "待补充") {
    skipCdp(card, opts, `symbol 无效 (${symbol || "空"})`);
    return false;
  }

  const ex =
    card?.execution && typeof card.execution === "object"
      ? /** @type {Record<string, unknown>} */ (card.execution)
      : {};
  const planned =
    ex.planned && typeof ex.planned === "object"
      ? /** @type {Record<string, unknown>} */ (ex.planned)
      : {};
  const direction = String(ex.direction ?? card?.direction ?? "").trim();
  if (!direction) {
    skipCdp(card, opts, `卡片 #${card?.id ?? "?"} 缺少 direction`);
    return false;
  }

  const event = String(opts.event || "entry").trim() || "entry";
  const narrativePreview = String(
    opts.narrativeOverride ?? card?.rawContent ?? card?.note ?? "",
  ).trim();
  const bypass = isTelegramPushBypassMessage(
    narrativePreview,
    opts.narrativeOverride,
    card?.rawContent,
    card?.note,
  );
  if (event === "update" && !config.tradeSignalAiPublishOnUpdate && !bypass) {
    skipCdp(card, opts, "合并更新默认不重复 CDP（TRADE_SIGNAL_AI_PUBLISH_ON_UPDATE=1 可开）");
    return false;
  }
  const dedupKey = buildDedupKey(card, event, opts.ingestSourceRef);
  if (!bypass && wasRecentlyPublished(dedupKey)) {
    skipCdp(
      card,
      opts,
      `同一条 TG 消息已 CDP ref=${resolveTelegramMessageRef(card, opts.ingestSourceRef) || dedupKey}`,
    );
    return false;
  }

  const targets = Array.isArray(planned.takeProfitPrices)
    ? planned.takeProfitPrices.map((x) => String(x ?? "").trim()).filter(Boolean)
    : Array.isArray(planned.targets)
      ? planned.targets.map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];
  const entry = String(planned.entryPrice ?? planned.entry ?? "").trim();
  const stopLoss = String(planned.stopLossPrice ?? planned.stopLoss ?? "").trim();
  const narrativeRaw =
    String(opts.narrativeOverride ?? "").trim() ||
    String(card?.rawContent ?? "").trim() ||
    String(card?.note ?? "").trim();
  const narrative = stripCdpPlatformHeader(narrativeRaw);
  const note = String(card?.note ?? "").trim();

  const base = String(config.tradeSignalAiPublishUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
  const url = `${base}/api/v1/trade-signal/publish`;
  /** @type {Record<string, unknown>} */
  const body = {
    symbol,
    direction,
    event,
    entry,
    targets,
    stopLoss,
    narrative,
    body: narrative,
    note,
    cardId: card?.id ?? null,
    channelId,
    async: true,
  };
  if (Array.isArray(config.tradeSignalAiPublishPlatforms) && config.tradeSignalAiPublishPlatforms.length) {
    body.platforms = config.tradeSignalAiPublishPlatforms;
  }
  if (config.tradeSignalAiPublishToken) {
    body.token = config.tradeSignalAiPublishToken;
  }

  if (!bypass) markPublished(dedupKey);
  const log = opts.log;
  const msgRef = resolveTelegramMessageRef(card, opts.ingestSourceRef);
  if (bypass) {
    log?.info?.(
      formatSendCdpLog("cdp_bypass", {
        cardId: card?.id ?? "?",
        channelId,
        symbol,
        sourceRef: msgRef || String(card?.sourceRef ?? ""),
        event,
        reason: "测试标记跳过去重",
      }),
    );
  }
  log?.info?.(
    formatSendCdpLog("cdp_post", {
      cardId: card?.id ?? "?",
      channelId,
      symbol,
      direction,
      sourceRef: msgRef || String(card?.sourceRef ?? ""),
      event,
      detail: url,
    }),
  );
  void fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      ...(config.tradeSignalAiPublishToken
        ? { Authorization: `Bearer ${config.tradeSignalAiPublishToken}` }
        : {}),
    },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  })
    .then(async (r) => {
      const text = await r.text();
      let j = null;
      try {
        j = JSON.parse(text);
      } catch {
        /* ignore */
      }
      if (!r.ok || j?.success === false) {
        recentPublish.delete(dedupKey);
        log?.warn?.(
          formatSendCdpLog("cdp_fail", {
            cardId: card?.id ?? "?",
            channelId,
            symbol,
            direction,
            sourceRef: msgRef || String(card?.sourceRef ?? ""),
            event,
            reason: `HTTP ${r.status} ${j?.error || text.slice(0, 160)}`,
          }),
        );
        return;
      }
      log?.info?.(
        formatSendCdpLog("cdp_ok", {
          cardId: card?.id ?? "?",
          channelId,
          symbol,
          direction,
          sourceRef: msgRef || String(card?.sourceRef ?? ""),
          event,
          jobId: j?.job_id || "?",
        }),
      );
    })
    .catch((e) => {
      recentPublish.delete(dedupKey);
      log?.warn?.(
        formatSendCdpLog("cdp_fail", {
          cardId: card?.id ?? "?",
          channelId,
          symbol,
          direction,
          sourceRef: msgRef || String(card?.sourceRef ?? ""),
          event,
          reason: String(e?.message || e),
        }),
      );
    });
  return true;
}
