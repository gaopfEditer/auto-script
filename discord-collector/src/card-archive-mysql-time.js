/** 卡片归档 / MySQL DATETIME(CST 墙钟) 与上海日历日对齐 */

export const CARD_ARCHIVE_TZ = "Asia/Shanghai";

/**
 * 毫秒时间戳 → MySQL DATETIME(3) 字符串（上海墙钟，用于与 sc.signal_at / sc.created_at 比较）。
 * @param {number} ms
 */
export function msToMysqlDatetimeShanghai(ms) {
  const n = Number(ms);
  if (!Number.isFinite(n)) return null;
  const parts = shanghaiTimeParts(n);
  const frac = String(Math.trunc(n) % 1000).padStart(3, "0");
  return `${parts.ymd} ${parts.hms}.${frac}`;
}

/**
 * @param {number} [nowMs]
 */
export function shanghaiCalendarDayStartMs(nowMs = Date.now()) {
  const ymd = new Intl.DateTimeFormat("en-CA", { timeZone: CARD_ARCHIVE_TZ }).format(new Date(nowMs));
  const start = Date.parse(`${ymd}T00:00:00+08:00`);
  return Number.isFinite(start) ? start : nowMs - 86400000;
}

/**
 * @param {number} [nowMs]
 */
export function shanghaiCalendarDayStartIso(nowMs = Date.now()) {
  return new Date(shanghaiCalendarDayStartMs(nowMs)).toISOString();
}

/**
 * MySQL 读出的 DATETIME（按 CST 墙钟存、无 TZ）→ ISO 字符串 +08:00，避免误加 Z 造成 UI 偏移。
 * @param {unknown} raw
 */
export function mysqlDatetimeToArchiveIso(raw) {
  if (raw == null || raw === "") return null;
  if (typeof raw === "string") return naiveMysqlDatetimeToShanghaiIso(raw);
  if (raw instanceof Date && !Number.isNaN(raw.getTime())) {
    const useUtcFields = new Date().getTimezoneOffset() === 0;
    const y = useUtcFields ? raw.getUTCFullYear() : raw.getFullYear();
    const mo = String((useUtcFields ? raw.getUTCMonth() : raw.getMonth()) + 1).padStart(2, "0");
    const d = String(useUtcFields ? raw.getUTCDate() : raw.getDate()).padStart(2, "0");
    const h = String(useUtcFields ? raw.getUTCHours() : raw.getHours()).padStart(2, "0");
    const mi = String(useUtcFields ? raw.getUTCMinutes() : raw.getMinutes()).padStart(2, "0");
    const se = String(useUtcFields ? raw.getUTCSeconds() : raw.getSeconds()).padStart(2, "0");
    const frac = String(useUtcFields ? raw.getUTCMilliseconds() : raw.getMilliseconds()).padStart(
      3,
      "0"
    );
    return `${y}-${mo}-${d}T${h}:${mi}:${se}.${frac}+08:00`;
  }
  const s = String(raw).trim();
  return naiveMysqlDatetimeToShanghaiIso(s) || s;
}

/**
 * 归档列表 SQL：signal_at 或 created_at 落在上海墙钟时间窗内即命中（无需 join discord_messages）。
 * @param {number} fromMs
 * @param {number} toMs
 * @returns {{ sql: string, params: unknown[] } | null}
 */
export function buildSignalCardArchiveRangeSql(fromMs, toMs) {
  const from = msToMysqlDatetimeShanghai(fromMs);
  const to = msToMysqlDatetimeShanghai(toMs);
  if (!from || !to) return null;
  return {
    sql: `(
      (sc.signal_at IS NOT NULL AND sc.signal_at >= ? AND sc.signal_at <= ?)
      OR (sc.created_at IS NOT NULL AND sc.created_at >= ? AND sc.created_at <= ?)
    )`,
    params: [from, to, from, to],
  };
}

/**
 * @param {number} ms
 */
function shanghaiTimeParts(ms) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: CARD_ARCHIVE_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hour12: false,
  });
  /** @type {Record<string, string>} */
  const parts = {};
  for (const p of f.formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = p.value;
  }
  return {
    ymd: `${parts.year}-${parts.month}-${parts.day}`,
    hms: `${parts.hour}:${parts.minute}:${parts.second}`,
  };
}

/**
 * @param {string} raw
 */
function naiveMysqlDatetimeToShanghaiIso(raw) {
  const s = String(raw).trim();
  const m = s.match(/^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d+))?/);
  if (!m) return null;
  const frac = String(m[7] ?? "0").padEnd(3, "0").slice(0, 3);
  return `${m[1]}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6]}.${frac}+08:00`;
}