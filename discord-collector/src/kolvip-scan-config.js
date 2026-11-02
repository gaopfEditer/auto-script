/**
 * 巨鲸非精选频道：虚拟 signal channelId，仅胜率扫描、不跟单 TG。
 */
import { config } from "./config.js";

const SCAN_PREFIX = "kolvip-scan-";

/** @param {string} kolvipChannelId */
export function kolvipScanVirtualChannelId(kolvipChannelId) {
  return `${SCAN_PREFIX}${String(kolvipChannelId ?? "").trim()}`;
}

/** @param {string} channelId @returns {string|null} kolvip ch id */
export function parseKolvipScanVirtualChannelId(channelId) {
  const id = String(channelId ?? "").trim();
  if (!id.startsWith(SCAN_PREFIX)) return null;
  const kid = id.slice(SCAN_PREFIX.length);
  return /^\d+$/.test(kid) ? kid : null;
}

/** @param {string} channelId @param {string} [displayName] */
export function resolveKolvipScanSignalConfig(channelId, displayName) {
  if (!config.kolvipScanEvalEnabled) return null;
  const kid = parseKolvipScanVirtualChannelId(channelId);
  if (!kid) return null;
  const name = String(displayName ?? "").trim() || `kolvip-${kid}`;
  return {
    name,
    parser: /** @type {const} */ ("generic"),
    styles: ["cn_brief"],
    telegramStyle: "cn_brief",
  };
}

/** @param {string} source @param {string} channelId */
export function isKolvipScanOnlyIngest(source, channelId) {
  if (String(source ?? "") === "kolvip_api_scan") return true;
  return Boolean(parseKolvipScanVirtualChannelId(channelId));
}
