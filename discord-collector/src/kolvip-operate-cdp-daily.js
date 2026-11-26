/**
 * 巨鲸 operate CDP 当日成功发布计数（Asia/Shanghai 自然日）。
 * 上限只约束 kolvip operate，与 channel_profiles.json `send` 的 TG CDP 路径互不占用。
 * 不把 kolvip 卡发进 send 源群。
 */
import { config } from "./config.js";

/** @typedef {"telegram" | "kolvip"} CdpPublishSource */

/**
 * @param {Date} [date]
 * @returns {string} YYYY-MM-DD in Asia/Shanghai
 */
export function kolvipOperateCalendarDayKey(date = new Date()) {
  return new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Shanghai" }).format(date);
}

/**
 * @param {Date} [date]
 * @returns {number} Asia/Shanghai 0–23
 */
export function shanghaiHour(date = new Date()) {
  return Number(
    new Intl.DateTimeFormat("en-GB", {
      timeZone: "Asia/Shanghai",
      hour: "2-digit",
      hour12: false,
    }).format(date),
  );
}

/**
 * @param {Date} [date]
 */
export function isShanghaiAfternoon(date = new Date()) {
  const h = Math.max(
    0,
    Math.min(23, Number(config.kolvipOperateCdpAfternoonHour ?? 12) || 12),
  );
  return shanghaiHour(date) >= h;
}

/**
 * 巨鲸 operate 当日成功发布上限（默认 4）。与 TG send 计数分开。
 */
export function kolvipOperateCdpDailyQuota() {
  return Math.max(1, Number(config.kolvipOperateCdpDailyTarget ?? 4) || 4);
}

/**
 * @param {{ dayKey: string, tgOk: number, tgMorningOk: number, kolvipOk: number }} stats
 * @param {string} dayKey
 */
export function ensureDailyCdpStatsDay(stats, dayKey) {
  if (!stats.dayKey || stats.dayKey !== dayKey) {
    stats.dayKey = dayKey;
    stats.tgOk = 0;
    stats.tgMorningOk = 0;
    stats.kolvipOk = 0;
  }
}

/**
 * @param {{ dayKey: string, tgOk: number, tgMorningOk: number, kolvipOk: number }} stats
 */
export function totalCdpPublishOk(stats) {
  return (Number(stats.tgOk) || 0) + (Number(stats.kolvipOk) || 0);
}

/**
 * 是否还可再发一条巨鲸 operate CDP。只看 kolvipOk 与日上限，
 * 不再用上午 TG 条数或「下午补量」门闩。
 * @param {{ dayKey: string, tgOk: number, tgMorningOk: number, kolvipOk: number }} stats
 */
export function shouldPublishKolvipOperateCdp(stats) {
  return (Number(stats.kolvipOk) || 0) < kolvipOperateCdpDailyQuota();
}

/**
 * @param {{ dayKey: string, tgOk: number, tgMorningOk: number, kolvipOk: number }} stats
 * @param {CdpPublishSource} source
 * @param {Date} [at]
 */
export function recordCdpPublishSuccess(stats, source, at = new Date()) {
  if (source === "telegram") {
    stats.tgOk = (Number(stats.tgOk) || 0) + 1;
    if (!isShanghaiAfternoon(at)) {
      stats.tgMorningOk = (Number(stats.tgMorningOk) || 0) + 1;
    }
  } else if (source === "kolvip") {
    stats.kolvipOk = (Number(stats.kolvipOk) || 0) + 1;
  }
}
