/**
 * 社区等级（仿 QQ：星 → 月 → 日 → 冠）+ 头衔档位
 *
 * 图标换算（与 QQ 一致）：
 *   4 星 = 1 月，4 月 = 1 日，4 日 = 1 冠
 *   → 1 月 = 4 级，1 日 = 16 级，1 冠 = 64 级
 *
 * 升级耗分：从 L → L+1 需 `12 + (L-1)*6` 分
 *   约：签到一天 ~10–17 分 → 前期每天升半级～一级；中后期明显放缓。
 */

/**
 * @typedef {{ key: string, label: string, minLevel: number, minPoints: number, color: string, desc: string }} CommunityTitle
 * @typedef {{ level: number, crowns: number, suns: number, moons: number, stars: number }} LevelBadges
 */

/** @type {CommunityTitle[]} */
export const COMMUNITY_TITLES = [
  {
    key: "sprout",
    label: "新芽",
    minLevel: 1,
    minPoints: 0,
    color: "#95a5a6",
    desc: "★ 星级起步 · 刚加入，从签到与闲聊开始",
  },
  {
    key: "pathfinder",
    label: "探路者",
    minLevel: 4,
    minPoints: 54,
    color: "#3498db",
    desc: "☾ 月亮档 · 开始稳定活跃（约累计 1 周签到）",
  },
  {
    key: "hunter",
    label: "信号猎手",
    minLevel: 9,
    minPoints: 264,
    color: "#9b59b6",
    desc: "☾☾ 多月 · 常驻聊天与动态，跟进信号节奏",
  },
  {
    key: "gold",
    label: "金标会员",
    minLevel: 16,
    minPoints: 810,
    color: "#f1c40f",
    desc: "☀ 太阳档 · 社区中坚，打赏与讨论贡献突出",
  },
  {
    key: "elder",
    label: "社区元老",
    minLevel: 32,
    minPoints: 3162,
    color: "#e67e22",
    desc: "☀☀ 双日 · 长期签到与互助，口碑经验兼备",
  },
  {
    key: "legend",
    label: "殿堂传说",
    minLevel: 64,
    minPoints: 12474,
    color: "#e74c3c",
    desc: "👑 皇冠 · 顶尖贡献者，社区名片级存在",
  },
];

/** 每日签到基础分；连续签到每日额外 +streak（上限 7） */
export const CHECKIN_BASE_POINTS = 10;
export const CHECKIN_STREAK_BONUS_CAP = 7;
/** 新注册赠送打赏币 */
export const WELCOME_TIP_BALANCE = 100;
/** 发帖 / 评论 / 被赞加分 */
export const POST_POINTS = 5;
export const COMMENT_POINTS = 2;
export const LIKE_POINTS = 1;

/** 从等级 L 升到 L+1 所需积分 */
export function pointsCostToNextLevel(level) {
  const L = Math.max(1, Math.floor(Number(level) || 1));
  return 12 + (L - 1) * 6;
}

/** 达到某等级所需累计最低积分（level≥1） */
export function pointsRequiredForLevel(level) {
  const target = Math.max(1, Math.floor(Number(level) || 1));
  let sum = 0;
  for (let L = 1; L < target; L++) {
    sum += pointsCostToNextLevel(L);
  }
  return sum;
}

/**
 * 积分 → 等级（1 起）
 * @param {number} points
 */
export function levelFromPoints(points) {
  const p = Math.max(0, Number(points) || 0);
  let level = 1;
  let spent = 0;
  // 上限防止死循环；正常活跃很难到 200
  while (level < 200) {
    const cost = pointsCostToNextLevel(level);
    if (p < spent + cost) break;
    spent += cost;
    level += 1;
  }
  return level;
}

/**
 * QQ 式图标拆分
 * @param {number} level
 * @returns {LevelBadges}
 */
export function levelBadges(level) {
  let rem = Math.max(1, Math.floor(Number(level) || 1));
  const crowns = Math.floor(rem / 64);
  rem %= 64;
  const suns = Math.floor(rem / 16);
  rem %= 16;
  const moons = Math.floor(rem / 4);
  rem %= 4;
  const stars = rem;
  return { level: Math.max(1, Math.floor(Number(level) || 1)), crowns, suns, moons, stars };
}

/**
 * @param {number} points
 * @returns {CommunityTitle}
 */
export function titleForPoints(points) {
  const level = levelFromPoints(points);
  let cur = COMMUNITY_TITLES[0];
  for (const t of COMMUNITY_TITLES) {
    if (level >= t.minLevel) cur = t;
  }
  return cur;
}

/**
 * @param {number} points
 */
export function titleProgress(points) {
  const p = Math.max(0, Number(points) || 0);
  const level = levelFromPoints(p);
  const current = titleForPoints(p);
  const idx = COMMUNITY_TITLES.findIndex((t) => t.key === current.key);
  const nextTitle =
    idx >= 0 && idx < COMMUNITY_TITLES.length - 1 ? COMMUNITY_TITLES[idx + 1] : null;

  const spentToLevel = pointsRequiredForLevel(level);
  const costNext = pointsCostToNextLevel(level);
  const intoLevel = p - spentToLevel;
  const levelPct = costNext > 0 ? Math.min(100, Math.round((intoLevel / costNext) * 100)) : 100;

  let titlePct = 100;
  if (nextTitle) {
    const a = pointsRequiredForLevel(current.minLevel);
    const b = pointsRequiredForLevel(nextTitle.minLevel);
    const span = Math.max(1, b - a);
    titlePct = Math.min(100, Math.round(((p - a) / span) * 100));
  }

  return {
    current,
    next: nextTitle,
    progressPct: titlePct,
    level,
    badges: levelBadges(level),
    pointsToNextLevel: Math.max(0, costNext - intoLevel),
    levelProgressPct: levelPct,
    nextLevel: level + 1,
  };
}

/**
 * 头衔列表（带起步徽章，供 overview /titles API）
 */
export function titlesWithBadges() {
  return COMMUNITY_TITLES.map((t) => ({
    ...t,
    approxPoints: pointsRequiredForLevel(t.minLevel),
    badges: levelBadges(t.minLevel),
  }));
}

/** 供前端说明用的等级表摘要 */
export function levelSystemMeta() {
  return {
    rule: "4星=1月，4月=1日，4日=1冠（同 QQ）",
    costHint: "升到下一级：12+(当前等级-1)×6 分",
    titles: titlesWithBadges(),
  };
}

/**
 * @param {number} streakBefore 签到前已有连续天数（昨天签过则为当前 streak）
 */
export function checkinPointsForStreak(streakBefore) {
  const bonus = Math.min(CHECKIN_STREAK_BONUS_CAP, Math.max(0, Number(streakBefore) || 0));
  return CHECKIN_BASE_POINTS + bonus;
}
