/**
 * Telegram 交易信号 → python-ai-operate：AI 短评 + OI 截图 + CDP 发布。
 * POST http://127.0.0.1:8787/api/v1/trade-signal/publish
 */
import { config } from "./config.js";

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

/**
 * @param {Record<string, unknown>} card
 * @param {{ event?: string, log?: { info: Function, warn: Function } }} [opts]
 */
export function notifyTradeSignalAiPublish(card, opts = {}) {
  if (!config.tradeSignalAiPublishEnabled) return;
  if (!isTelegramSource(card?.sourceType ?? card?.source_type ?? "")) return;

  const symbol = String(card?.symbol ?? "").trim();
  if (!symbol || symbol === "待补充") return;

  const ex =
    card?.execution && typeof card.execution === "object"
      ? /** @type {Record<string, unknown>} */ (card.execution)
      : {};
  const planned =
    ex.planned && typeof ex.planned === "object"
      ? /** @type {Record<string, unknown>} */ (ex.planned)
      : {};
  const direction = String(ex.direction ?? card?.direction ?? "").trim();
  if (!direction) return;

  const targets = Array.isArray(planned.takeProfitPrices)
    ? planned.takeProfitPrices.map((x) => String(x ?? "").trim()).filter(Boolean)
    : Array.isArray(planned.targets)
      ? planned.targets.map((x) => String(x ?? "").trim()).filter(Boolean)
      : [];
  const entry = String(planned.entryPrice ?? planned.entry ?? "").trim();
  const stopLoss = String(planned.stopLossPrice ?? planned.stopLoss ?? "").trim();
  const narrative = String(card?.rawContent ?? "").trim();
  const note = String(card?.note ?? "").trim();
  const event = String(opts.event || "entry").trim() || "entry";

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
    note,
    cardId: card?.id ?? null,
    async: true,
  };
  if (Array.isArray(config.tradeSignalAiPublishPlatforms) && config.tradeSignalAiPublishPlatforms.length) {
    body.platforms = config.tradeSignalAiPublishPlatforms;
  }
  if (config.tradeSignalAiPublishToken) {
    body.token = config.tradeSignalAiPublishToken;
  }

  const log = opts.log;
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
        log?.warn?.(
          `trade-signal AI 发布失败: HTTP ${r.status} ${j?.error || text.slice(0, 160)}`
        );
        return;
      }
      log?.info?.(
        `trade-signal AI 发布已排队: ${symbol} ${direction} event=${event} job=${j?.job_id || "?"}`
      );
    })
    .catch((e) => {
      log?.warn?.(`trade-signal AI 发布异常: ${e?.message || e}`);
    });
}
