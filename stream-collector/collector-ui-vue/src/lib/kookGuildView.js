/**
 * 从 Kook `guild/view` 接口 JSON 中解析频道树（CDP net_response_body）。
 */

/** @typedef {{ id: string, name: string, last_msg: string, type: number, guildId?: string }} KookLeafChannel */
/** @typedef {{ id: string, name: string, open: boolean, children: KookLeafChannel[] }} KookCategory */

const GUILD_VIEW_PATH = /\/api\/v2\/guild\/view\b/i;

/**
 * @param {string} url
 */
export function isGuildViewApiUrl(url) {
  const s = String(url ?? "");
  try {
    const u = new URL(s);
    const host = u.hostname.toLowerCase();
    if (!host.endsWith("kookapp.cn") && !host.includes("kook")) return false;
    return GUILD_VIEW_PATH.test(`${u.pathname}${u.search}`);
  } catch {
    return GUILD_VIEW_PATH.test(s);
  }
}

/**
 * @param {unknown} bodyJson
 * @returns {unknown[] | null}
 */
export function getGuildViewChannelsArray(bodyJson) {
  if (bodyJson == null || typeof bodyJson !== "object") return null;
  const o = /** @type {Record<string, unknown>} */ (bodyJson);
  if (Array.isArray(o.channels)) return o.channels;
  const d = o.data;
  if (d != null && typeof d === "object") {
    const inner = /** @type {Record<string, unknown>} */ (d);
    if (Array.isArray(inner.channels)) return inner.channels;
  }
  return null;
}

/**
 * @param {unknown} raw
 * @returns {raw is Record<string, unknown>}
 */
function isObj(raw) {
  return raw != null && typeof raw === "object" && !Array.isArray(raw);
}

/**
 * @param {Record<string, unknown>} u
 */
function pickChannelLastMsgPreview(u) {
  for (const k of [
    "last_msg_content",
    "last_msg",
    "last_message_content",
    "last_message",
    "last_content",
    "topic",
    "remark",
  ]) {
    const v = u[k];
    if (typeof v === "string" && v.trim()) return v.trim();
  }
  return "";
}

/**
 * @param {unknown[]} channels
 * @returns {{ categories: KookCategory[] }}
 */
export function buildGuildSidebarTree(channels) {
  /** @type {KookCategory[]} */
  const categories = [];
  /** @type {KookLeafChannel[]} */
  const orphans = [];

  for (const raw of channels) {
    if (!isObj(raw)) continue;
    const c = /** @type {Record<string, unknown>} */ (raw);
    const id = String(c.id ?? "");
    const name = String(c.name ?? "未命名");
    const isCat = Number(c.is_category) === 1 || c.is_category === true;

    if (isCat && Array.isArray(c.channels)) {
      /** @type {KookLeafChannel[]} */
      const children = [];
      for (const x of c.channels) {
        if (!isObj(x)) continue;
        const u = /** @type {Record<string, unknown>} */ (x);
        if (Number(u.is_category) === 1 || u.is_category === true) continue;
        children.push({
          id: String(u.id ?? ""),
          name: String(u.name ?? ""),
          last_msg: pickChannelLastMsgPreview(u),
          type: Number(u.type ?? 0),
          guildId: String(u.guild_id ?? ""),
        });
      }
      categories.push({ id, name, open: true, children });
    } else if (!isCat) {
      orphans.push({
        id,
        name,
        last_msg: pickChannelLastMsgPreview(c),
        type: Number(c.type ?? 0),
        guildId: String(c.guild_id ?? ""),
      });
    }
  }

  if (orphans.length) {
    categories.unshift({
      id: "__orphans__",
      name: "其它频道",
      open: true,
      children: orphans,
    });
  }

  return { categories };
}

/**
 * @param {string} url
 */
export function parseGuildIdFromViewUrl(url) {
  try {
    const u = new URL(url);
    const id = u.searchParams.get("id") || u.searchParams.get("active_id");
    return id || "";
  } catch {
    return "";
  }
}
