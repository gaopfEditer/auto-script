/**
 * 巨鲸助手 Pro（kolvip.vip）**临时**信号源：与 Discord CDP 并行存在，用 env 开关切换。
 *
 * - `KOLVIP_CDP_ENABLED=1`：从 kolvip 抓消息 → 现有 signal card / Telegram 管道。
 * - `KOLVIP_CDP_BYPASS_DISCORD_SIGNALS=1`（kolvip 开启时默认）：仅旁路 Discord **建卡**（同映射频道），
 *   Gateway 采集与其它 Discord 逻辑不变；`KOLVIP_CDP_ENABLED=0` 即恢复纯 Discord 出卡。
 * - `KOLVIP_CDP_BYPASS_DISCORD_SIGNALS=0`：双源并行（可能重复推送，仅调试）。
 *
 * 频道 → 仍用 DEFAULT_SIGNAL_CHANNELS 里的 Discord channelId / parser，不删 Discord 配置。
 * 飞扬 / seven / 山寨之王 在巨鲸侧暂无对应频道，不在默认表内。
 */
import { config } from "./config.js";

/** @typedef {{ logicName: string, kolvipChannelId: string, discordChannelId: string, parser: string }} KolvipChannelMapping */

/** @type {KolvipChannelMapping[]} */
export const DEFAULT_KOLVIP_CHANNEL_MAPPINGS = [
  { logicName: "大镖客", kolvipChannelId: "1", discordChannelId: "1444962339743989843", parser: "dabiaoke" },
  { logicName: "淑琴", kolvipChannelId: "4", discordChannelId: "1444962376066793513", parser: "btc_cn" },
  { logicName: "三马", kolvipChannelId: "8", discordChannelId: "1444962439471955989", parser: "streak_cn" },
  { logicName: "峰哥", kolvipChannelId: "10", discordChannelId: "1444963929393729686", parser: "fengge" },
  { logicName: "军长", kolvipChannelId: "11", discordChannelId: "1444963474718462085", parser: "junzhang" },
  { logicName: "所长", kolvipChannelId: "12", discordChannelId: "1444963405185159238", parser: "biquan_suozhang" },
  { logicName: "胖猫社区", kolvipChannelId: "16", discordChannelId: "1562351038277619783", parser: "pangmao" },
  { logicName: "颜驰", kolvipChannelId: "22", discordChannelId: "1444963689194192947", parser: "yanchi" },
  // 飞扬 / seven / 山寨之王：巨鲸未找到，留空不映射
];

const KOLVIP_WEB_URL = "https://kolvip.vip/web";

/** @returns {KolvipChannelMapping[]} */
export function getKolvipChannelMappings() {
  const fromEnv = config.kolvipChannelMappings;
  if (fromEnv.length) return fromEnv;
  return DEFAULT_KOLVIP_CHANNEL_MAPPINGS;
}

/** @returns {Map<string, KolvipChannelMapping>} kolvipChannelId → mapping */
export function kolvipChannelMapByKolvipId() {
  const map = new Map();
  for (const m of getKolvipChannelMappings()) {
    map.set(String(m.kolvipChannelId), m);
  }
  return map;
}

/** @param {string} kolvipChannelId */
export function getKolvipMappingByKolvipId(kolvipChannelId) {
  return kolvipChannelMapByKolvipId().get(String(kolvipChannelId ?? "").trim()) ?? null;
}

/** @returns {Set<string>} 对应 Discord 信号频道 ID（旁路 Gateway 建卡用） */
export function getKolvipMappedDiscordChannelIds() {
  return new Set(getKolvipChannelMappings().map((m) => m.discordChannelId));
}

/**
 * @param {string} discordChannelId
 * @returns {boolean}
 */
export function shouldBypassDiscordSignalChannel(discordChannelId) {
  if (!config.kolvipCdpEnabled || !config.kolvipCdpBypassDiscordSignals) return false;
  return getKolvipMappedDiscordChannelIds().has(String(discordChannelId ?? "").trim());
}

export function kolvipWebUrl() {
  return (config.kolvipWebUrl || KOLVIP_WEB_URL).trim() || KOLVIP_WEB_URL;
}

/**
 * 解析 KOLVIP_CHANNEL_IDS=1:144496...,4:144496... 或 1,4,8（使用默认 Discord id）
 * @param {string} raw
 * @returns {KolvipChannelMapping[]}
 */
export function parseKolvipChannelIdsEnv(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return [];
  /** @type {Map<string, KolvipChannelMapping>} */
  const defaults = new Map(
    DEFAULT_KOLVIP_CHANNEL_MAPPINGS.map((m) => [String(m.kolvipChannelId), m])
  );
  /** @type {KolvipChannelMapping[]} */
  const out = [];
  const seen = new Set();
  for (const part of s.split(/[,;\s]+/).filter(Boolean)) {
    const colon = part.match(/^(\d+)\s*:\s*(\d{6,})$/);
    if (colon) {
      const kid = colon[1];
      if (seen.has(kid)) continue;
      seen.add(kid);
      const def = defaults.get(kid);
      out.push({
        logicName: def?.logicName ?? `kolvip-${kid}`,
        kolvipChannelId: kid,
        discordChannelId: colon[2],
        parser: def?.parser ?? "generic",
      });
      continue;
    }
    if (/^\d+$/.test(part)) {
      const kid = part;
      if (seen.has(kid)) continue;
      const def = defaults.get(kid);
      if (!def) continue;
      seen.add(kid);
      out.push({ ...def });
    }
  }
  return out;
}
