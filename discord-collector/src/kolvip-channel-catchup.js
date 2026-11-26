/**
 * kolvip HTTP 主动拉取（补 WS 断线漏消息、Show 切频道 / 向上翻页）。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { kolvipApiFetchChannelMessages } from "./kolvip-api-client.js";
import { buildKolvipApiClient } from "./kolvip-api-fetch.js";
import { kolvipApiRawToDomMessage } from "./kolvip-api-message.js";
import {
  getKolvipChannelMappings,
  getKolvipMappingByKolvipId,
  getKolvipMappedKolvipChannelIds,
} from "./kolvip-cdp-config.js";
import { ingestKolvipMessageBatch, loadKolvipSeen, saveKolvipSeen } from "./kolvip-ingest.js";
import { loadKolvipBitgetAutotrade } from "./kolvip-bitget-autotrade.js";
import { loadDiscordGroupsFromFile } from "./discord-groups-file.js";
import { kolvipScanVirtualChannelId, parseKolvipScanVirtualChannelId } from "./kolvip-scan-config.js";
import { markKolvipShowCatchupWarmed } from "./kolvip-show-catchup-cache.js";
import { cacheKolvipMessageAuthorAvatars } from "./kolvip-avatar-cache.js";
import { parseKolvipMessageTimeMs } from "./kolvip-cdp-message.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SEEN_PATH = path.join(__dirname, "..", "data", "kolvip-cdp-seen.json");

/** @param {string} [note] */
export function parseKolvipKidFromNote(note) {
  const m = String(note ?? "").match(/\bkid=(\d+)\b/i);
  return m ? m[1] : null;
}

/**
 * 从跟单白名单把 Discord 雪花 / 虚拟 id 反查成巨鲸频道 id。
 * @param {string} channelId
 * @param {Array<{ channelIds?: string[], kolvipChannelId?: string }>} [policies]
 */
export function resolveKolvipKidFromAutotradePolicies(channelId, policies) {
  const cid = String(channelId ?? "").trim();
  if (!cid) return null;
  for (const p of policies ?? []) {
    const ids = (p?.channelIds ?? []).map((x) => String(x));
    if (!ids.includes(cid)) continue;
    const explicit = String(p.kolvipChannelId ?? "").trim();
    if (explicit) return explicit;
    for (const id of ids) {
      const kid = parseKolvipScanVirtualChannelId(id);
      if (kid) return kid;
    }
  }
  return null;
}

/**
 * showChannels.note 里的 `kid=13`（榜单生成时写下）。
 * @param {string} channelId
 * @param {Array<{ channelId?: string, note?: string }>} [entries]
 */
export function resolveKolvipKidFromShowChannelEntries(channelId, entries) {
  const cid = String(channelId ?? "").trim();
  if (!cid) return null;
  for (const e of entries ?? []) {
    if (String(e.channelId ?? "").trim() !== cid) continue;
    const kid = parseKolvipKidFromNote(e.note);
    if (kid) return kid;
  }
  return null;
}

/**
 * @param {string} discordOrVirtualChannelId
 */
export function resolveKolvipChannelIdForShow(discordOrVirtualChannelId) {
  const cid = String(discordOrVirtualChannelId ?? "").trim();
  if (!cid) return null;
  const scanKid = parseKolvipScanVirtualChannelId(cid);
  if (scanKid) return scanKid;
  for (const m of getKolvipChannelMappings()) {
    if (String(m.discordChannelId) === cid) return String(m.kolvipChannelId);
  }
  const fromAuto = resolveKolvipKidFromAutotradePolicies(
    cid,
    loadKolvipBitgetAutotrade().policies ?? [],
  );
  if (fromAuto) return fromAuto;
  const fromGroups = resolveKolvipKidFromShowChannelEntries(
    cid,
    loadDiscordGroupsFromFile().showChannels ?? [],
  );
  if (fromGroups) return fromGroups;
  return null;
}

/**
 * Show 榜单 kolvip-scan 与跟单白名单（非精选 8 路）需要 HTTP 尾拉。
 * 侧栏若仍写 Discord 雪花，也要能解析到 kid，否则会漏补（如零下二度）。
 *
 * @param {string[]} [sidebarChannelIds]
 * @param {{
 *   curatedKids?: Set<string> | string[],
 *   policies?: Array<{ channelIds?: string[], kolvipChannelId?: string }>,
 * }} [opts]
 * @returns {string[]}
 */
export function listKolvipShowScanCatchupIds(sidebarChannelIds, opts = {}) {
  const curatedRaw = opts.curatedKids ?? getKolvipMappedKolvipChannelIds();
  const curated = curatedRaw instanceof Set ? curatedRaw : new Set([...curatedRaw].map(String));
  /** @type {string[]} */
  const kids = [];
  const seen = new Set();
  /** @param {unknown} kid */
  const add = (kid) => {
    const k = String(kid ?? "").trim();
    if (!k || curated.has(k) || seen.has(k)) return;
    seen.add(k);
    kids.push(k);
  };
  for (const cid of sidebarChannelIds ?? []) {
    add(resolveKolvipChannelIdForShow(cid));
  }
  const policies = opts.policies ?? loadKolvipBitgetAutotrade().policies ?? [];
  for (const p of policies) {
    add(p.kolvipChannelId);
    for (const id of p.channelIds ?? []) add(resolveKolvipChannelIdForShow(id));
  }
  return kids;
}

/**
 * @param {string} messageId
 * @param {string} [kolvipChannelId]
 */
export function kolvipBeforeIdFromMessageId(messageId, kolvipChannelId) {
  const mid = String(messageId ?? "").trim();
  if (!mid.startsWith("kolvip-")) return 0;
  const kid = String(kolvipChannelId ?? "").trim();
  if (kid) {
    const prefix = `kolvip-${kid}-`;
    if (mid.startsWith(prefix)) {
      const n = Number(mid.slice(prefix.length));
      return Number.isFinite(n) && n > 0 ? n : 0;
    }
  }
  const m = mid.match(/^kolvip-\d+-(\d+)$/);
  if (!m) return 0;
  const n = Number(m[1]);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/**
 * @param {{
 *   kolvipChannelId: string,
 *   store: ReturnType<typeof import("./store.js").openStore>,
 *   signalCards: NonNullable<Parameters<typeof ingestKolvipMessageBatch>[0]["signalCards"]>,
 *   log: ReturnType<typeof import("./logger.js").createLogger>,
 *   broadcast?: (channel: string, payload: Record<string, unknown>) => void,
 *   limit?: number,
 *   beforeId?: number,
 *   seen?: Record<string, unknown>,
 * }} opts
 */
export async function catchupKolvipChannelMessages(opts) {
  const kid = String(opts.kolvipChannelId ?? "").trim();
  if (!kid) return { ok: false, error: "missing kolvipChannelId" };
  const limit = Math.min(150, Math.max(5, Number(opts.limit) || 40));
  const beforeId = Math.max(0, Number(opts.beforeId) || 0);

  const { client } = await buildKolvipApiClient(opts.log);
  const raw = await kolvipApiFetchChannelMessages(client, kid, { beforeId, limit });
  const messages = raw
    .map((r) => kolvipApiRawToDomMessage(/** @type {Record<string, unknown>} */ (r)))
    .filter((m) => m.dataId);
  await cacheKolvipMessageAuthorAvatars(messages, opts.log);

  const seen = opts.seen ?? (await loadKolvipSeen(fs, SEEN_PATH));
  const mapping = getKolvipMappingByKolvipId(kid);
  const discordChannelId = mapping
    ? mapping.discordChannelId
    : kolvipScanVirtualChannelId(kid);

  const result = await ingestKolvipMessageBatch({
    kolvipChannelId: kid,
    channelName: mapping?.logicName ?? kid,
    messages,
    mode: beforeId > 0 ? "backfill" : "live",
    curated: Boolean(mapping),
    seen,
    signalCards: opts.signalCards,
    store: opts.store,
    log: opts.log,
    broadcast: opts.broadcast,
  });
  await saveKolvipSeen(fs, SEEN_PATH, seen);

  if (beforeId === 0 && messages.length) {
    await markKolvipShowCatchupWarmed(opts.store, discordChannelId, messages, {
      kolvipChannelId: kid,
      source: mapping ? "kolvip_api" : "kolvip_api_scan",
    });
  }

  let nextBeforeId = 0;
  let oldestAtMs = 0;
  for (const m of messages) {
    const n = Number(m.dataId);
    if (Number.isFinite(n) && n > 0 && (!nextBeforeId || n < nextBeforeId)) {
      nextBeforeId = n;
    }
    const t = parseKolvipMessageTimeMs(m.timeText, m.timeTitle);
    if (Number.isFinite(t) && t > 0 && (!oldestAtMs || t < oldestAtMs)) oldestAtMs = t;
  }

  return {
    ok: true,
    kolvipChannelId: kid,
    discordChannelId,
    fetched: messages.length,
    beforeId,
    nextBeforeId,
    oldestAtMs: oldestAtMs || null,
    ...result,
  };
}