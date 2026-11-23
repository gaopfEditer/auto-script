/**
 * 巨鲸频道/博主头像：下载到 public/kolvip-avatars，Show 走本站 URL。
 */
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { getKolvipMappingByKolvipId, resolveKolvipAssetUrl } from "./kolvip-cdp-config.js";
import { kolvipScanVirtualChannelId } from "./kolvip-scan-config.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const KOLVIP_AVATAR_PUBLIC_DIR = path.join(__dirname, "..", "public", "kolvip-avatars");
/** 0 = 永久：本地文件存在则不再拉源站；>0 时可设 KOLVIP_AVATAR_REVALIDATE_MS 定期刷新 */
const AVATAR_REVALIDATE_MS = Math.max(
  0,
  Number(process.env.KOLVIP_AVATAR_REVALIDATE_MS ?? 0) || 0
);

/**
 * @param {string} url
 */
function extFromUrl(url) {
  const p = String(url).split("?")[0].toLowerCase();
  const m = p.match(/\.(jpe?g|png|gif|webp|bmp)$/);
  return m ? m[0] : ".jpg";
}

/**
 * @param {string} kind
 * @param {string} id
 * @param {string} ext
 */
function cacheFileName(kind, id, ext) {
  const safe = String(id).replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 96);
  return `${kind}-${safe}${ext}`;
}

/**
 * @param {string} kind
 * @param {string} id
 * @param {string} [extHint]
 */
/**
 * 前端 / API：本站缓存路径与误拼的 kolvip.vip/kolvip-avatars/* → /kolvip-avatars/*
 * @param {unknown} url
 */
export function normalizeKolvipAvatarClientUrl(url) {
  const u = String(url ?? "").trim();
  if (!u) return "";
  if (/^\/kolvip-avatars\//i.test(u)) return u.split("?")[0];
  try {
    if (/^https?:\/\//i.test(u)) {
      const path = new URL(u).pathname;
      const idx = path.indexOf("/kolvip-avatars/");
      if (idx >= 0) return path.slice(idx);
    }
  } catch {
    /* ignore */
  }
  const idx = u.indexOf("/kolvip-avatars/");
  if (idx >= 0) return u.slice(idx).split("?")[0];
  return u;
}

export function kolvipAvatarPublicUrlForFile(kind, id, extHint = ".png") {
  const name = cacheFileName(kind, id, extFromUrl(extHint) || extHint);
  return `/kolvip-avatars/${encodeURIComponent(name)}`;
}

/**
 * @param {string} kind
 * @param {string} id
 */
export async function findLocalKolvipAvatarUrl(kind, id) {
  const exts = [".png", ".jpg", ".jpeg", ".webp", ".gif", ".bmp"];
  for (const ext of exts) {
    const name = cacheFileName(kind, id, ext);
    const filePath = path.join(KOLVIP_AVATAR_PUBLIC_DIR, name);
    try {
      const st = await fs.stat(filePath);
      if (st.isFile() && st.size > 0) {
        return `/kolvip-avatars/${encodeURIComponent(name)}`;
      }
    } catch {
      /* try next ext */
    }
  }
  return "";
}

/**
 * @param {string} remoteAbsUrl
 * @param {{ kind: string, id: string, log?: { warn?: (m: string) => void }, force?: boolean }} opts
 */
export async function ensureKolvipAvatarCached(remoteAbsUrl, opts) {
  const url = String(remoteAbsUrl ?? "").trim();
  if (!url) {
    return findLocalKolvipAvatarUrl(opts.kind, opts.id);
  }
  if (/^\/kolvip-avatars\//i.test(url)) {
    const bare = decodeURIComponent(url.replace(/^\/kolvip-avatars\//i, "").split("?")[0]);
    const filePath = path.join(KOLVIP_AVATAR_PUBLIC_DIR, path.basename(bare));
    try {
      const st = await fs.stat(filePath);
      if (st.isFile() && st.size > 0) return url.split("?")[0];
    } catch {
      /* fall through */
    }
  }
  await fs.mkdir(KOLVIP_AVATAR_PUBLIC_DIR, { recursive: true });
  const ext = extFromUrl(url);
  const name = cacheFileName(opts.kind, opts.id, ext);
  const filePath = path.join(KOLVIP_AVATAR_PUBLIC_DIR, name);
  const publicUrl = `/kolvip-avatars/${encodeURIComponent(name)}`;
  try {
    if (!opts.force) {
      const st = await fs.stat(filePath);
      if (st.isFile() && st.size > 0) {
        if (!AVATAR_REVALIDATE_MS || Date.now() - st.mtimeMs < AVATAR_REVALIDATE_MS) {
          return publicUrl;
        }
      }
    }
  } catch {
    /* miss */
  }
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(25_000) });
    if (!res.ok) return url;
    const buf = Buffer.from(await res.arrayBuffer());
    if (!buf.length) return url;
    await fs.writeFile(filePath, buf);
    return publicUrl;
  } catch (e) {
    opts.log?.warn?.(`kolvip 头像缓存失败 ${opts.kind}/${opts.id}: ${/** @type {Error} */ (e).message}`);
    return url;
  }
}

/**
 * @param {string} remoteAbsUrl
 */
export function kolvipAvatarCacheIdFromUrl(remoteAbsUrl) {
  const url = String(remoteAbsUrl ?? "").trim();
  if (!url) return "";
  return crypto.createHash("sha1").update(url).digest("hex").slice(0, 20);
}

/**
 * @param {import('./kolvip-api-catalog.js').KolvipCatalogChannel[]} channels
 * @param {ReturnType<typeof import('./store.js').openStore>} store
 * @param {ReturnType<typeof import('./logger.js').createLogger> | null} [log]
 */
export async function persistKolvipChannelAvatars(channels, store, log = null) {
  if (!Array.isArray(channels) || !channels.length) return { updated: 0 };
  if (typeof store?.upsertDiscordChannelIcons !== "function") return { updated: 0 };
  /** @type {Array<{ channelId: string, iconUrl: string }>} */
  const rows = [];
  for (const c of channels) {
    const kid = String(c.kolvipChannelId ?? "").trim();
    if (!kid) continue;
    const remote = String(c.avatarUrl ?? c.avatar ?? "").trim();
    let iconUrl = await findLocalKolvipAvatarUrl("ch", kid);
    if (!iconUrl && remote) {
      const abs = resolveKolvipAssetUrl(remote) || remote;
      iconUrl = await ensureKolvipAvatarCached(abs, { kind: "ch", id: kid, log: log ?? undefined });
    }
    if (!iconUrl) continue;
    c.avatarUrl = iconUrl;
    const mapping = getKolvipMappingByKolvipId(kid);
    const ids = new Set([kolvipScanVirtualChannelId(kid)]);
    if (mapping?.discordChannelId) ids.add(String(mapping.discordChannelId));
    for (const channelId of ids) {
      if (channelId) rows.push({ channelId, iconUrl });
    }
  }
  const updated = await store.upsertDiscordChannelIcons(rows);
  return { updated, rows: rows.length };
}

/**
 * @param {import('./kolvip-cdp-message.js').KolvipDomMessage[]} messages
 * @param {ReturnType<typeof import('./logger.js').createLogger> | null} [log]
 */
export async function cacheKolvipMessageAuthorAvatars(messages, log = null) {
  if (!Array.isArray(messages)) return;
  /** @type {Map<string, string>} */
  const byRemote = new Map();
  for (const msg of messages) {
    const remote = String(msg.authorAvatar ?? "").trim();
    if (!remote) continue;
    const cacheKey = remote.startsWith("/kolvip-avatars/")
      ? remote
      : resolveKolvipAssetUrl(remote) || remote;
    let cached = byRemote.get(cacheKey);
    if (!cached) {
      const id = kolvipAvatarCacheIdFromUrl(
        cacheKey.startsWith("/kolvip-avatars/") ? cacheKey : resolveKolvipAssetUrl(remote) || remote
      );
      cached =
        (await findLocalKolvipAvatarUrl("u", id)) ||
        (await ensureKolvipAvatarCached(
          cacheKey.startsWith("http") ? cacheKey : resolveKolvipAssetUrl(remote) || remote,
          {
            kind: "u",
            id,
            log: log ?? undefined,
          }
        ));
      byRemote.set(cacheKey, cached);
    }
    msg.authorAvatar = cached;
  }
}

/**
 * 读 catalog / 接口时：若磁盘已有头像则一律用本站路径（永久缓存）。
 * @param {import('./kolvip-api-catalog.js').KolvipCatalogChannel[]} channels
 */
export async function hydrateKolvipCatalogAvatarsFromDisk(channels) {
  if (!Array.isArray(channels)) return;
  for (const c of channels) {
    const kid = String(c.kolvipChannelId ?? "").trim();
    if (!kid) continue;
    const local = await findLocalKolvipAvatarUrl("ch", kid);
    if (local) {
      c.avatarUrl = local;
      continue;
    }
    const raw = String(c.avatar ?? "").trim();
    if (raw && !c.avatarUrl) c.avatarUrl = resolveKolvipAssetUrl(raw);
  }
}