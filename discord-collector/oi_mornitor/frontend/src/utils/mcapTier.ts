/** 市值梯队（与 oi_mornitor/mcap_tier.py、symbol_mcap_tiers.json 同源） */

export type McapTierId = string;

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
    mcapNote: "市值大于 500 亿美元（按 CoinGecko 美元市值实时划分）",
    strategyHint:
      "机构博弈 · 重宏观与结构：假突破/Spring、流动性掠夺；4H/日线趋势；少追箱体突破；杠杆宜 2~5x。",
  },
  {
    id: "t2",
    label: "第二梯队",
    mcapNote: "市值大于 80 亿美元、不超过 500 亿美元",
    strategyHint:
      "主升浪先锋 · 重动量与 RS：BTC 横盘时逆势强币；15m/1h EMA 回踩；OI+突破轧空；杠杆宜 2~3x。",
  },
  {
    id: "t3",
    label: "第三梯队",
    mcapNote: "市值 80 亿美元及以下，或暂无市值数据 / 稳定币等排除项",
    strategyHint:
      "控盘 / 叙事 · 右侧突破快进快出、移动止损；高位射击之星果断离场；仓位 3~5%、杠杆 1~2x。",
  },
  {
    id: "eq-t1",
    label: "美股个股·第一梯队",
    mcapNote: "公司市值大于 500 亿美元（不使用代币流通市值）",
  },
  {
    id: "eq-t2",
    label: "美股个股·第二梯队",
    mcapNote: "公司市值大于 80 亿美元、不超过 500 亿美元",
  },
  {
    id: "eq-t3",
    label: "美股个股·第三梯队",
    mcapNote: "公司市值 80 亿美元及以下，或暂无公司市值",
  },
  {
    id: "eq-index",
    label: "美股集合·指数",
    mcapNote: "QQQ / SPY / IWM，不套市值门槛",
  },
  {
    id: "eq-lev",
    label: "美股集合·杠杆",
    mcapNote: "SOXL / SOXS，不套市值门槛",
  },
  {
    id: "eq-macro",
    label: "美股集合·宏观",
    mcapNote: "XAU / TLT（含 PAXG），不套市值门槛",
  },
  {
    id: "eq-other",
    label: "美股其他",
    mcapNote: "白名单内加密映射等，暂不按主要科技股市值归档",
  },
];

const BY_ID = new Map(MCAP_TIER_CATALOG.map((x) => [x.id, x]));

export function mcapTierMeta(id?: string | null): McapTierMeta | undefined {
  const k = String(id || "").toLowerCase() as McapTierId;
  return BY_ID.get(k);
}

export function formatMcapTierBadge(id?: string | null): string {
  const m = mcapTierMeta(id);
  const raw = String(id || "").toLowerCase();
  const badges: Record<string, string> = {
    t1: "T1",
    t2: "T2",
    t3: "T3",
    "eq-t1": "美T1",
    "eq-t2": "美T2",
    "eq-t3": "美T3",
    "eq-index": "指数",
    "eq-lev": "杠杆",
    "eq-macro": "宏观",
    "eq-other": "美股其他",
  };
  if (badges[raw]) return badges[raw];
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
    o.winRate == null ? "胜率 —" : `胜率 ${(o.winRate * 100).toFixed(0)}%`;
  const pnl =
    o.totalPnlPct == null || !Number.isFinite(o.totalPnlPct)
      ? "合计 —"
      : `合计 ${o.totalPnlPct > 0 ? "+" : ""}${o.totalPnlPct.toFixed(1)}%`;
  const n = o.count > 0 ? ` (${o.count})` : "";
  return `${o.label}${n} · ${wr} · ${pnl}`;
}
