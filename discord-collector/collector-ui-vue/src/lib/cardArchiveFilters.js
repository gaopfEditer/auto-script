/** 与卡片归档页 /cards 一致的筛选项 */

/** 卡片归档 grid 默认必含 Discord；可额外勾选其它来源 */
export const DEFAULT_ARCHIVE_SOURCE = "discord";
export const BASE_ARCHIVE_SOURCE = DEFAULT_ARCHIVE_SOURCE;

/** 评估页等单选下拉（含「全部」） */
export const SOURCE_OPTIONS = [
  { value: "", label: "全部来源" },
  { value: "discord", label: "Discord" },
  { value: "youtube", label: "YouTube" },
  { value: "telegram", label: "Telegram" },
  { value: "x", label: "X / Twitter" },
  { value: "api", label: "外部 API" },
  { value: "manual", label: "手动" },
];

/** 归档页除 Discord 外可勾选的平台（Discord 固定选中不可取消） */
export const EXTRA_SOURCE_OPTIONS = SOURCE_OPTIONS.filter(
  (o) => o.value && o.value !== BASE_ARCHIVE_SOURCE
);

export const PERIOD_OPTIONS = [
  { value: "today", label: "今天" },
  { value: 2, label: "近 2 天" },
  { value: 7, label: "近一周" },
  { value: 30, label: "近 30 天" },
  { value: 90, label: "近 90 天" },
  { value: 0, label: "全部" },
];

/** @param {string | number} period */
export function buildArchivePeriodQuery(period) {
  if (period === "today") {
    const start = new Date();
    start.setHours(0, 0, 0, 0);
    return { from: start.toISOString() };
  }
  const d = Number(period);
  if (Number.isFinite(d) && d > 0) return { days: d };
  return { days: 3650 };
}

/** 时间筛选跨度大于 7 天时才展示周分割线 */
export function archivePeriodShowsWeekDividers(period) {
  if (period === "today") return false;
  if (period === 0) return true;
  const d = Number(period);
  return Number.isFinite(d) && d > 7;
}

/**
 * @param {string | string[]} [extra]
 * @returns {string[]}
 */
export function normalizeArchiveSourceList(extra) {
  const set = new Set([BASE_ARCHIVE_SOURCE]);
  const list = Array.isArray(extra) ? extra : extra ? [extra] : [];
  for (const raw of list) {
    const v = String(raw ?? "").trim().toLowerCase();
    if (v && v !== BASE_ARCHIVE_SOURCE) set.add(v);
  }
  return [...set];
}

/**
 * @param {unknown} cardSourceType
 * @param {string[]} sources
 */
export function cardMatchesArchiveSources(cardSourceType, sources) {
  if (!sources?.length) return true;
  const st = String(cardSourceType ?? "").trim().toLowerCase();
  const platform = st.includes(":") ? st.split(":").pop() : st;
  return sources.some((s) => {
    const want = String(s).trim().toLowerCase();
    return want && (st === want || platform === want);
  });
}

/**
 * @param {string[]} sources
 */
export function archiveSourcesCacheKey(sources) {
  return normalizeArchiveSourceList(sources).sort().join(",");
}

/**
 * 归档 / 评估列表共用的查询参数。
 * @param {{
 *   source?: string,
 *   sources?: string[],
 *   channelId?: string,
 *   symbol?: string,
 *   period?: string | number,
 * }} filters
 */
export function buildArchiveListQuery(filters = {}) {
  const q = { ...buildArchivePeriodQuery(filters.period ?? "today") };
  const channelId = String(filters.channelId ?? "").trim();
  const symbol = String(filters.symbol ?? "").trim();
  if (filters.sources?.length) {
    q.sources = normalizeArchiveSourceList(filters.sources);
  } else {
    const source = String(filters.source ?? "").trim();
    if (source) q.source = source;
  }
  if (channelId) q.channelId = channelId;
  if (symbol) q.symbol = symbol;
  return q;
}
