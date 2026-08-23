/**
 * 卡片网格周分割线标签：本周 / 8月第二周
 */

/** @param {Date} date */
export function startOfWeekMonday(date) {
  const d = new Date(date);
  if (Number.isNaN(d.getTime())) return new Date(0);
  const day = d.getDay();
  const diff = day === 0 ? -6 : 1 - day;
  d.setDate(d.getDate() + diff);
  d.setHours(0, 0, 0, 0);
  return d;
}

/** @param {Date} weekStart */
export function weekKeyFromStart(weekStart) {
  const y = weekStart.getFullYear();
  const m = String(weekStart.getMonth() + 1).padStart(2, "0");
  const day = String(weekStart.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

/** @param {number} n */
function chineseWeekOrdinal(n) {
  const ordinals = ["", "一", "二", "三", "四", "五", "六"];
  if (n >= 1 && n < ordinals.length) return `第${ordinals[n]}周`;
  return `第${n}周`;
}

/**
 * @param {Date} weekStart 该周周一 00:00
 * @param {Date} [now]
 */
export function formatWeekDividerLabel(weekStart, now = new Date()) {
  const thisWeek = startOfWeekMonday(now);
  if (weekStart.getTime() === thisWeek.getTime()) return "本周";

  const month = weekStart.getMonth() + 1;
  const weekInMonth = Math.ceil(weekStart.getDate() / 7);
  return `${month}月${chineseWeekOrdinal(weekInMonth)}`;
}

/**
 * 将已按时间倒序排列的卡片切成周分组（保持新→旧）。
 * @param {Array<{ signalAt?: string | null, createdAt?: string | null }>} cards
 */
export function groupCardsByWeek(cards) {
  /** @type {Array<{ weekKey: string, label: string, cards: typeof cards }>} */
  const groups = [];
  let currentKey = "";

  for (const card of cards) {
    const raw = card.signalAt || card.createdAt;
    const d = raw ? new Date(String(raw)) : new Date(0);
    const weekStart = startOfWeekMonday(d);
    const weekKey = weekKeyFromStart(weekStart);
    const label = formatWeekDividerLabel(weekStart);

    if (weekKey !== currentKey) {
      groups.push({ weekKey, label, cards: [card] });
      currentKey = weekKey;
    } else {
      groups[groups.length - 1].cards.push(card);
    }
  }

  return groups;
}
