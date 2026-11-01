/**
 * Show 页（/show）左侧频道列表：顺序与白名单。
 * 新增频道：在此表追加 id，并在 discord-signal-config.js 登记 parser/name。
 */

/**
 * `DISCORD_SHOW_CHANNEL_IDS` / `DISCORD_GROUPS`：`channelId` 或 `channelId:显示名`，逗号分隔。
 * @returns {{ channelIds: string[], namesByChannelId: Record<string, string> }}
 */
function parseShowChannelEnv(raw) {
  /** @type {string[]} */
  const channelIds = [];
  /** @type {Record<string, string>} */
  const namesByChannelId = {};
  const seen = new Set();
  if (!String(raw ?? "").trim()) return { channelIds, namesByChannelId };
  for (const part of String(raw).replace(/\|/g, ",").split(",")) {
    const seg = part.trim();
    if (!seg) continue;
    const colon = seg.indexOf(":");
    let id = "";
    let name = "";
    if (colon > 0) {
      id = seg.slice(0, colon).trim();
      name = seg.slice(colon + 1).trim();
    } else {
      id = seg;
    }
    if (!id || seen.has(id)) continue;
    seen.add(id);
    channelIds.push(id);
    if (name) namesByChannelId[id] = name;
  }
  return { channelIds, namesByChannelId };
}

/**
 * 默认侧栏频道（与 DEFAULT_SIGNAL_CHANNELS 一致；顺序即 UI 展示顺序）。
 * @type {readonly string[]}
 */
export const DEFAULT_SHOW_CHANNEL_IDS = [
  "1444962339743989843", // 大镖客
  "1444962376066793513", // 淑琴行情分析
  "1564946716321382462", // 淑琴美股频道
  "1561796495492259901", // dr-hash延报
  "1444963605786267739", // 加密大漂亮
  "1444963641219747902", // 反指姐（反向跟单）
  "1559133861617602630", // 零下二度
  "1559133911001337866", // 零下二度-美股
  "1444962410002911396", // 飞扬
  "1444962439471955989", // 三马
  "1444963372134301827", // seven
  "1444963929393729686", // 峰哥
  "1444963689194192947", // 颜驰
  "1444967547169669160", // 币安杀手
  "1459861535815110810", // unknown-trader
  "1444963506431463474", // 山寨之王
  "1444963405185159238", // 币圈所长
  "1444963474718462085", // 军长
  "1562351038277619783", // 胖猫社区
];

/**
 * @param {string} [envShowRaw] `DISCORD_SHOW_CHANNEL_IDS`（id 或 id:显示名）
 * @param {string} [envGroupsRaw] 兼容旧 `DISCORD_GROUPS`（仅当 SHOW 未配置时）
 * @returns {{ channelIds: string[], namesByChannelId: Record<string, string> }}
 */
export function buildShowSidebarChannelGroups(envShowRaw = "", envGroupsRaw = "") {
  const fromShow = parseShowChannelEnv(String(envShowRaw ?? "").trim());
  const fromGroups = parseShowChannelEnv(String(envGroupsRaw ?? "").trim());
  const picked = fromShow.channelIds.length ? fromShow : fromGroups;
  const channelIds = picked.channelIds.length ? picked.channelIds : [...DEFAULT_SHOW_CHANNEL_IDS];

  /** @type {Record<string, string>} */
  const namesByChannelId = {};
  for (const id of channelIds) {
    const fromEnv = picked.namesByChannelId[id];
    if (fromEnv) {
      namesByChannelId[id] = fromEnv;
      continue;
    }
    // 避免与 config/signal-config 循环依赖：侧栏名以 env/默认表为准
    const fromSignal = undefined;
    if (fromSignal) namesByChannelId[id] = fromSignal;
  }
  return { channelIds, namesByChannelId };
}
