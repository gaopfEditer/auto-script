/**
 * 持仓浮盈达阶梯（默认 5/10/15/20%）→ 提醒上移止损。
 * 仅对已确认入场的持仓生效（未触达入场区不算浮盈）。
 * 每次轮询每卡最多 1 条提醒（最高新触达阶梯），低档位合并标记已提醒。
 */
import { config } from "./config.js";
import { calcLeveragePnl, parseEntryPrice } from "./card-price-fetch.js";
import { isShortDirection } from "./card-direction.js";
import { isCardEnteredForEval } from "./card-eval-outcome.js";
import { normalizeExecution } from "./discord-signal-execution.js";
import {
  isProgressTerminal,
  parseProgressJson,
  resolveProgressLeverage,
} from "./card-level-progress.js";

/** @returns {number[]} */
export function getProfitTrailLevels() {
  const raw = String(config.cardProfitTrailLevels ?? "5,10,15,20").trim();
  const levels = raw
    .split(/[,，\s]+/)
    .map((s) => Number(s.trim()))
    .filter((n) => Number.isFinite(n) && n > 0);
  return [...new Set(levels)].sort((a, b) => a - b);
}

/**
 * @param {Record<string, unknown>} card
 */
export function isCardEligibleForProfitTrail(card) {
  if (String(card.assetClass ?? "crypto").toLowerCase() === "stock") return false;
  if (!isCardEnteredForEval(card)) return false;
  if (isProgressTerminal(card.progress)) return false;
  const p = parseProgressJson(card.progress);
  if (p && String(p.status ?? "") === "expired") return false;
  const ex = normalizeExecution(card.execution);
  if (ex.outcome === "take_profit" || ex.outcome === "stop_loss") return false;
  const entry = resolveTrailEntry(card);
  return entry != null && entry > 0;
}

/**
 * 已入场后的成交价；未入场返回 null（禁止用计划入场价冒充持仓）。
 * @param {Record<string, unknown>} card
 */
export function resolveTrailEntry(card) {
  if (!isCardEnteredForEval(card)) return null;

  const p = parseProgressJson(card.progress);
  const fromProgress = p?.entryPriceUsed != null ? Number(p.entryPriceUsed) : NaN;
  if (Number.isFinite(fromProgress) && fromProgress > 0) return fromProgress;

  const ex = normalizeExecution(card.execution);
  const actual = parseEntryPrice(ex.actual?.buyPrice ?? ex.actual?.sellPrice);
  if (actual != null && actual > 0) return actual;

  return parseEntryPrice(ex.planned?.entryPrice);
}

/**
 * @param {Record<string, unknown>} card
 * @param {number} price
 */
export function resolveUnrealizedPnl(card, price) {
  const entry = resolveTrailEntry(card);
  if (entry == null || !Number.isFinite(price) || price <= 0) return null;
  const ex = normalizeExecution(card.execution);
  const isShort = isShortDirection(ex.direction);
  const leverage = resolveProgressLeverage(card);
  const pnl = calcLeveragePnl(entry, price, isShort, leverage);
  if (!pnl) return null;
  return {
    ...pnl,
    isShort,
    entry,
    price,
    leverage,
    directionLabel: isShort ? "做空" : "做多",
  };
}

/**
 * @param {number} level
 */
export function trailSlSuggestion(level) {
  if (level >= 20) return "可将止损大幅上移，锁定阶梯利润，防深度回吐";
  if (level >= 15) return "建议阶梯上移止损，锁定部分浮盈";
  if (level >= 10) return "建议止损上移至保本或小幅锁利";
  return "建议将止损上移至开仓价附近（保本）";
}

/**
 * @param {Record<string, unknown>} proximity
 */
function readProfitTrailState(proximity) {
  const raw = proximity?.profitTrail ?? proximity?.profit_trail;
  if (!raw || typeof raw !== "object") return {};
  return /** @type {Record<string, { alertedAt?: string }>} */ ({ ...raw });
}

/**
 * @param {Record<string, unknown>} proximity
 * @param {number} nowMs
 */
function isProfitTrailCooldownActive(proximity, nowMs) {
  const meta = proximity?._meta;
  if (!meta || typeof meta !== "object") return false;
  const last = meta.lastProfitTrailAt ?? meta.last_profit_trail_at;
  if (!last) return false;
  const lastMs = new Date(String(last)).getTime();
  if (!Number.isFinite(lastMs)) return false;
  const cd = Number(config.cardProfitTrailCooldownMs) || 0;
  return cd > 0 && nowMs - lastMs < cd;
}

/**
 * @param {Record<string, unknown>} card
 * @param {number} price
 * @param {Record<string, unknown>} proximity
 * @param {number} nowMs
 */
export function collectProfitTrailAlerts(card, price, proximity, nowMs) {
  const levels = getProfitTrailLevels();
  const snap = resolveUnrealizedPnl(card, price);
  if (!snap || snap.pnlPctOnMargin <= 0) {
    return { alerts: [], proximity };
  }

  if (isProfitTrailCooldownActive(proximity, nowMs)) {
    return { alerts: [], proximity };
  }

  const trail = readProfitTrailState(proximity);

  /** 只取「当前浮盈已越过、且尚未提醒」的最高阶梯 */
  let targetLevel = null;
  for (let i = levels.length - 1; i >= 0; i--) {
    const level = levels[i];
    if (snap.pnlPctOnMargin < level) continue;
    if (trail[String(level)]?.alertedAt) continue;
    targetLevel = level;
    break;
  }

  if (targetLevel == null) {
    return { alerts: [], proximity };
  }

  const alertedAt = new Date(nowMs).toISOString();
  for (const level of levels) {
    if (level <= targetLevel) {
      trail[String(level)] = {
        alertedAt,
        price: snap.price,
        pnlPct: snap.pnlPctOnMargin,
      };
    }
  }

  const prevMeta =
    proximity._meta && typeof proximity._meta === "object"
      ? /** @type {Record<string, unknown>} */ ({ ...proximity._meta })
      : {};

  const alert = {
    level: targetLevel,
    pnlPct: snap.pnlPctOnMargin,
    pnlLabel: snap.pnlLabel,
    price: snap.price,
    entry: snap.entry,
    leverage: snap.leverage,
    directionLabel: snap.directionLabel,
    isShort: snap.isShort,
    suggestion: trailSlSuggestion(targetLevel),
  };

  return {
    alerts: [alert],
    proximity: {
      ...proximity,
      profitTrail: trail,
      _meta: { ...prevMeta, lastProfitTrailAt: alertedAt },
    },
  };
}

/**
 * @param {Record<string, unknown>} card
 * @param {string} sym
 * @param {Record<string, unknown>} alert
 */
export function formatProfitTrailTelegram(card, sym, alert) {
  const title = card.cardFields?.title
    ? String(card.cardFields.title)
    : card.parsedJson?.title
      ? String(card.parsedJson.title)
      : "";
  const lines = [
    `📈 盈利提醒 · 上移止损`,
    "",
    `卡片 #${card.id} · ${sym} ${alert.directionLabel ?? ""}`.trim(),
    `浮盈已达 ${alert.level}% 阶梯（当前 ${alert.pnlLabel ?? `+${Number(alert.pnlPct).toFixed(2)}%`}）`,
    `入场 ${alert.entry} · 现价 ${alert.price}（${alert.leverage}x）`,
    "",
    `👉 ${alert.suggestion}`,
  ];
  if (title) lines.push(`标题: ${title}`);
  lines.push(`来源: ${card.sourceType ?? "—"}`);
  return lines.filter(Boolean).join("\n");
}
