/**
 * 当日 CDP 发布计数（TG send 群 + 巨鲸 operate），用于下午补量。
 */
import { config } from "./config.js";

/** @typedef {"telegram" | "kolvip"} CdpPublishSource */

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
 * @param {{ dayKey: string, tgOk: number, tgMorningOk: number, kolvipOk: number }} stats
 * @param {Date} [at]
 * @returns {boolean}
 */
export function shouldKolvipAfternoonCdpBackfill(stats, at = new Date()) {
  if (!isShanghaiAfternoon(at)) return false;
  const target = Math.max(1, Number(config.kolvipOperateCdpDailyTarget ?? 5) || 5);
  if (totalCdpPublishOk(stats) >= target) return false;
  const minMorning = Math.max(0, Number(config.kolvipOperateCdpMorningTgMin ?? 1) || 1);
  return (Number(stats.tgMorningOk) || 0) < minMorning;
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