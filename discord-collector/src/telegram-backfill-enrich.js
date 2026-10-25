/**
 * Telegram 回溯：对 cards 跑统一 batch_backtest 盈亏。
 */
import "./load-env.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { backtestBackfillGroupUnified } from "./backfill-batch-eval.js";
import { resetBinanceKlineBlockForBacktest } from "./card-price-fetch.js";
import { config } from "./config.js";
import { createLogger } from "./logger.js";

const log = createLogger("telegram-backfill-enrich");
const TELEGRAM_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../telegram");
const BACKTEST_CACHE_ROOT = path.join(TELEGRAM_DIR, ".backfill_cache", "backtest");

/**
 * @param {Record<string, unknown>} payload
 * @param {{
 *   maxBacktestsPerGroup?: number;
 *   skipBacktestCache?: boolean;
 *   onGroupDone?: (info: { groupIndex: number; groupTotal: number; groupName: string }) => void;
 *   flushPartial?: (merged: Record<string, unknown>) => void | Promise<void>;
 * }} [opts]
 */
function assertKlineProxyForBackfill() {
  if (config.binanceProxy) return;
  const err = new Error(
    "未配置 COMMON_PROXY / BINANCE_PROXY，国内无法拉交易所 K 线。请在 discord-collector/.env 设置 COMMON_PROXY=http://127.0.0.1:7890 后重启 collect:ui",
  );
  err.code = "BACKFILL_NO_PROXY";
  throw err;
}

/** @param {Record<string, unknown>} data @param {string} filePath */
async function writeBackfillCacheFile(filePath, data) {
  const fs = await import("node:fs/promises");
  const body = JSON.stringify(data);
  await fs.writeFile(filePath, body, "utf8");
}

export async function enrichTelegramBackfillPayload(payload, opts = {}) {
  if (!payload || typeof payload !== "object") return payload;
  assertKlineProxyForBackfill();
  const groups = Array.isArray(payload.groups) ? payload.groups : [];
  const maxPer = Math.max(0, Number(opts.maxBacktestsPerGroup) || 200);
  resetBinanceKlineBlockForBacktest();
  log.info(
    `Telegram batch 盈亏：K线顺序 ${config.telegramBackfillKlineSources.join(",")} · 代理 ${config.binanceProxy}`,
  );
  /** @type {Record<string, unknown>[]} */
  const enriched = [];
  const groupTotal = groups.length;
  for (let i = 0; i < groups.length; i += 1) {
    const g = groups[i];
    if (!g || typeof g !== "object") continue;
    enriched.push(
      await backtestBackfillGroupUnified(/** @type {Record<string, unknown>} */ (g), {
        maxBacktests: maxPer,
        sourceType: "telegram",
        backtestCacheRoot: BACKTEST_CACHE_ROOT,
        skipBacktestCache: Boolean(opts.skipBacktestCache),
      }),
    );
    const outGroups = groups.map((gg, idx) => (idx < enriched.length ? enriched[idx] : gg));
    const info = {
      groupIndex: i + 1,
      groupTotal,
      groupName: String(g.name ?? g.chatId ?? ""),
    };
    if (opts.flushPartial) {
      await opts.flushPartial({
        ...payload,
        groups: outGroups,
        backtestEnrichedAt: new Date().toISOString(),
        backtestPartial: i + 1 < groupTotal,
      });
    }
    opts.onGroupDone?.(info);
    await new Promise((r) => setImmediate(r));
  }
  const out = { ...payload, groups: enriched, backtestEnrichedAt: new Date().toISOString() };
  return out;
}

/**
 * @param {string} filePath
 * @param {{
 *   maxBacktestsPerGroup?: number;
 *   skipBacktestCache?: boolean;
 *   onGroupDone?: (info: { groupIndex: number; groupTotal: number; groupName: string }) => void;
 * }} [opts]
 */
export async function enrichTelegramBackfillFile(filePath, opts = {}) {
  const fs = await import("node:fs");
  if (!fs.existsSync(filePath)) return null;
  const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
  const out = await enrichTelegramBackfillPayload(raw, {
    ...opts,
    flushPartial: (merged) => writeBackfillCacheFile(filePath, merged),
  });
  const final = { ...out };
  delete final.backtestPartial;
  await writeBackfillCacheFile(filePath, final);
  log.info(`Telegram 回溯 batch 回测已写入 ${filePath}`);
  return final;
}
