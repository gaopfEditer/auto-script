/**
 * 胖猫社区卡片 → msg-relay-service 优先队列。
 * 未配置或对端不可达时只记日志，不抛错，不挡住出卡。
 */
import { config } from "./config.js";

let loggedUnconfigured = false;

/** 单测重置「未配置只打一次」 */
export function resetPriorityQueueLogForTests() {
  loggedUnconfigured = false;
}

/**
 * @param {{
 *   parser?: string;
 *   card?: unknown;
 *   skipped?: string;
 *   via?: string;
 *   yieldPct?: unknown;
 * }} input
 * @returns {{ source: "pangmao"; card: Record<string, unknown>; meta: { via: "ocr" | "text"; yield_pct: number | null } } | null}
 */
export function buildPangmaoPriorityEnqueueBody(input) {
  if (String(input?.parser ?? "") !== "pangmao") return null;
  if (String(input?.skipped ?? "") === "source_upgraded") return null;
  const card = input?.card;
  if (!card || typeof card !== "object" || Array.isArray(card)) return null;
  const via = input?.via === "ocr" ? "ocr" : "text";
  const raw = input?.yieldPct;
  const yieldPct =
    via === "ocr" && typeof raw === "number" && Number.isFinite(raw) ? raw : null;
  return {
    source: "pangmao",
    card: /** @type {Record<string, unknown>} */ (card),
    meta: { via, yield_pct: yieldPct },
  };
}

/**
 * @param {{ source: string; card: unknown; meta: { via: string; yield_pct: number | null } }} body
 * @param {{
 *   baseUrl?: string;
 *   secret?: string;
 *   timeoutMs?: number;
 *   fetchImpl?: typeof fetch;
 *   log?: { info?: Function; warn?: Function };
 * }} [opts]
 */
export async function enqueuePriorityCard(body, opts = {}) {
  const base = String(opts.baseUrl ?? config.priorityQueueBaseUrl ?? "")
    .trim()
    .replace(/\/$/, "");
  const secret = String(
    opts.secret !== undefined ? opts.secret : (config.priorityQueueSecret ?? ""),
  ).trim();
  const log = opts.log;
  if (!base || !secret) {
    if (!loggedUnconfigured) {
      loggedUnconfigured = true;
      log?.info?.(
        "PRIORITY_QUEUE_BASE_URL 或 PRIORITY_QUEUE_SECRET 未配置，跳过胖猫优先队列",
      );
    }
    return { ok: false, skipped: "unconfigured" };
  }

  const timeoutMs = Math.max(
    1_000,
    Number(opts.timeoutMs ?? config.priorityQueueTimeoutMs) || 8_000,
  );
  const fetchImpl = opts.fetchImpl ?? fetch;
  const url = `${base}/queue/priority`;
  try {
    const res = await fetchImpl(url, {
      method: "POST",
      headers: {
        Authorization: `Bearer ${secret}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!res.ok) {
      log?.warn?.(`胖猫优先队列入队失败 HTTP ${res.status}（出卡不受影响）`);
      return { ok: false, error: `HTTP ${res.status}` };
    }
    return { ok: true };
  } catch (e) {
    const msg = String(/** @type {Error} */ (e).message ?? e);
    log?.warn?.(`胖猫优先队列不可达，跳过入队（出卡不受影响）: ${msg}`);
    return { ok: false, error: msg };
  }
}
