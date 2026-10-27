/**
 * Discord CDN 头像 / 服务器图标 URL。
 */

/** @param {string} userId @param {string | null | undefined} avatarHash @param {number} [size] */
export function resolveUserAvatarUrl(userId, avatarHash, size = 80) {
  const uid = String(userId ?? "").trim();
  if (!uid) return "";
  const hash = String(avatarHash ?? "").trim();
  if (hash) {
    const ext = hash.startsWith("a_") ? "gif" : "webp";
    return `https://cdn.discordapp.com/avatars/${uid}/${hash}.${ext}?size=${size}`;
  }
  try {
    const idx = Number((BigInt(uid) >> 22n) % 6n);
    return `https://cdn.discordapp.com/embed/avatars/${idx}.png`;
  } catch {
    return `https://cdn.discordapp.com/embed/avatars/0.png`;
  }
}

/** @param {string} guildId @param {string | null | undefined} iconHash @param {number} [size] */
export function resolveGuildIconUrl(guildId, iconHash, size = 64) {
  const gid = String(guildId ?? "").trim();
  const hash = String(iconHash ?? "").trim();
  if (!gid || !hash) return "";
  const ext = hash.startsWith("a_") ? "gif" : "webp";
  return `https://cdn.discordapp.com/icons/${gid}/${hash}.${ext}?size=${size}`;
}

/** @param {unknown} author */
export function avatarFromAuthor(author) {
  if (author == null || typeof author !== "object" || Array.isArray(author)) return "";
  const a = /** @type {Record<string, unknown>} */ (author);
  return resolveUserAvatarUrl(String(a.id ?? ""), a.avatar != null ? String(a.avatar) : null);
}
