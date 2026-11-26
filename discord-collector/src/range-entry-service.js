/**
 * 白名单区间入场协调：到达时分类，待触发落盘并轮询标记价，进入闭区间后再走原市价开仓。
 * 不扫描历史卡片；只处理本文件登记过的 waiting 任务。
 */
import { fetchBitgetPublicPrice, fetchWeexPublicPrice } from "./card-price-fetch.js";
import { normalizeSymbol } from "./card-fields.js";
import { isShortDirection } from "./card-direction.js";
import {
  classifyRangeEntry,
  rangeEntryKey,
  resolveEntryRaw,
} from "./range-entry-policy.js";
import { createRangeEntryPendingStore, defaultRangeEntryPendingPath } from "./range-entry-pending-store.js";

export { defaultRangeEntryPendingPath };

/**
 * @typedef {{
 *   fetchMark?: (symbol: string) => Promise<number | null>;
 *   hasExposure?: (symbol: string, direction: string) => Promise<boolean>;
 *   openPending?: (item: Record<string, unknown>) => Promise<unknown>;
 * }} RangeEntryExchangeHandlers
 */

/**
 * @param {{
 *   filePath?: string;
 *   intervalMs?: number;
 *   log?: { info?: Function, warn?: Function };
 *   fetchMarkByExchange?: Record<string, (symbol: string) => Promise<number | null>>;
 * }} [opts]
 */
export function createRangeEntryService(opts = {}) {
  const store = createRangeEntryPendingStore(opts.filePath || defaultRangeEntryPendingPath());
  const intervalMs = Math.max(1000, Number(opts.intervalMs ?? 3000) || 3000);
  const log = opts.log ?? {};
  /** @type {Record<string, RangeEntryExchangeHandlers>} */
  const handlers = {};
  /** @type {ReturnType<typeof setInterval> | null} */
  let timer = null;
  let ticking = false;

  /**
   * @param {string} exchange
   * @param {RangeEntryExchangeHandlers} h
   */
  function registerExchange(exchange, h) {
    handlers[String(exchange).toLowerCase()] = h;
  }

  /**
   * @param {string} exchange
   * @param {string} symbol
   */
  async function fetchMark(exchange, symbol) {
    const custom = handlers[exchange]?.fetchMark ?? opts.fetchMarkByExchange?.[exchange];
    if (custom) return custom(symbol);
    if (exchange === "bitget") {
      const hit = await fetchBitgetPublicPrice(symbol);
      return hit.price;
    }
    if (exchange === "weex") {
      const hit = await fetchWeexPublicPrice(symbol);
      return hit.price;
    }
    return null;
  }

  /**
   * @param {{
   *   exchange: string;
   *   cardId: number;
   *   channelId: string;
   *   channelName?: string;
   *   parsed: Record<string, unknown>;
   *   executionJson?: unknown;
   *   channelTrade?: Record<string, unknown>;
   *   dryRun?: boolean;
   * }} input
   */
  async function handleArrival(input) {
    const exchange = String(input.exchange || "").toLowerCase();
    const cardId = Number(input.cardId);
    const parsed = input.parsed ?? {};
    const entryRaw = resolveEntryRaw(parsed, input.executionJson);
    const direction = String(parsed.direction ?? "");
    const symbol = normalizeSymbol(parsed.symbol ?? parsed.asset ?? "");
    const first = classifyRangeEntry(entryRaw, direction, null);
    if (first.action === "pass") {
      return { action: "pass" };
    }
    if (first.action === "direction_unclear") {
      return { action: "skipped", reason: "direction_unclear", range: first.range };
    }

    const key = rangeEntryKey(exchange, cardId);
    const existing = store.get(key);
    if (existing) {
      const st = String(existing.status);
      if (st === "waiting") {
        return { action: "waiting", already: true, key, item: existing, reason: "already_pending" };
      }
      return {
        action: "skipped",
        reason: `already_${st}`,
        already: true,
        persist: false,
        key,
        item: existing,
      };
    }

    if (handlers[exchange]?.hasExposure && symbol) {
      try {
        const exposed = await handlers[exchange].hasExposure(symbol, direction);
        if (exposed) {
          return { action: "skipped", reason: "duplicate_position", range: first.range };
        }
      } catch {
        /* 查仓失败不阻塞登记/分类 */
      }
    }

    let mark = /** @type {number | null} */ (null);
    try {
      mark = symbol ? await fetchMark(exchange, symbol) : null;
    } catch {
      mark = null;
    }
    const decision = classifyRangeEntry(entryRaw, direction, mark);
    if (decision.action === "enter_now") {
      return { action: "enter_now", range: decision.range, mark: decision.mark, key };
    }
    if (decision.action === "skip_crossed") {
      return {
        action: "skipped",
        reason: decision.reason ?? "skip_crossed",
        range: decision.range,
        mark: decision.mark,
      };
    }

    const item = {
      key,
      cardId,
      exchange,
      channelId: String(input.channelId ?? ""),
      channelName: String(input.channelName ?? ""),
      symbol,
      direction,
      entryRaw,
      range: decision.range,
      lastMark: decision.mark,
      lastCheckedAt: new Date().toISOString(),
      parsed,
      executionJson: input.executionJson ?? null,
      channelTrade: input.channelTrade ?? null,
      dryRun: input.dryRun === true,
      holdSide: isShortDirection(direction) ? "short" : "long",
    };
    const already = store.addWaiting(item);
    if (already) {
      return { action: "waiting", already: true, key, item: already, reason: "already_pending" };
    }
    log.info?.(
      `区间入场等待 ${exchange} card=#${cardId} ${symbol} ${direction} ${decision.range?.low}-${decision.range?.high} mark=${decision.mark ?? "n/a"}`
    );
    return { action: "waiting", key, item, range: decision.range, mark: decision.mark, reason: "awaiting_range_entry" };
  }

  /** @param {Record<string, unknown>} item */
  async function tickItem(item) {
    const exchange = String(item.exchange ?? "");
    const symbol = String(item.symbol ?? "");
    const h = handlers[exchange];
    if (h?.hasExposure && symbol) {
      try {
        if (await h.hasExposure(symbol, String(item.direction ?? ""))) {
          store.complete(String(item.key), "skipped_duplicate", { reason: "duplicate_position" });
          return { action: "skipped", reason: "duplicate_position" };
        }
      } catch {
        /* continue */
      }
    }

    let mark = /** @type {number | null} */ (null);
    try {
      mark = await fetchMark(exchange, symbol);
    } catch (e) {
      store.update(String(item.key), {
        lastCheckedAt: new Date().toISOString(),
        lastError: String(/** @type {Error} */ (e).message ?? e),
      });
      return { action: "wait", reason: "mark_unavailable" };
    }

    const decision = classifyRangeEntry(item.entryRaw, item.direction, mark);
    store.update(String(item.key), {
      lastMark: mark,
      lastCheckedAt: new Date().toISOString(),
    });
    if (decision.action === "wait" || decision.action === "mark_unavailable") {
      return { action: "wait", mark };
    }
    if (decision.action === "skip_crossed" || decision.action === "direction_unclear") {
      store.complete(String(item.key), "skipped_crossed", {
        reason: decision.reason ?? decision.action,
        lastMark: mark,
      });
      return { action: "skipped", reason: decision.reason ?? decision.action, mark };
    }
    if (decision.action !== "enter_now") {
      return { action: "wait", mark };
    }

    if (typeof h?.openPending !== "function") {
      store.update(String(item.key), { lastError: "open_handler_missing" });
      return { action: "wait", reason: "open_handler_missing" };
    }

    let opened;
    try {
      opened = await h.openPending({ ...item, lastMark: mark, range: decision.range });
    } catch (e) {
      const why = String(/** @type {Error} */ (e).message ?? e);
      store.update(String(item.key), { lastError: why, lastMark: mark });
      log.warn?.(`区间入场市价失败 ${exchange} card=#${item.cardId}: ${why}`);
      return { action: "wait", reason: why, mark };
    }
    const failed =
      opened && typeof opened === "object" && (/** @type {Record<string, unknown>} */ (opened).failed === true ||
        /** @type {Record<string, unknown>} */ (opened).skipped);
    if (failed) {
      const why = String(
        /** @type {Record<string, unknown>} */ (opened).reason ??
          /** @type {Record<string, unknown>} */ (opened).skipped ??
          "open_failed"
      );
      if (why === "duplicate_position" || why === "major_symbol_excluded") {
        store.complete(String(item.key), "skipped_duplicate", { reason: why, lastMark: mark });
        return { action: "skipped", reason: why, mark };
      }
      store.update(String(item.key), { lastError: why, lastMark: mark });
      return { action: "wait", reason: why, mark };
    }
    store.complete(String(item.key), "triggered", { lastMark: mark, triggeredAt: new Date().toISOString() });
    log.info?.(
      `区间入场触发市价 ${exchange} card=#${item.cardId} ${symbol} mark=${mark} range=${decision.range?.low}-${decision.range?.high}`
    );
    return { action: "triggered", mark, opened };
  }

  async function tick() {
    if (ticking) return { skipped: "in_flight" };
    ticking = true;
    try {
      const waiting = store.listWaiting();
      /** @type {unknown[]} */
      const results = [];
      for (const item of waiting) {
        const ex = String(item.exchange ?? "");
        if (!handlers[ex]) continue;
        results.push(await tickItem(item));
      }
      return { ok: true, n: waiting.length, results };
    } finally {
      ticking = false;
    }
  }

  function start() {
    if (timer) return;
    timer = setInterval(() => {
      void tick().catch((e) => log.warn?.(`区间入场轮询失败: ${/** @type {Error} */ (e).message ?? e}`));
    }, intervalMs);
    void tick().catch((e) => log.warn?.(`区间入场恢复轮询失败: ${/** @type {Error} */ (e).message ?? e}`));
    const n = store.listWaiting().length;
    if (n) log.info?.(`区间入场待触发已恢复 ${n} 笔（${store.path}）`);
  }

  function stop() {
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  }

  return {
    store,
    registerExchange,
    handleArrival,
    tick,
    start,
    stop,
    listWaiting: () => store.listWaiting(),
  };
}

/**
 * 订单服务挂钩：pass/enter_now 继续原市价路径；waiting/skipped 写入卡片状态后返回。
 * @param {ReturnType<typeof createRangeEntryService> | null | undefined} rangeEntry
 * @param {Parameters<ReturnType<typeof createRangeEntryService>["handleArrival"]>[0]} input
 * @param {(record: Record<string, unknown>) => Promise<void> | void} [persist]
 */
export async function applyKolvipRangeEntryGate(rangeEntry, input, persist) {
  if (!rangeEntry || typeof rangeEntry.handleArrival !== "function") {
    return { action: "pass" };
  }
  const result = await rangeEntry.handleArrival(input);
  if (result.action === "pass" || result.action === "enter_now") return result;
  if (result.persist === false) return result;
  if (typeof persist === "function") {
    const status = result.action === "waiting" ? "range_waiting" : "skipped";
    const reason = result.reason ?? (result.action === "waiting" ? "awaiting_range_entry" : "skip_crossed");
    await persist({
      status,
      reason,
      range: result.range ?? (result.item ? /** @type {Record<string, unknown>} */ (result.item).range : null) ?? null,
      lastMark: result.mark ?? null,
      already: result.already === true,
      at: new Date().toISOString(),
    });
  }
  return result;
}
