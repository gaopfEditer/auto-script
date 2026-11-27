/**
 * 今日盈亏勾选表 → python-ai-operate CDP 纯文发布（POST /api/v1/publish）。
 */
import { config } from "./config.js";

/**
 * @param {unknown} v
 */
function fmtPnlLine(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)} U`;
}

/**
 * @param {unknown} v
 */
function fmtPctLine(v) {
  if (v == null || !Number.isFinite(Number(v))) return "—";
  const n = Number(v);
  const sign = n >= 0 ? "+" : "";
  return `${sign}${n.toFixed(2)}%`;
}

/**
 * @param {unknown} iso
 * @returns {string} Asia/Shanghai HH:mm
 */
function fmtSignalTimeShanghai(iso) {
  const s = String(iso ?? "").trim();
  if (!s) return "";
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    timeZone: "Asia/Shanghai",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(d);
}

/** @param {Record<string, unknown>} row */
function fmtRowLeverage(row) {
  const raw = row.leverage ?? row.leverageX ?? row.leverageLabel;
  if (raw == null || raw === "") return "";
  const n = Number(raw);
  if (Number.isFinite(n) && n > 0) return `${n}倍`;
  const s = String(raw).trim();
  if (!s) return "";
  if (/倍|x/i.test(s)) return s;
  return `${s}倍`;
}

/** 内部发车尾注：固定池 + 种子，避免天天同一句。 */
const PLAZA_INTERNAL_QUIPS = [
  "仓位不大，图个参与感。",
  "懒得死磕，错了就认。",
  "顺势试一把，别上头。",
  "挂单睡觉，醒来看戏。",
  "赚丑钱不丢人，亏认栽也算数。",
  "深夜别梭，留点子弹。",
  "小利叠加，比赌一把稳。",
  "盘面抽动快，止损别装死。",
  "不熟的不碰，熟人单也看价。",
  "今日份发车，明日再说。",
];

/**
 * @param {string} [seed]
 * @param {string} [override]
 */
export function pickPlazaInternalQuip(seed, override) {
  const custom = String(override ?? "").trim();
  if (custom) return custom;
  const s = String(seed ?? Date.now());
  let h = 0;
  for (let i = 0; i < s.length; i += 1) h = (Math.imul(31, h) + s.charCodeAt(i)) | 0;
  return PLAZA_INTERNAL_QUIPS[Math.abs(h) % PLAZA_INTERNAL_QUIPS.length];
}

/**
 * 晚间晒单：优先展示盈利较好的单子（默认 ≥8%，最多 4 笔，按收益率降序）。
 *
 * @param {Array<Record<string, unknown>>} rows
 * @param {{ maxRows?: number, minPnlPct?: number }} [opts]
 */
export function pickPlazaEveningHighlightRows(rows, opts = {}) {
  const maxRows = Math.max(1, Number(opts.maxRows ?? 4));
  const minPnlPct = Number(opts.minPnlPct ?? 8);
  const profitable = rows.filter((r) => Number(r.pnlPct) > 0);
  profitable.sort((a, b) => Number(b.pnlPct) - Number(a.pnlPct));
  const strong = profitable.filter((r) => Number(r.pnlPct) >= minPnlPct);
  const picked = (strong.length ? strong : profitable).slice(0, maxRows);
  return picked;
}

/**
 * 内部发车：挑一笔盈利大的单子，行文与「今日发车」各行一致（不是四行开仓）。
 * 默认取收益率第 2 名（与头条错开仍是大赚单）；仅 1 笔盈利则用第 1 名。
 *
 * @param {Array<Record<string, unknown>>} allRows
 * @param {Array<Record<string, unknown>>} [_mainRows]
 */
export function pickPlazaInternalHighlightRow(allRows, _mainRows = []) {
  const profitable = allRows.filter((r) => Number(r.pnlPct) > 0);
  profitable.sort((a, b) => Number(b.pnlPct) - Number(a.pnlPct));
  if (!profitable.length) return null;
  return profitable.length >= 2 ? profitable[1] : profitable[0];
}

/** @param {Record<string, unknown>} r */
function formatPlazaProfitLine(r) {
  const sym = String(r.symbol ?? "")
    .trim()
    .replace(/USDT$/i, "");
  const coin = sym.startsWith("#") ? sym : sym ? `#${sym}` : "#—";
  const dir = String(r.direction ?? "").trim() || "—";
  const lev = fmtRowLeverage(r);
  const levPart = lev ? ` ${lev}` : "";
  const pct = fmtPctLine(r.pnlPct);
  const t = fmtSignalTimeShanghai(r.signalAt ?? r.orderAt);
  const timePart = t ? ` · 发单 ${t}` : "";
  return `${coin} ${dir}${levPart} ${pct}${timePart}`;
}

/**
 * @param {Record<string, unknown>} order
 * @param {Record<string, unknown> | null} autoRow
 */
function formatPlazaInternalDepartBlock(order, autoRow) {
  const preset = String(order?.text ?? "").trim();
  if (preset) return preset;
  const hasManual =
    order &&
    typeof order === "object" &&
    (order.symbol != null || order.pnlPct != null) &&
  Number(order.pnlPct) > 0;
  const row = hasManual ? order : autoRow;
  if (!row || Number(row.pnlPct) <= 0) return "";
  /** @type {string[]} */
  const lines = ["内部发车", formatPlazaProfitLine(row)];
  const customComments = Array.isArray(order?.comments)
    ? order.comments.map((x) => String(x ?? "").trim()).filter(Boolean)
    : [];
  const oneComment = String(order?.comment ?? "").trim();
  const quip =
    customComments.length > 0
      ? customComments.join("\n")
      : pickPlazaInternalQuip(
          String(order?.commentSeed ?? row.symbol ?? ""),
          oneComment || undefined,
        );
  if (quip) {
    lines.push("", quip);
  }
  return lines.join("\n");
}

/**
 * 广场晚间晒单：不带来源；只列当日盈利（默认 ≥8% 取前若干笔）。
 *
 * @param {{
 *   rows?: Array<Record<string, unknown>>,
 *   moodLine?: string,
 *   highlight?: boolean,
 *   maxRows?: number,
 *   minPnlPct?: number,
 *   internalOrder?: Record<string, unknown>,
 * }} input
 */
export function formatPlazaEveningPnlText(input) {
  const allRows = Array.isArray(input?.rows) ? input.rows : [];
  const highlight = input?.highlight !== false;
  const rows = highlight
    ? pickPlazaEveningHighlightRows(allRows, {
        maxRows: input?.maxRows,
        minPnlPct: input?.minPnlPct,
      })
    : allRows;
  const head =
    rows.length > 1 ? `今日盈利 ${rows.length} 笔` : rows.length === 1 ? "今日盈利 1 笔" : "今日盈利";
  const lines = [head];
  for (const r of rows) {
    lines.push(formatPlazaProfitLine(r));
  }
  const mood = String(input?.moodLine ?? "").trim();
  if (mood) {
    lines.push("", mood);
  }
  return lines.join("\n").trim();
}

/**
 * @param {{
 *   dayLabel?: string,
 *   sumPnlUsdt?: number,
 *   tradeCount?: number,
 *   rows?: Array<Record<string, unknown>>,
 * }} input
 */
export function formatTodayPnlPublishText(input) {
  const day = String(input?.dayLabel ?? "今日").trim() || "今日";
  const sum = fmtPnlLine(input?.sumPnlUsdt);
  const n = Number(input?.tradeCount) || (Array.isArray(input?.rows) ? input.rows.length : 0);
  /** @type {string[]} */
  const lines = [
    "今日跟单结算（路径口径）",
    day,
    `合计 ${sum} · ${n} 笔`,
    "",
  ];
  const rows = Array.isArray(input?.rows) ? input.rows : [];
  let i = 0;
  for (const r of rows) {
    i += 1;
    const src = String(r.sourceLabel ?? r.sourceType ?? "—").trim();
    const ch = String(r.channelName ?? r.channelId ?? "—").trim();
    const sym = String(r.symbol ?? "—").trim();
    const margin = r.marginUsdt ?? r.effectiveMarginUsdt;
    const marginStr =
      margin != null && Number.isFinite(Number(margin)) ? `${Number(margin)}U` : "—";
    const status = String(r.statusLabel ?? r.status ?? "—").trim();
    lines.push(
      `${i}. ${src} · ${ch} · #${sym} · 保证金${marginStr} · ${fmtPctLine(r.pnlPct)} · ${fmtPnlLine(r.pnlUsdt ?? r.effectivePnlUsdt)} · ${status}`,
    );
  }
  lines.push("", "仅供参考，非交易所账单。");
  return lines.join("\n").trim();
}

/**
 * @param {{
 *   title?: string,
 *   text: string,
 *   platforms?: string[],
 * }} input
 */
export async function postTodayPnlToOperatePublish(input) {
  if (!config.tradeSignalAiPublishEnabled) {
    return {
      ok: false,
      error: "TRADE_SIGNAL_AI_PUBLISH=0，请在 .env 开启并重启 collect:ui",
    };
  }
  const text = String(input?.text ?? "").trim();
  if (!text) return { ok: false, error: "正文为空" };

  const base = String(config.tradeSignalAiPublishUrl || "http://127.0.0.1:8787").replace(/\/$/, "");
  const url = `${base}/api/v1/publish`;
  /** @type {Record<string, unknown>} */
  const body = {
    title: String(input?.title ?? "今日跟单结算").trim() || "今日跟单结算",
    content: text,
    text,
    async: true,
    submit: true,
  };
  const platforms =
    Array.isArray(input?.platforms) && input.platforms.length
      ? input.platforms
      : config.tradeSignalAiPublishPlatforms;
  if (Array.isArray(platforms) && platforms.length) {
    body.platforms = platforms;
  }

  /** @type {Record<string, string>} */
  const headers = { "Content-Type": "application/json" };
  if (config.tradeSignalAiPublishToken) {
    headers.Authorization = `Bearer ${config.tradeSignalAiPublishToken}`;
  }

  try {
    const r = await fetch(url, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(20_000),
    });
    const raw = await r.text();
    /** @type {Record<string, unknown> | null} */
    let j = null;
    try {
      j = raw ? JSON.parse(raw) : null;
    } catch {
      j = { raw: raw.slice(0, 300) };
    }
    if (!r.ok || j?.success === false) {
      return {
        ok: false,
        error: String(j?.error ?? j?.message ?? `HTTP ${r.status}`),
        detail: j,
      };
    }
    return {
      ok: true,
      jobId: j?.job_id ?? j?.jobId ?? null,
      poll: j?.poll ?? null,
      operateUrl: url,
    };
  } catch (e) {
    return { ok: false, error: String(/** @type {Error} */ (e).message ?? e) };
  }
}