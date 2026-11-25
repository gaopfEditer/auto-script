/**
 * kolvip Show 前 N 频道 · 按全局发单顺序筛选 → python-ai-operate CDP。
 * `KOLVIP_OPERATE_CDP_ORDER_SLOTS=999` 表示全部；`1,3,5,6` 表示仅第 1/3/5/6 单。
 * 交易日历日界：每天 08:00 Asia/Shanghai 重置序号。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { formatSendCdpLog } from "./signal-pipeline-log.js";
import { appendKolvipPipelineAudit, auditCardId } from "./kolvip-pipeline-audit-log.js";
import { buildKolvipOperateEntryNarrative } from "./kolvip-operate-entry.js";
import {
  ensureDailyCdpStatsDay,
  recordCdpPublishSuccess,
  shouldKolvipAfternoonCdpBackfill,
  totalCdpPublishOk,
} from "./kolvip-operate-cdp-daily.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const STATE_FILE = path.join(__dirname, "..", "data", "kolvip-operate-cdp-state.json");
const GLOBAL_KEY = "__global__";

/** @type {{ dayKey: string, count: number }} */
let globalDailyCount = { dayKey: "", count: 0 };

/** @type {{ dayKey: string, tgOk: number, tgMorningOk: number, kolvipOk: number }} */
let dailyCdpStats = { dayKey: "", tgOk: 0, tgMorningOk: 0, kolvipOk: 0 };

/**
 * @param {number[]} fromConfig
 * @returns {{ acceptAll: boolean, slots: Set<number> }}
 */
export function resolveKolvipOperateOrderSlots(fromConfig) {
  const nums = (fromConfig ?? [])
    .map((x) => Number(x))
    .filter((n) => Number.isFinite(n) && n > 0);
  if (!nums.length) {
    return { acceptAll: false, slots: new Set([1, 3, 5, 6]) };
  }
  if (nums.length === 1 && nums[0] === 999) {
    return { acceptAll: true, slots: new Set() };
  }
  return {
    acceptAll: false,
    slots: new Set(nums.filter((n) => n !== 999)),
  };
}

/** @returns {{ acceptAll: boolean, slots: Set<number> }} */
export function getKolvipOperateCdpOrderSlotPolicy() {
  return resolveKolvipOperateOrderSlots(config.kolvipOperateCdpOrderSlots);
}

/** Show 胜率榜前 N 频道（默认 5） */
export function getKolvipOperateCdpChannelIds() {
  const n = Math.max(1, Number(config.kolvipOperateCdpTopChannels ?? 5) || 5);
  const fromEnv = config.kolvipOperateCdpChannelIds;
  if (fromEnv?.length) return new Set(fromEnv.map(String));
  const fromShow = config.discordShowSidebar?.channelIds ?? [];
  return new Set(fromShow.slice(0, n).map(String));
}

/** @param {string} channelId */
export function isKolvipOperateCdpChannel(channelId) {
  const id = String(channelId ?? "").trim();
  if (!id) return false;
  return getKolvipOperateCdpChannelIds().has(id);
}

/**
 * 08:00 切日：00:00–07:59 仍算上一交易日。
 * @param {Date} [date]
 */
export function kolvipOperateSessionDayKey(date = new Date()) {
  const resetH = Math.max(0, Math.min(23, Number(config.kolvipOperateCdpResetHour ?? 8) || 8));
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(date);
  const hour = Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      hour12: false,
    }).format(date),
  );
  if (hour >= resetH) return ymd;
  const [y, m, d] = ymd.split("-").map(Number);
  const noon = new Date(`${y}-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T12:00:00+08:00`);
  const prev = new Date(noon.getTime() - 86_400_000);
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(prev);
}

function loadState() {
  try {
    if (!fs.existsSync(STATE_FILE)) return;
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const g = raw?.global;
    const daily = raw?.dailyCdp;
    if (daily && typeof daily === "object") {
      dailyCdpStats = {
        dayKey: String(daily.dayKey ?? ""),
        tgOk: Number(daily.tgOk) || 0,
        tgMorningOk: Number(daily.tgMorningOk) || 0,
        kolvipOk: Number(daily.kolvipOk) || 0,
      };
    }
    if (g && typeof g === "object") {
      globalDailyCount = {
        dayKey: String(g.dayKey ?? ""),
        count: Number(g.count) || 0,
      };
      return;
    }
    const rows = raw?.channels;
    if (rows && typeof rows === "object" && rows[GLOBAL_KEY]) {
      const v = rows[GLOBAL_KEY];
      globalDailyCount = {
        dayKey: String(v.dayKey ?? ""),
        count: Number(v.count) || 0,
      };
    }
  } catch {
    /* ignore */
  }
}

function saveState() {
  try {
    const dir = path.dirname(STATE_FILE);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      STATE_FILE,
      `${JSON.stringify(
        {
          updatedAt: new Date().toISOString(),
          global: globalDailyCount,
          dailyCdp: dailyCdpStats,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  } catch {
    /* ignore */
  }
}

loadState();

/**
 * @returns {{ dayKey: string, tgOk: number, tgMorningOk: number, kolvipOk: number, total: number }}
 */
export function getDailyCdpPublishStats() {
  const dayKey = kolvipOperateSessionDayKey();
  ensureDailyCdpStatsDay(dailyCdpStats, dayKey);
  return {
    ...dailyCdpStats,
    total: totalCdpPublishOk(dailyCdpStats),
  };
}

/** @param {Date} [at] */
export function recordTelegramCdpPublishSuccess(at = new Date()) {
  const dayKey = kolvipOperateSessionDayKey(at);
  ensureDailyCdpStatsDay(dailyCdpStats, dayKey);
  recordCdpPublishSuccess(dailyCdpStats, "telegram", at);
  saveState();
}

/** @param {Date} [at] */
export function recordKolvipCdpPublishSuccess(at = new Date()) {
  const dayKey = kolvipOperateSessionDayKey(at);
  ensureDailyCdpStatsDay(dailyCdpStats, dayKey);
  recordCdpPublishSuccess(dailyCdpStats, "kolvip", at);
  saveState();
}

/**
 * 递增当日全局发单序号；若不在允许槽位则返回 null（下午补量时可能放宽）。
 * @returns {{ slot: number, backfill: boolean } | null}
 */
export function claimKolvipOperateOrderSlot(at = new Date()) {
  const dayKey = kolvipOperateSessionDayKey(at);
  const { acceptAll, slots } = getKolvipOperateCdpOrderSlotPolicy();
  ensureDailyCdpStatsDay(dailyCdpStats, dayKey);
  if (!globalDailyCount.dayKey || globalDailyCount.dayKey !== dayKey) {
    globalDailyCount = { dayKey, count: 0 };
  }
  globalDailyCount.count += 1;
  saveState();
  const ordinal = globalDailyCount.count;
  if (acceptAll || slots.has(ordinal)) {
    return { slot: ordinal, backfill: false };
  }
  if (shouldKolvipAfternoonCdpBackfill(dailyCdpStats, at)) {
    return { slot: ordinal, backfill: true };
  }
  return null;
}

/** 测试 / 手动复位 */
export function resetKolvipOperateCdpStateForTest() {
  globalDailyCount = { dayKey: "", count: 0 };
  dailyCdpStats = { dayKey: "", tgOk: 0, tgMorningOk: 0, kolvipOk: 0 };
  try {
    if (fs.existsSync(STATE_FILE)) fs.unlinkSync(STATE_FILE);
  } catch {
    /* ignore */
  }
}

/** @returns {string} */
function orderSlotsLogLabel() {
  const { acceptAll, slots } = getKolvipOperateCdpOrderSlotPolicy();
  if (acceptAll) return "999(全部)";
  return [...slots].sort((a, b) => a - b).join(",");
}

/**
 * @param {Record<string, unknown>} card
 * @param {{ event?: string, log?: { info: Function, warn: Function }, bodyText?: string }} [opts]
 */
export function notifyKolvipOperateCdpPublish(card, opts = {}) {
  const auditBase = {
    channelId: String(card?.channelId ?? "").trim(),
    cardId: auditCardId(card?.id),
    symbol: String(card?.symbol ?? ""),
    target: "8787",
    event: String(opts.event || "entry").trim() || "entry",
  };
  if (!config.kolvipOperateCdpEnabled) {
    appendKolvipPipelineAudit("cdp_notify", { ...auditBase, result: "skip", reason: "kolvip_operate_cdp_disabled" });
    return false;
  }
  if (!config.tradeSignalAiPublishEnabled) {
    appendKolvipPipelineAudit("cdp_notify", { ...auditBase, result: "skip", reason: "trade_signal_ai_publish_disabled" });
    return false;
  }

  const event = String(opts.event || "entry").trim() || "entry";
  if (event !== "entry") {
    appendKolvipPipelineAudit("cdp_notify", { ...auditBase, result: "skip", reason: `event_not_entry:${event}` });
    return false;
  }

  const channelId = String(card?.channelId ?? "").trim();
  if (!isKolvipOperateCdpChannel(channelId)) {
    appendKolvipPipelineAudit("cdp_notify", {
      ...auditBase,
      channelId,
      result: "skip",
      reason: "not_operate_cdp_channel",
    });
    return false;
  }

  const claimed = claimKolvipOperateOrderSlot();
  if (!claimed) {
    const stats = getDailyCdpPublishStats();
    const reason = `kolvip-operate 发单序号未命中（允许 ${orderSlotsLogLabel()}；日 CDP ${stats.total}/${config.kolvipOperateCdpDailyTarget}，上午 TG ${stats.tgMorningOk}）`;
    opts.log?.info?.(
      formatSendCdpLog("cdp_skip", {
        cardId: card?.id ?? "?",
        channelId,
        symbol: String(card?.symbol ?? ""),
        event,
        reason,
      }),
    );
    appendKolvipPipelineAudit("cdp_notify", { ...auditBase, channelId, result: "skip", reason });
    return false;
  }
  const slot = claimed.slot;
  const backfill = claimed.backfill;

  const ex =
    card?.execution && typeof card.execution === "object"
      ? /** @type {Record<string, unknown>} */ (card.execution)
      : {};
  const planned =
    ex.planned && typeof ex.planned === "object"
      ? /** @type {Record<string, unknown>} */ (ex.planned)
      : {};
  const symbol = String(card?.symbol ?? "").trim();
  const direction = String(ex.direction ?? card?.direction ?? "").trim();
  const entryRaw = String(planned.entryPrice ?? planned.entry ?? "").trim();
  const leverage = String(planned.leverage ?? ex.leverage ?? card?.leverage ?? "").trim();
  const bodyText =
    String(opts.bodyText ?? "").trim() ||
    String(card?.rawContent ?? card?.note ?? "").trim();

  const narrative = buildKolvipOperateEntryNarrative({
    symbol,
    direction,
    leverage,
    entryRaw,
    bodyText,
  });
  if (!narrative || !/入场\s*[:：]/.test(narrative)) {
    opts.log?.warn?.(
      formatSendCdpLog("cdp_skip", {
        cardId: card?.id ?? "?",
        channelId,
        symbol,
        event,
        reason: "kolvip-operate 无法生成入场四行正文",
      }),
    );
    appendKolvipPipelineAudit("cdp_notify", {
      ...auditBase,
      channelId,
      symbol,
      direction,
      result: "skip",
      reason: "kolvip-operate 无法生成入场四行正文",
    });
    return false;
  }

  const base = String(config.tradeSignalAiPublishUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
  const url = `${base}/api/v1/trade-signal/publish`;
  /** @type {Record<string, unknown>} */
  const body = {
    symbol,
    direction,
    event,
    entry: narrative.match(/入场\s*[:：]\s*(.+)/)?.[1]?.trim() ?? "",
    targets: [],
    stopLoss: "",
    narrative,
    body: narrative,
    note: backfill
      ? `kolvip-operate 下午补量 发单序=${slot} 日计=${getDailyCdpPublishStats().total}/${config.kolvipOperateCdpDailyTarget}`
      : `kolvip-operate 发单序=${slot}`,
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

  opts.log?.info?.(
    formatSendCdpLog("cdp_post", {
      cardId: card?.id ?? "?",
      channelId,
      symbol,
      direction,
      event,
      detail: backfill
        ? `kolvip-operate 下午补量 发单序=${slot} ${url}`
        : `kolvip-operate 发单序=${slot} ${url}`,
    }),
  );
  appendKolvipPipelineAudit("cdp_notify", {
    ...auditBase,
    channelId,
    symbol,
    direction,
    result: "post",
    reason: backfill ? `afternoon_backfill slot=${slot}` : `slot=${slot}`,
    detail: url,
  });

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
        const reason = `kolvip-operate HTTP ${r.status} ${j?.error || text.slice(0, 160)}`;
        opts.log?.warn?.(
          formatSendCdpLog("cdp_fail", {
            cardId: card?.id ?? "?",
            channelId,
            symbol,
            direction,
            event,
            reason,
          }),
        );
        appendKolvipPipelineAudit("cdp_notify", {
          channelId,
          cardId: auditCardId(card?.id),
          symbol,
          direction,
          target: "8787",
          result: "fail",
          reason,
        });
        return;
      }
      recordKolvipCdpPublishSuccess();
      opts.log?.info?.(
        formatSendCdpLog("cdp_ok", {
          cardId: card?.id ?? "?",
          channelId,
          symbol,
          direction,
          event,
          jobId: j?.job_id || "?",
          detail: backfill ? `下午补量 发单序=${slot}` : `发单序=${slot}`,
        }),
      );
      appendKolvipPipelineAudit("cdp_notify", {
        channelId,
        cardId: auditCardId(card?.id),
        symbol,
        direction,
        target: "8787",
        result: "ok",
        reason: backfill ? `afternoon_backfill slot=${slot}` : `slot=${slot}`,
        detail: String(j?.job_id || ""),
      });
    })
    .catch((e) => {
      const reason = `kolvip-operate ${String(e?.message || e)}`;
      opts.log?.warn?.(
        formatSendCdpLog("cdp_fail", {
          cardId: card?.id ?? "?",
          channelId,
          symbol,
          direction,
          event,
          reason,
        }),
      );
      appendKolvipPipelineAudit("cdp_notify", {
        channelId,
        cardId: auditCardId(card?.id),
        symbol,
        direction,
        target: "8787",
        result: "fail",
        reason,
      });
    });
  return true;
}