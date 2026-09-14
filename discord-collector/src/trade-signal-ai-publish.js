/**
 * Telegram 交易信号 → python-ai-operate：AI 短评 + OI 截图 + CDP 发布。
 * POST http://127.0.0.1:8787/api/v1/trade-signal/publish
 *
 * 白名单：telegram/channel_profiles.json 的 `send` 数组（来源群 id）。
 * 在 pushArchivedCardToTelegram 成功后触发，正文与发到 Telegram 的一致。
 */
import { config } from "./config.js";
import { isCdpSendChannel } from "./telegram-channel-profiles.js";
import {
  isTelegramPushBypassMessage,
  resolveTelegramMessageRef,
} from "./telegram-card-push-dedup.js";

/** @type {Map<string, number>} */
const recentPublish = new Map();
const DEDUP_MS = Math.max(60_000, Number(process.env.TRADE_SIGNAL_AI_PUBLISH_DEDUP_MS ?? 600_000));

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
/** @param {{ log?: { info: Function, warn: Function, debug?: Function } }} opts @param {string} reason */
function skipCdp(opts, reason) {
  opts.log?.info?.(`trade-signal CDP 跳过: ${reason}`);
}

/**
 * @param {Record<string, unknown>} card
 * @param {{ event?: string, log?: { info: Function, warn: Function, debug?: Function }, narrativeOverride?: string, ingestSourceRef?: string }} [opts]
 * @returns {boolean} 是否已发起请求
 */
export function notifyTradeSignalAiPublish(card, opts = {}) {
  if (!config.tradeSignalAiPublishEnabled) {
    skipCdp(opts, "TRADE_SIGNAL_AI_PUBLISH=0（请在 .env 设为 1 并重启 collect:ui）");
    return false;
  }
  if (!isTelegramSource(card?.sourceType ?? card?.source_type ?? "")) {
    skipCdp(opts, `非 Telegram 来源 sourceType=${card?.sourceType ?? card?.source_type ?? "?"}`);
    return false;
  }

  const channelId = String(card?.channelId ?? "").trim();
  if (!isCdpSendChannel(channelId)) {
    skipCdp(opts, `chat=${channelId || "?"} 不在 channel_profiles.json send 白名单`);
    return false;
  }

  const symbol = String(card?.symbol ?? "").trim();
  if (!symbol || symbol === "待补充") {
    skipCdp(opts, `symbol 无效 (${symbol || "空"})`);
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
    skipCdp(opts, `卡片 #${card?.id ?? "?"} 缺少 direction`);
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
    skipCdp(opts, "合并更新默认不重复 CDP（TRADE_SIGNAL_AI_PUBLISH_ON_UPDATE=1 可开）");
    return false;
  }
  const dedupKey = buildDedupKey(card, event, opts.ingestSourceRef);
  if (!bypass && wasRecentlyPublished(dedupKey)) {
    skipCdp(opts, `同一条 TG 消息已 CDP ref=${resolveTelegramMessageRef(card, opts.ingestSourceRef) || dedupKey}`);
    return false;
  }

  const targets = Array.isArray(planned.takeProfitPrices)
    ? planned.takeProfitPrices.map((x) => String(x ?? "").trim()).filter(Boolean)
    : Array.isArray(planned.targets)
      ? planned.targets.map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];
  const entry = String(planned.entryPrice ?? planned.entry ?? "").trim();
  const stopLoss = String(planned.stopLossPrice ?? planned.stopLoss ?? "").trim();
  const narrativeOverride = String(opts.narrativeOverride ?? "").trim();
  const narrative =
    narrativeOverride ||
    String(card?.rawContent ?? "").trim() ||
    String(card?.note ?? "").trim();
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
  if (bypass) {
    log?.info?.("trade-signal CDP 测试 bypass：正文含 TELEGRAM_PUSH_BYPASS_MARKERS，跳过去重");
  }
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
          `trade-signal CDP 发布失败: HTTP ${r.status} ${j?.error || text.slice(0, 160)}`,
        );
        return;
      }
      log?.info?.(
        `trade-signal CDP 已排队: ${symbol} ${direction} event=${event} channel=${channelId} job=${j?.job_id || "?"}`,
      );
    })
    .catch((e) => {
      recentPublish.delete(dedupKey);
      log?.warn?.(`trade-signal CDP 发布异常: ${e?.message || e}`);
    });
  return true;
}
