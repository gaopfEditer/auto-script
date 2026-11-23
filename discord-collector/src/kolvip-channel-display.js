/**
 * 巨鲸 / kolvip-scan 虚拟频道 → 可读博主名（/cards、/eval、归档列表共用）。
 */
import { config } from "./config.js";
import { getKolvipChannelMappings } from "./kolvip-cdp-config.js";
import { resolveKolvipChannelIdForShow } from "./kolvip-channel-catchup.js";
import { findKolvipCatalogNameByKid } from "./kolvip-api-catalog.js";
import { getKolvipEvalRankedChannelName } from "./kolvip-eval-rank.js";
import { getSignalChannelConfig } from "./discord-signal-config.js";
import { parseKolvipScanVirtualChannelId } from "./kolvip-scan-config.js";

/** @param {string} name */
export function isTechnicalChannelLabel(name) {
  const s = String(name ?? "").trim();
  if (!s) return true;
  if (/^kolvip-scan-\d+$/i.test(s)) return true;
  if (/^kolvip-\d+$/i.test(s)) return true;
  if (/^\d{10,}$/.test(s)) return true;
  return false;
}

/**
 * @param {string} channelId
 * @returns {string} 空 = 未解析到人类可读名
 */
export function resolveKolvipChannelDisplayName(channelId) {
  const id = String(channelId ?? "").trim();
  if (!id) return "";

  const fromRank = getKolvipEvalRankedChannelName(id);
  if (fromRank && !isTechnicalChannelLabel(fromRank)) return fromRank;

  const showNames = config.discordShowSidebar?.namesByChannelId ?? {};
  const showName = String(showNames[id] ?? "").trim();
  if (showName && !isTechnicalChannelLabel(showName)) return showName;

  for (const m of getKolvipChannelMappings()) {
    if (String(m.discordChannelId) === id && m.logicName) return m.logicName;
  }

  const kid =
    parseKolvipScanVirtualChannelId(id) || resolveKolvipChannelIdForShow(id) || "";
  if (kid) {
    const fromCatalog = findKolvipCatalogNameByKid(kid);
    if (fromCatalog && !isTechnicalChannelLabel(fromCatalog)) return fromCatalog;
    const map = getKolvipChannelMappings().find((m) => String(m.kolvipChannelId) === String(kid));
    if (map?.logicName) return map.logicName;
  }

  const cfgName = getSignalChannelConfig(id)?.name;
  if (cfgName && !isTechnicalChannelLabel(cfgName)) return cfgName;

  return "";
}