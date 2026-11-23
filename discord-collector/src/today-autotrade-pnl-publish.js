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