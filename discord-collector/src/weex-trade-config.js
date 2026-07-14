/**
 * WEEX 自动下单配置：密钥来自 WEEX_*；频道策略与 Bitget 共用 JSON；保证金/杠杆等沿用 BITGET_* 交易参数。
 */
import dotenv from "dotenv";
import { fileURLToPath } from "node:url";
import path from "node:path";

import { config } from "./config.js";
import { loadBitgetTradeConfig, resolveChannelBitgetTrade } from "./bitget-trade-config.js";

const _dir = path.dirname(fileURLToPath(import.meta.url));
const _envPath = path.join(_dir, "..", ".env");

export function refreshWeexEnvFromDotenv() {
  dotenv.config({ path: _envPath, override: true });
}

/** @returns {boolean} */
export function readWeexDryRunFromEnv() {
  refreshWeexEnvFromDotenv();
  const raw = process.env.WEEX_DRY_RUN ?? process.env.BITGET_DRY_RUN ?? "1";
  return !["0", "false", "no", "off"].includes(String(raw).toLowerCase());
}

/** @returns {boolean} */
function readWeexEnabledFromEnv() {
  return !["0", "false", "no", "off"].includes(String(process.env.WEEX_ENABLED ?? "0").toLowerCase());
}

/** @returns {ReturnType<typeof loadBitgetTradeConfig>} */
export function loadWeexTradeConfig(filePath = config.bitgetTradeConfigFile) {
  const base = loadBitgetTradeConfig(filePath);
  return {
    ...base,
    enabled: readWeexEnabledFromEnv(),
    dryRun: readWeexDryRunFromEnv(),
  };
}

/** @param {string} channelId @param {ReturnType<typeof loadWeexTradeConfig>} cfg */
export function resolveChannelWeexTrade(channelId, cfg) {
  if (!readWeexEnabledFromEnv()) return null;
  const cid = String(channelId ?? "").trim();
  if (!cid) return null;

  const envList = config.weexAutoTradeChannelIds;
  if (envList.length && !envList.includes(cid)) return null;

  const bitgetResolved = resolveChannelBitgetTrade(channelId, { ...cfg, enabled: true, dryRun: cfg.dryRun });
  if (bitgetResolved) return { ...bitgetResolved, dryRun: cfg.dryRun };

  if (envList.includes(cid)) {
    return { enabled: true, dryRun: cfg.dryRun, channel: { ...cfg.default } };
  }
  return null;
}

/** @returns {{ configured: boolean; enabled: boolean; dryRun: boolean; channelCount: number; configFile: string }} */
export function getWeexTradeStatus() {
  const cfg = loadWeexTradeConfig();
  const configured = Boolean(config.weexApiKey && config.weexApiSecret && config.weexPassphrase);
  const channelCount = Object.values(cfg.channels).filter((c) => c.enabled !== false).length;
  return {
    configured,
    enabled: cfg.enabled && configured,
    dryRun: cfg.dryRun,
    channelCount: config.weexAutoTradeChannelIds.length || channelCount,
    configFile: config.bitgetTradeConfigFile,
  };
}
