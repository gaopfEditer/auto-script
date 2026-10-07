/** 市值梯队（与 oi_mornitor/mcap_tier.py、symbol_mcap_tiers.json 同源） */

export type McapTierId = "t1" | "t2" | "t3";

export type McapTierMeta = {
  id: McapTierId;
  label: string;
  mcapNote?: string;
  strategyHint?: string;
};

export const MCAP_TIER_CATALOG: McapTierMeta[] = [
  {
    id: "t1",
    label: "第一梯队",
    mcapNote: "万亿 / 数千亿美元 · 大盘基准（BTC、ETH）",
    strategyHint:
      "机构博弈 · 重宏观与结构：假突破/Spring、流动性掠夺；4H/日线趋势；少追箱体突破；杠杆宜 2~5x。",
  },
  {
    id: "t2",
    label: "第二梯队",
    mcapNote: "约 5000 亿 ~ 10000 亿美元 · 主流公链 / 平台币",
    strategyHint:
      "主升浪先锋 · 重动量与 RS：BTC 横盘时逆势强币；15m/1h EMA 回踩；OI+突破轧空；杠杆宜 2~3x。",
  },
  {
    id: "t3",
    label: "第三梯队",
    mcapNote: "百亿 ~ 数百亿及更小 · 含细分龙头与其余山寨（默认）",
    strategyHint:
      "控盘 / 叙事 · 右侧突破快进快出、移动止损；高位射击之星果断离场；仓位 3~5%、杠杆 1~2x。",
  },
];

const BY_ID = new Map(MCAP_TIER_CATALOG.map((x) => [x.id, x]));

export function mcapTierMeta(id?: string | null): McapTierMeta | undefined {
  const k = String(id || "").toLowerCase() as McapTierId;
  return BY_ID.get(k);
}

export function formatMcapTierBadge(id?: string | null): string {
  const m = mcapTierMeta(id);
  if (!m) return "—";
  return m.id.toUpperCase();
}

export function mcapTierTitle(id?: string | null): string {
  const m = mcapTierMeta(id);
  if (!m) return "";
  return [m.label, m.mcapNote, m.strategyHint].filter(Boolean).join("\n");
}

export type McapTierOption = {
  id: string;
  label: string;
  count: number;
  wins: number;
  losses: number;
  winRate: number | null;
  totalPnlPct?: number | null;
};

/** 形态图 meta：优先 live 市值，否则用梯队档描述前半段 */
export function formatChartMcapDisplay(
  tier?: { marketCapUsd?: number | null; mcapNote?: string | null } | null,
): string {
  const cap = tier?.marketCapUsd;
  if (cap != null && Number.isFinite(cap) && cap > 0) {
    const abs = Math.abs(cap);
    if (abs >= 1e12) return `$${(abs / 1e12).toFixed(2)}T`;
    if (abs >= 1e9) return `$${(abs / 1e9).toFixed(2)}B`;
    if (abs >= 1e6) return `$${(abs / 1e6).toFixed(1)}M`;
    return `$${Math.round(abs)}`;
  }
  const note = String(tier?.mcapNote || "").trim();
  if (!note) return "—";
  const head = note.split("·")[0]?.trim();
  return head || note;
}

export function formatMcapTierOptionLabel(o: McapTierOption): string {
  const wr =
    o.winRate == null || o.count < 1 ? "—" : `${(o.winRate * 100).toFixed(1)}%`;
  const pnl =
    o.totalPnlPct == null || !Number.isFinite(o.totalPnlPct)
      ? ""
      : ` · ${o.totalPnlPct >= 0 ? "+" : ""}${o.totalPnlPct.toFixed(1)}%`;
  return `${o.label} · ${o.count}笔 · 胜率 ${wr}${pnl}`;
}
