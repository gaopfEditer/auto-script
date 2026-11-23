/**
 * /eval 巨鲸信号：Show 胜率榜前 N 频道（默认 20）。
 */
import { config } from "./config.js";
import { resolveCardChannelName, resolveSourcePlatform } from "./card-archive-service.js";
import { getKolvipChannelMappings } from "./kolvip-cdp-config.js";
import { resolveKolvipChannelIdForShow } from "./kolvip-channel-catchup.js";
import { kolvipScanVirtualChannelId, parseKolvipScanVirtualChannelId } from "./kolvip-scan-config.js";
import {
  buildKolvipEvalChannelOptionsFromRank,
  ensureKolvipEvalRankFromSig,
  getKolvipEvalRankedChannelIds,
  getKolvipEvalRankedChannelName,
  getKolvipEvalRankSource,
} from "./kolvip-eval-rank.js";

export {
  ensureKolvipEvalRankFromSig,
  getKolvipEvalRankedChannelIds,
  getKolvipEvalRankSource,
};

const DEFAULT_TOP_N = 20;

/** @returns {number} */
export function getKolvipEvalTopChannelCount() {
  const n = Number(process.env.KOLVIP_EVAL_TOP_CHANNELS ?? DEFAULT_TOP_N);
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.floor(n)) : DEFAULT_TOP_N;
}

/** 榜位 showId → 该博主所有卡片 channelId（含 kolvip-scan-*） */
export function getKolvipEvalChannelIdAliases(showChannelId) {
  const showId = String(showChannelId ?? "").trim();
  if (!showId) return [];
  const ids = new Set([showId]);
  const kid =
    resolveKolvipChannelIdForShow(showId) ?? parseKolvipScanVirtualChannelId(showId) ?? "";
  if (kid) {
    ids.add(kolvipScanVirtualChannelId(kid));
    for (const m of getKolvipChannelMappings()) {
      if (String(m.kolvipChannelId) === kid) ids.add(String(m.discordChannelId));
    }
  }
  return [...ids];
}

/** @param {string} channelId 卡片 channel_id */
export function getKolvipEvalChannelRank(channelId) {
  const cid = String(channelId ?? "").trim();
  if (!cid) return 0;
  const ranked = getKolvipEvalRankedChannelIds();
  for (let i = 0; i < ranked.length; i++) {
    if (getKolvipEvalChannelIdAliases(ranked[i]).includes(cid)) return i + 1;
  }
  return 0;
}

/** show 榜位 → 聚合用主 channelId（Show 侧栏 id） */
export function getKolvipEvalShowChannelForCard(channelId) {
  const cid = String(channelId ?? "").trim();
  for (const showId of getKolvipEvalRankedChannelIds()) {
    if (getKolvipEvalChannelIdAliases(showId).includes(cid)) return showId;
  }
  return "";
}

/** @param {string[]} sourceTypes */
export function isKolvipEvalSourceFilter(sourceTypes) {
  return sourceTypes.length === 1 && sourceTypes[0] === "kolvip";
}

/**
 * 评估页「巨鲸」：榜内 Discord 频道上的 kolvip / discord 建卡。
 * @param {Record<string, unknown>} card
 */
export function kolvipEvalCardInScope(card) {
  const showId = getKolvipEvalShowChannelForCard(String(card?.channelId ?? ""));
  if (!showId) return false;
  const platform = resolveSourcePlatform(card?.sourceType ?? card?.source_type ?? "");
  if (platform === "kolvip" || platform === "discord") return true;
  const st = String(card?.sourceType ?? card?.source_type ?? "").toLowerCase();
  return st.includes("kolvip");
}

/** @param {Array<Record<string, unknown>>} cards */
export function filterKolvipEvalCards(cards) {
  return cards.filter((c) => kolvipEvalCardInScope(c));
}

/** @param {Array<Record<string, unknown>>} cards */
export function groupKolvipEvalCardsByShow(cards) {
  /** @type {Map<string, Array<Record<string, unknown>>>} */
  const by = new Map();
  for (const card of cards) {
    const showId = getKolvipEvalShowChannelForCard(String(card?.channelId ?? ""));
    if (!showId) continue;
    if (!by.has(showId)) by.set(showId, []);
    by.get(showId)?.push(card);
  }
  return by;
}

/** 发车频道下拉：榜内频道（无卡 count=0） */
export function buildKolvipEvalChannelOptions() {
  return buildKolvipEvalChannelOptionsFromRank().map((c) => ({
    ...c,
    channelName: resolveCardChannelName(c.channelId, c.channelName || getKolvipEvalRankedChannelName(c.channelId)),
  }));
}

export { DEFAULT_TOP_N as KOLVIP_EVAL_DEFAULT_TOP_N };