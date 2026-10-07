/** 顶栏 mercu-header-focus 榜单类型（数据来自 /api/binance/leaderboards） */

export const HEADER_FETCH_MS = 15 * 60 * 1000;

export type HeaderBoardId =
  | "focus"
  | "dormant"
  | "gainers"
  | "losers"
  | "hot"
  | "volume"
  | "contract";

export const HEADER_BOARDS: { id: HeaderBoardId; label: string }[] = [
  { id: "focus", label: "特别关注" },
  { id: "dormant", label: "沉寂拉盘" },
  { id: "gainers", label: "涨幅榜" },
  { id: "losers", label: "跌幅榜" },
  { id: "hot", label: "热门" },
  { id: "volume", label: "成交榜" },
  { id: "contract", label: "合约榜" },
];

export type HeaderBoardItem = {
  symbol: string;
  rank?: number;
  score?: number;
  badge?: string;
  tone?: "up" | "down" | "neutral";
};

export type BinanceLeaderboardsPayload = {
  ok?: boolean;
  source?: string;
  source_label?: string;
  updated_at?: number;
  refresh_sec?: number;
  error?: string | null;
  boards?: Partial<Record<Exclude<HeaderBoardId, "focus" | "dormant">, HeaderBoardItem[]>>;
};

export type DormantFunnelPayload = {
  ok?: boolean;
  updated_at?: number | null;
  slow_scan_at?: number | null;
  fast_scan_at?: number | null;
  board?: HeaderBoardItem[];
  candidates?: HeaderBoardItem[];
  ignitions?: HeaderBoardItem[];
};

export function dormantFunnelToItems(payload: DormantFunnelPayload | null | undefined): HeaderBoardItem[] {
  const rows = payload?.board ?? payload?.candidates ?? [];
  if (!Array.isArray(rows)) return [];
  return rows
    .filter((r) => r?.symbol)
    .map((r, i) => ({
      symbol: String(r.symbol),
      rank: r.rank ?? r.score ?? i + 1,
      badge: r.badge,
      tone: (r.tone as HeaderBoardItem["tone"]) ?? (String(r.badge || "").includes("点火") ? "up" : "neutral"),
    }));
}

export type FocusEntryMeta = {
  badge?: string;
  expiresAt?: number;
  source?: string;
};

export function focusSymbolsToItems(
  symbols: string[],
  entries?: Record<string, FocusEntryMeta>,
): HeaderBoardItem[] {
  return symbols.map((symbol) => {
    const meta = entries?.[symbol];
    const badge = meta?.badge?.trim();
    return {
      symbol,
      tone: badge?.includes("爆发") ? ("up" as const) : ("neutral" as const),
      badge: badge || undefined,
    };
  });
}

export function emptyBinanceBoards(): Record<
  Exclude<HeaderBoardId, "focus">,
  HeaderBoardItem[]
> {
  return {
    gainers: [],
    losers: [],
    hot: [],
    volume: [],
    contract: [],
  };
}
