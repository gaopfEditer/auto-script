/**
 * /eval 胜率榜频道真源：data/kolvip-sig/rank-*（默认 30 天），映射到 Discord / kolvip-scan 频道 id。
 */
import { config } from "./config.js";
import { getKolvipChannelMappings } from "./kolvip-cdp-config.js";
import { loadKolvipCatalogCache } from "./kolvip-api-catalog.js";
import { loadKolvipSigRank } from "./kolvip-sig-store.js";
import { kolvipScanVirtualChannelId, parseKolvipScanVirtualChannelId } from "./kolvip-scan-config.js";
import { resolveKolvipChannelIdForShow } from "./kolvip-channel-catchup.js";
const DEFAULT_RANK_RANGE = "30";
const DEFAULT_TOP_N = 20;

function getTopN() {
  const n = Number(process.env.KOLVIP_EVAL_TOP_CHANNELS ?? DEFAULT_TOP_N);
  return Number.isFinite(n) && n > 0 ? Math.min(100, Math.floor(n)) : DEFAULT_TOP_N;
}

/** @typedef {{ channelId: string, channelName: string, kolvipChannelId?: string, rank: number, sigWinRate?: number }} KolvipEvalRankEntry */

/** @type {{ ids: string[], entries: KolvipEvalRankEntry[], source: string, range: string, at: number }} */
let cache = { ids: [], entries: [], source: "none", range: "", at: 0 };

/** @param {string} s */
function normLabel(s) {
  return String(s ?? "")
    .toLowerCase()
    .replace(/[\s·|｜\-_—（）()[\]【】vip合约频道信号日内]/gi, "");
}

/**
 * @param {string} a
 * @param {string} b
 */
export function kolvipLabelsMatch(a, b) {
  const x = normLabel(a);
  const y = normLabel(b);
  if (!x || !y) return false;
  if (x === y) return true;
  const min = Math.min(4, x.length, y.length);
  if (min >= 2 && (x.includes(y.slice(0, min)) || y.includes(x.slice(0, min)))) return true;
  return x.includes(y) || y.includes(x);
}

/**
 * @param {{ name?: string, channel?: string }} row
 * @param {import('./kolvip-api-catalog.js').KolvipCatalogChannel[]} catalog
 */
function resolveRankRowChannel(row, catalog) {
  const labels = [row.name, row.channel].filter(Boolean).map(String);
  const displayName = String(row.name || row.channel || "").trim();

  for (const m of getKolvipChannelMappings()) {
    for (const lab of labels) {
      if (kolvipLabelsMatch(lab, m.logicName)) {
        return {
          channelId: m.discordChannelId,
          channelName: displayName || m.logicName,
          kolvipChannelId: m.kolvipChannelId,
        };
      }
    }
  }

  const showNames = config.discordShowSidebar?.namesByChannelId ?? {};
  for (const [discordId, showName] of Object.entries(showNames)) {
    for (const lab of labels) {
      if (kolvipLabelsMatch(lab, showName)) {
        const kid = resolveKolvipChannelIdForShow(discordId);
        return {
          channelId: String(discordId),
          channelName: displayName || showName,
          kolvipChannelId: kid ?? undefined,
        };
      }
    }
  }

  for (const c of catalog) {
    for (const lab of labels) {
      if (kolvipLabelsMatch(lab, c.name)) {
        const kid = String(c.kolvipChannelId);
        const curated = getKolvipChannelMappings().find((m) => m.kolvipChannelId === kid);
        return {
          channelId: curated?.discordChannelId ?? kolvipScanVirtualChannelId(kid),
          channelName: displayName || c.name,
          kolvipChannelId: kid,
        };
      }
    }
  }

  return null;
}

function fallbackDiscordShowIds() {
  const topN = getTopN();
  const fromEnv = config.kolvipEvalChannelIds;
  if (fromEnv?.length) return fromEnv.slice(0, topN).map(String);
  const fromShow = config.discordShowSidebar?.channelIds ?? [];
  return fromShow.slice(0, topN).map(String);
}

/**
 * 从 kolvip-sig 刷新评估榜（失败则保留 fallback）。
 * @returns {Promise<boolean>}
 */
export async function ensureKolvipEvalRankFromSig() {
  const topN = getTopN();
  const range = String(process.env.KOLVIP_EVAL_RANK_RANGE ?? DEFAULT_RANK_RANGE).trim() || DEFAULT_RANK_RANGE;
  const data = await loadKolvipSigRank(range);
  const list = Array.isArray(data?.list) ? data.list : [];
  if (!list.length) {
    if (!cache.ids.length) {
      const ids = fallbackDiscordShowIds();
      const names = config.discordShowSidebar?.namesByChannelId ?? {};
      cache = {
        ids,
        entries: ids.map((channelId, i) => ({
          channelId,
          channelName: String(names[channelId] ?? channelId),
          rank: i + 1,
        })),
        source: "discord-show",
        range,
        at: Date.now(),
      };
    }
    return false;
  }

  const catalog = (await loadKolvipCatalogCache()).channels;
  /** @type {KolvipEvalRankEntry[]} */
  const entries = [];
  const seen = new Set();
  for (const row of list) {
    if (row && typeof row === "object" && row.ranked === false) continue;
    if (entries.length >= topN) break;
    const hit = resolveRankRowChannel(row, catalog);
    if (!hit?.channelId || seen.has(hit.channelId)) continue;
    seen.add(hit.channelId);
    entries.push({
      channelId: hit.channelId,
      channelName: hit.channelName,
      kolvipChannelId: hit.kolvipChannelId,
      rank: entries.length + 1,
      sigWinRate: Number(row.win_rate) || undefined,
    });
  }

  if (!entries.length) return false;
  cache = {
    ids: entries.map((e) => e.channelId),
    entries,
    source: "kolvip-sig",
    range,
    at: Date.now(),
  };
  return true;
}

/** @returns {string[]} */
export function getKolvipEvalRankedChannelIds() {
  if (cache.ids.length) return [...cache.ids];
  return fallbackDiscordShowIds();
}

export function getKolvipEvalRankSource() {
  return cache.source || "discord-show";
}

/** @param {string} channelId */
export function getKolvipEvalRankedChannelName(channelId) {
  const cid = String(channelId ?? "").trim();
  const hit = cache.entries.find((e) => e.channelId === cid);
  if (hit?.channelName) return hit.channelName;
  const kid = parseKolvipScanVirtualChannelId(cid) || resolveKolvipChannelIdForShow(cid);
  if (kid) {
    const byKid = cache.entries.find((e) => String(e.kolvipChannelId) === String(kid));
    if (byKid?.channelName) return byKid.channelName;
  }
  const names = config.discordShowSidebar?.namesByChannelId ?? {};
  return String(names[cid] ?? "").trim();
}

/** 评估页发车下拉 */
export function buildKolvipEvalChannelOptionsFromRank() {
  return getKolvipEvalRankedChannelIds().map((id, idx) => ({
    channelId: id,
    channelName: getKolvipEvalRankedChannelName(id) || id,
    rank: idx + 1,
    count: 0,
  }));
}