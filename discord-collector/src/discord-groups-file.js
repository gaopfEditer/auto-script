/**
 * Discord 频道清单（Show 侧栏 + Local 回测）：data/discord_groups.json
 * 不再使用 .env 的 DISCORD_GROUPS 长串。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data");
export const DISCORD_GROUPS_FILE = path.join(DATA_DIR, "discord_groups.json");
export const DISCORD_GROUPS_EXAMPLE_FILE = path.join(DATA_DIR, "discord_groups.example.json");
/** @deprecated 仅作迁移兜底 */
const LEGACY_BACKFILL_FILE = path.join(DATA_DIR, "discord_backfill_groups.json");

/**
 * @param {unknown} raw
 * @returns {Array<{ channelId: string, name?: string, guildId?: string, enabled?: boolean, note?: string }>}
 */
function normalizeChannelEntries(raw) {
  if (!Array.isArray(raw)) return [];
  /** @type {Array<{ channelId: string, name?: string, guildId?: string, enabled?: boolean, note?: string }>} */
  const out = [];
  for (const item of raw) {
    if (!item || typeof item !== "object") continue;
    const channelId = String(
      /** @type {Record<string, unknown>} */ (item).channelId ??
        /** @type {Record<string, unknown>} */ (item).channel_id ??
        "",
    ).trim();
    if (!channelId) continue;
    out.push({
      channelId,
      name: String(/** @type {Record<string, unknown>} */ (item).name ?? "").trim() || undefined,
      guildId:
        String(
          /** @type {Record<string, unknown>} */ (item).guildId ??
            /** @type {Record<string, unknown>} */ (item).guild_id ??
            "",
        ).trim() || undefined,
      enabled: /** @type {Record<string, unknown>} */ (item).enabled !== false,
      note: String(/** @type {Record<string, unknown>} */ (item).note ?? "").trim() || undefined,
    });
  }
  return out;
}

/**
 * @param {string} raw `channelId:名称` 逗号分隔
 * @returns {{ channelIds: string[], namesByChannelId: Record<string, string> }}
 */
export function parseDiscordGroups(raw) {
  /** @type {string[]} */
  const channelIds = [];
  /** @type {Record<string, string>} */
  const namesByChannelId = {};
  const seen = new Set();
  if (!raw?.trim()) return { channelIds, namesByChannelId };
  for (const part of raw.replace(/\|/g, ",").split(",")) {
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
 * @param {Array<{ channelId: string, name?: string }>} entries
 */
export function showEntriesToDiscordGroups(entries) {
  /** @type {string[]} */
  const parts = [];
  for (const e of entries) {
    const id = String(e.channelId ?? "").trim();
    if (!id) continue;
    const name = String(e.name ?? "").trim();
    parts.push(name ? `${id}:${name}` : id);
  }
  return parseDiscordGroups(parts.join(","));
}

function resolveGroupsFilePath() {
  const override = String(process.env.DISCORD_GROUPS_FILE ?? "").trim();
  if (override) return path.isAbsolute(override) ? override : path.resolve(DATA_DIR, override);
  return DISCORD_GROUPS_FILE;
}

function readJsonObject(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    const raw = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return raw && typeof raw === "object" ? raw : null;
  } catch {
    return null;
  }
}

/**
 * @returns {{
 *   filePath: string;
 *   loaded: boolean;
 *   showChannels: Array<{ channelId: string, name?: string, guildId?: string, enabled?: boolean, note?: string }>;
 *   backfillChannels: Array<{ channelId: string, name?: string, guildId?: string, enabled?: boolean, note?: string }>;
 *   discordGroups: ReturnType<typeof parseDiscordGroups>;
 * }}
 */
export function loadDiscordGroupsFromFile() {
  const filePath = resolveGroupsFilePath();
  const doc = readJsonObject(filePath);
  /** @type {Array<{ channelId: string, name?: string, guildId?: string, enabled?: boolean, note?: string }>} */
  let showChannels = [];
  /** @type {Array<{ channelId: string, name?: string, guildId?: string, enabled?: boolean, note?: string }>} */
  let backfillChannels = [];

  if (doc) {
    showChannels = normalizeChannelEntries(
      doc.showChannels ?? doc.show ?? doc.showGroups ?? doc.discordGroups,
    );
    backfillChannels = normalizeChannelEntries(
      doc.backfillChannels ?? doc.backfill ?? doc.backfillGroups,
    );
    if (!backfillChannels.length && Array.isArray(doc.groups)) {
      backfillChannels = normalizeChannelEntries(doc.groups);
    }
  }

  if (!backfillChannels.length) {
    const legacy = readJsonObject(LEGACY_BACKFILL_FILE);
    if (legacy && Array.isArray(legacy.groups)) {
      backfillChannels = normalizeChannelEntries(legacy.groups);
    }
  }

  const discordGroups =
    showChannels.length > 0
      ? showEntriesToDiscordGroups(showChannels)
      : { channelIds: [], namesByChannelId: {} };

  return {
    filePath,
    loaded: Boolean(doc),
    showChannels,
    backfillChannels,
    discordGroups,
  };
}
