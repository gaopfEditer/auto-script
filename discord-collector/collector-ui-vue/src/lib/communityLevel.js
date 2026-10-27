/**
 * 社区 QQ 式等级图标（与后端 community-titles.js 对齐）
 * 4星=1月，4月=1日，4日=1冠
 */

/** @param {number} level */
export function levelBadgesFromLevel(level) {
  let rem = Math.max(1, Math.floor(Number(level) || 1));
  const crowns = Math.floor(rem / 64);
  rem %= 64;
  const suns = Math.floor(rem / 16);
  rem %= 16;
  const moons = Math.floor(rem / 4);
  rem %= 4;
  const stars = rem;
  return {
    level: Math.max(1, Math.floor(Number(level) || 1)),
    crowns,
    suns,
    moons,
    stars,
  };
}

/**
 * 文案：「1冠2日」/「1月」/「3星」
 * @param {{ crowns?: number, suns?: number, moons?: number, stars?: number }} b
 */
export function badgesCountLabel(b) {
  if (!b) return "";
  /** @type {string[]} */
  const parts = [];
  const c = Number(b.crowns) || 0;
  const s = Number(b.suns) || 0;
  const m = Number(b.moons) || 0;
  const st = Number(b.stars) || 0;
  if (c) parts.push(`${c}冠`);
  if (s) parts.push(`${s}日`);
  if (m) parts.push(`${m}月`);
  if (st) parts.push(`${st}星`);
  if (!parts.length) parts.push("1星");
  return parts.join("");
}
