/**
 * Discord 信号频道 → 卡片作者（频道品牌名）。
 * 与 collector `discord-signal-config.js` DEFAULT_SIGNAL_CHANNELS 对齐。
 */
export const SIGNAL_CHANNEL_AUTHORS: Record<string, string> = {
  "1444963372134301827": "seven",
  "1444963929393729686": "峰哥",
  "1444963689194192947": "颜驰",
  "1444967547169669160": "币安杀手",
  "1459861535815110810": "unknown-trader",
  "1444963506431463474": "山寨之王",
  "1444963405185159238": "币圈所长",
};

const SNOWFLAKE_RE = /^\d{15,22}$/;

/** 从 "discord · 1444963506431463474" 之类文案里抽出频道 ID */
export function extractChannelIdFromLabel(label?: string | null): string {
  const s = String(label || "").trim();
  if (!s) return "";
  if (SNOWFLAKE_RE.test(s)) return s;
  const m = s.match(/(\d{15,22})/);
  return m?.[1] || "";
}

/**
 * 卡片作者显示名：优先已知频道映射，再退回 author_name / channel_name。
 */
export function resolveSandboxCardAuthor(o: {
  author_name?: string | null;
  channel_id?: string | null;
  channel_name?: string | null;
  source_label?: string | null;
  guild_name?: string | null;
}): string {
  const chId =
    String(o.channel_id || "").trim() ||
    extractChannelIdFromLabel(o.channel_name) ||
    extractChannelIdFromLabel(o.source_label);
  if (chId && SIGNAL_CHANNEL_AUTHORS[chId]) {
    return SIGNAL_CHANNEL_AUTHORS[chId];
  }

  const candidates = [o.author_name, o.channel_name, o.source_label];
  for (const raw of candidates) {
    const name = String(raw || "").trim();
    if (!name) continue;
    if (SNOWFLAKE_RE.test(name)) continue;
    if (/^discord$/i.test(name)) continue;
    // "discord · 山寨之王" / "discord · 1444…"
    const parts = name.split(/\s*[·|]\s*/).map((x) => x.trim()).filter(Boolean);
    if (parts.length >= 2) {
      const tail = parts[parts.length - 1];
      const mapped = SIGNAL_CHANNEL_AUTHORS[tail];
      if (mapped) return mapped;
      if (tail && !SNOWFLAKE_RE.test(tail) && !/^discord$/i.test(tail)) return tail;
    }
    if (!/^discord\b/i.test(name)) return name;
  }
  return "";
}
