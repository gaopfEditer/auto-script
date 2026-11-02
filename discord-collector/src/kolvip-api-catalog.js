/**
 * 巨鲸全站频道列表（/webu/channels）缓存。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kolvipApiListChannels } from "./kolvip-api-client.js";
import { buildKolvipApiClient } from "./kolvip-api-fetch.js";
import {
  getKolvipChannelMappings,
  getKolvipMappedKolvipChannelIds,
} from "./kolvip-cdp-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_PATH = path.join(__dirname, "..", "data", "kolvip-channel-catalog.json");

/**
 * @typedef {{
 *   kolvipChannelId: string,
 *   name: string,
 *   canSpeak: boolean,
 *   groupId: number,
 *   categoryId: number,
 *   curated: boolean,
 * }} KolvipCatalogChannel
 */

/**
 * @param {unknown} data
 * @returns {KolvipCatalogChannel[]}
 */
export function normalizeKolvipCatalogResponse(data) {
  const curated = getKolvipMappedKolvipChannelIds();
  const raw = data && typeof data === "object" ? data : {};
  const list = Array.isArray(/** @type {{ channels?: unknown }} */ (raw).channels)
    ? /** @type {Array<Record<string, unknown>>} */ (/** @type {{ channels: unknown }} */ (raw).channels)
    : [];
  /** @type {KolvipCatalogChannel[]} */
  const out = [];
  const seen = new Set();
  for (const c of list) {
    const kid = String(c.id ?? "").trim();
    if (!kid || seen.has(kid)) continue;
    seen.add(kid);
    out.push({
      kolvipChannelId: kid,
      name: String(c.name ?? `ch-${kid}`).trim(),
      canSpeak: Boolean(c.can_speak),
      groupId: Number(c.group_id) || 0,
      categoryId: Number(c.category_id) || 0,
      curated: curated.has(kid),
    });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name, "zh"));
}

export async function loadKolvipCatalogCache() {
  try {
    const raw = await fs.readFile(CATALOG_PATH, "utf8");
    const j = JSON.parse(raw);
    if (!j || typeof j !== "object") throw new Error("bad catalog");
    return {
      updatedAt: String(j.updatedAt ?? ""),
      channels: Array.isArray(j.channels) ? j.channels : [],
    };
  } catch {
    return { updatedAt: "", channels: /** @type {KolvipCatalogChannel[]} */ ([]) };
  }
}

/** @param {KolvipCatalogChannel[]} channels */
export async function saveKolvipCatalogCache(channels) {
  const payload = {
    updatedAt: new Date().toISOString(),
    channels,
    curatedMappings: getKolvipChannelMappings(),
  };
  await fs.mkdir(path.dirname(CATALOG_PATH), { recursive: true });
  await fs.writeFile(CATALOG_PATH, JSON.stringify(payload, null, 2), "utf8");
  return payload;
}

/**
 * @param {ReturnType<typeof import('./logger.js').createLogger>} log
 */
export async function syncKolvipChannelCatalog(log) {
  const { client } = await buildKolvipApiClient(log);
  const data = await kolvipApiListChannels(client, { markRead: false });
  const channels = normalizeKolvipCatalogResponse(data);
  const saved = await saveKolvipCatalogCache(channels);
  log.info(`巨鲸频道目录已同步 ${channels.length} 个（精选 ${channels.filter((c) => c.curated).length}）`);
  return saved;
}

/** 仅浏览频道（与精选跟单一致，排除可发言聊天室） */
export function listKolvipBrowseChannels(catalog) {
  return (catalog.channels || []).filter((c) => !c.canSpeak);
}

export function listKolvipScanCandidateChannels(catalog) {
  const curated = getKolvipMappedKolvipChannelIds();
  return listKolvipBrowseChannels(catalog).filter((c) => !curated.has(c.kolvipChannelId));
}
