/**
 * Bitget 自动下单配置：环境变量（密钥）+ JSON（频道策略，不含密钥）。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import dotenv from "dotenv";

import { config } from "./config.js";

const _dir = path.dirname(fileURLToPath(import.meta.url));
const _envPath = path.join(_dir, "..", ".env");

/** 重新读取 .env（改 BITGET_DRY_RUN 后无需整进程重启） */
export function refreshBitgetEnvFromDotenv() {
  dotenv.config({ path: _envPath, override: true });
}

/** @returns {boolean} */
export function readBitgetDryRunFromEnv() {
  refreshBitgetEnvFromDotenv();
  return !["0", "false", "no", "off"].includes(String(process.env.BITGET_DRY_RUN ?? "1").toLowerCase());
}

/** @returns {boolean} */
function readBitgetEnabledFromEnv() {
  return !["0", "false", "no", "off"].includes(String(process.env.BITGET_ENABLED ?? "0").toLowerCase());
}

/**
 * @typedef {{
 *   marginMode?: "isolated" | "crossed";
 *   leverage?: number;
 *   orderSizeUsdt?: number;
 *   orderType?: "limit" | "market";
 *   productType?: string;
 *   stagedTrade?: boolean;
 *   initialSlPct?: number;
 *   tpPartialRatios?: number[];
 * }} BitgetTradeDefaults
 *
 * @typedef {BitgetTradeDefaults & {
 *   enabled?: boolean;
 *   name?: string;
 * }} BitgetChannelTradeConfig
 *
 * @typedef {{
 *   enabled: boolean;
 *   dryRun: boolean;
 *   default: Required<BitgetTradeDefaults>;
 *   channels: Record<string, BitgetChannelTradeConfig>;
 * }} BitgetTradeConfig
 */

/** @returns {string} */
export function defaultBitgetTradeConfigPath() {
  return path.join(_dir, "..", "config", "bitget-trade-channels.json");
}

/** @param {unknown} v @param {number} fallback */
function numOr(v, fallback) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/** @param {unknown} raw @returns {BitgetTradeConfig} */
function normalizeTradeConfig(raw) {
  const root = raw && typeof raw === "object" && !Array.isArray(raw) ? /** @type {Record<string, unknown>} */ (raw) : {};
  const defRaw =
    root.default && typeof root.default === "object" && !Array.isArray(root.default)
      ? /** @type {Record<string, unknown>} */ (root.default)
      : {};

  /** @type {Required<BitgetTradeDefaults>} */
  const defaults = {
    marginMode: defRaw.marginMode === "isolated" ? "isolated" : "crossed",
    leverage: numOr(defRaw.leverage, config.bitgetDefaultLeverage),
    orderSizeUsdt: numOr(defRaw.orderSizeUsdt, config.bitgetOrderSizeUsdt),
    orderType: defRaw.orderType === "market" ? "market" : "limit",
    productType: String(defRaw.productType ?? "USDT-FUTURES").trim() || "USDT-FUTURES",
    stagedTrade: defRaw.stagedTrade === true,
    initialSlPct: numOr(defRaw.initialSlPct, config.bitgetInitialSlPct),
    tpPartialRatios: Array.isArray(defRaw.tpPartialRatios)
      ? defRaw.tpPartialRatios.map(Number).filter((n) => Number.isFinite(n) && n > 0)
      : [0.3, 0.3, 1],
  };

  /** @type {Record<string, BitgetChannelTradeConfig>} */
  const channels = {};
  const chRoot = root.channels && typeof root.channels === "object" && !Array.isArray(root.channels)
    ? /** @type {Record<string, unknown>} */ (root.channels)
    : {};

  for (const [id, item] of Object.entries(chRoot)) {
    const cid = String(id ?? "").trim();
    if (!cid || !item || typeof item !== "object" || Array.isArray(item)) continue;
    const o = /** @type {Record<string, unknown>} */ (item);
    channels[cid] = {
      enabled: o.enabled !== false,
      name: o.name != null ? String(o.name) : undefined,
      marginMode: o.marginMode === "crossed" ? "crossed" : o.marginMode === "isolated" ? "isolated" : undefined,
      leverage: o.leverage != null ? numOr(o.leverage, defaults.leverage) : undefined,
      orderSizeUsdt: o.orderSizeUsdt != null ? numOr(o.orderSizeUsdt, defaults.orderSizeUsdt) : undefined,
      orderType: o.orderType === "market" ? "market" : o.orderType === "limit" ? "limit" : undefined,
      productType: o.productType != null ? String(o.productType).trim() || defaults.productType : undefined,
      stagedTrade: o.stagedTrade === true ? true : o.stagedTrade === false ? false : undefined,
      initialSlPct: o.initialSlPct != null ? numOr(o.initialSlPct, defaults.initialSlPct) : undefined,
      tpPartialRatios: Array.isArray(o.tpPartialRatios)
        ? o.tpPartialRatios.map(Number).filter((n) => Number.isFinite(n) && n > 0)
        : undefined,
    };
  }

  const envDryRun = readBitgetDryRunFromEnv();
  const fileDryRun = root.dryRun;
  const dryRun = fileDryRun === false ? false : fileDryRun === true ? true : envDryRun;

  return {
    enabled: root.enabled !== false && readBitgetEnabledFromEnv(),
    dryRun,
    default: defaults,
    channels,
  };
}

/**
 * @param {string} [filePath]
 * @returns {BitgetTradeConfig}
 */
export function loadBitgetTradeConfig(filePath = config.bitgetTradeConfigFile) {
  const p = path.resolve(String(filePath ?? "").trim() || defaultBitgetTradeConfigPath());
  if (!fs.existsSync(p)) {
    return normalizeTradeConfig({ enabled: readBitgetEnabledFromEnv(), dryRun: readBitgetDryRunFromEnv(), channels: {} });
  }
  try {
    const raw = JSON.parse(fs.readFileSync(p, "utf8"));
    return normalizeTradeConfig(raw);
  } catch {
    return normalizeTradeConfig({ enabled: false, dryRun: true, channels: {} });
  }
}

/**
 * @param {string} channelId
 * @param {BitgetTradeConfig} cfg
 * @returns {{ enabled: boolean; dryRun: boolean; channel: Required<BitgetTradeDefaults> & { name?: string } } | null}
 */
export function resolveChannelBitgetTrade(channelId, cfg) {
  const cid = String(channelId ?? "").trim();
  if (!cid || !cfg?.enabled) return null;

  const envList = config.bitgetAutoTradeChannelIds;
  const ch = cfg.channels[cid];
  if (envList.length && !envList.includes(cid)) return null;
  if (ch && ch.enabled === false) return null;
  if (!ch && envList.length === 0) return null;

  /** @type {Required<BitgetTradeDefaults> & { name?: string }} */
  const merged = {
    marginMode: ch?.marginMode ?? cfg.default.marginMode,
    leverage: ch?.leverage ?? cfg.default.leverage,
    orderSizeUsdt: ch?.orderSizeUsdt ?? cfg.default.orderSizeUsdt,
    orderType: ch?.orderType ?? cfg.default.orderType,
    productType: ch?.productType ?? cfg.default.productType,
    stagedTrade: ch?.stagedTrade ?? cfg.default.stagedTrade,
    initialSlPct: ch?.initialSlPct ?? cfg.default.initialSlPct,
    tpPartialRatios: ch?.tpPartialRatios ?? cfg.default.tpPartialRatios,
    name: ch?.name,
  };

  return { enabled: true, dryRun: cfg.dryRun, channel: merged };
}

/** @returns {{ configured: boolean; enabled: boolean; dryRun: boolean; channelCount: number; configFile: string }} */
export function getBitgetTradeStatus() {
  const cfg = loadBitgetTradeConfig();
  const configured = Boolean(config.bitgetApiKey && config.bitgetApiSecret && config.bitgetPassphrase);
  const channelCount = Object.values(cfg.channels).filter((c) => c.enabled !== false).length;
  return {
    configured,
    enabled: cfg.enabled && configured,
    dryRun: cfg.dryRun,
    channelCount: config.bitgetAutoTradeChannelIds.length || channelCount,
    configFile: config.bitgetTradeConfigFile,
  };
}
