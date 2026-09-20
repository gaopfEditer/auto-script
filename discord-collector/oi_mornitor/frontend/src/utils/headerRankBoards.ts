/** 顶栏 mercu-header-focus 榜单类型（数据来自 /api/binance/leaderboards） */

export const HEADER_FETCH_MS = 15 * 60 * 1000;

export type HeaderBoardId =
  | "focus"
  | "gainers"
  | "losers"
  | "hot"
  | "volume"
  | "contract";

export const HEADER_BOARDS: { id: HeaderBoardId; label: string }[] = [
  { id: "focus", label: "特别关注" },
  { id: "gainers", label: "涨幅榜" },
  { id: "losers", label: "跌幅榜" },
  { id: "hot", label: "热门" },
  { id: "volume", label: "成交榜" },
  { id: "contract", label: "合约榜" },
];

export type HeaderBoardItem = {
  symbol: string;
  rank?: number;
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
  boards?: Partial<Record<Exclude<HeaderBoardId, "focus">, HeaderBoardItem[]>>;
};

export function focusSymbolsToItems(symbols: string[]): HeaderBoardItem[] {
  return symbols.map((symbol) => ({ symbol, tone: "neutral" as const }));
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
