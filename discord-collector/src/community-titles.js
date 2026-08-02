/**
 * 社区会员头衔（按积分升级）
 * @typedef {{ key: string, label: string, minPoints: number, color: string, desc: string }} CommunityTitle
 */

/** @type {CommunityTitle[]} */
export const COMMUNITY_TITLES = [
  {
    key: "sprout",
    label: "新芽",
    minPoints: 0,
    color: "#95a5a6",
    desc: "刚加入社区，从签到与互动开始成长",
  },
  {
    key: "pathfinder",
    label: "探路者",
    minPoints: 50,
    color: "#3498db",
    desc: "活跃互动，开始关注信号与行情",
  },
  {
    key: "hunter",
    label: "信号猎手",
    minPoints: 200,
    color: "#9b59b6",
    desc: "常驻广场，跟进卡片与 OI 节奏",
  },
  {
    key: "gold",
    label: "金标会员",
    minPoints: 500,
    color: "#f1c40f",
    desc: "社区中坚，打赏与讨论贡献突出",
  },
  {
    key: "elder",
    label: "社区元老",
    minPoints: 1500,
    color: "#e67e22",
    desc: "长期签到与互助，口碑与经验兼备",
  },
  {
    key: "legend",
    label: "殿堂传说",
    minPoints: 5000,
    color: "#e74c3c",
    desc: "顶尖贡献者，社区名片级存在",
  },
];

/** 每日签到基础分；连续签到每日额外 +streak（上限 7） */
export const CHECKIN_BASE_POINTS = 10;
export const CHECKIN_STREAK_BONUS_CAP = 7;
/** 新注册赠送打赏币 */
export const WELCOME_TIP_BALANCE = 100;
/** 发帖 / 评论加分 */
export const POST_POINTS = 5;
export const COMMENT_POINTS = 2;
export const LIKE_POINTS = 1;

/**
 * @param {number} points
 * @returns {CommunityTitle}
 */
export function titleForPoints(points) {
  const p = Number(points) || 0;
  let cur = COMMUNITY_TITLES[0];
  for (const t of COMMUNITY_TITLES) {
    if (p >= t.minPoints) cur = t;
  }
  return cur;
}

/**
 * @param {number} points
 * @returns {{ current: CommunityTitle, next: CommunityTitle | null, progressPct: number }}
 */
export function titleProgress(points) {
  const current = titleForPoints(points);
  const idx = COMMUNITY_TITLES.findIndex((t) => t.key === current.key);
  const next = idx >= 0 && idx < COMMUNITY_TITLES.length - 1 ? COMMUNITY_TITLES[idx + 1] : null;
  if (!next) return { current, next: null, progressPct: 100 };
  const span = next.minPoints - current.minPoints;
  const done = Math.max(0, (Number(points) || 0) - current.minPoints);
  const progressPct = span > 0 ? Math.min(100, Math.round((done / span) * 100)) : 100;
  return { current, next, progressPct };
}

/**
 * @param {number} streakBefore 签到前已有连续天数（昨天签过则为当前 streak）
 */
export function checkinPointsForStreak(streakBefore) {
  const bonus = Math.min(CHECKIN_STREAK_BONUS_CAP, Math.max(0, Number(streakBefore) || 0));
  return CHECKIN_BASE_POINTS + bonus;
}
