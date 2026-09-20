import { useCallback, useEffect, useState } from "react";
import {
  emptyBinanceBoards,
  HEADER_FETCH_MS,
  type BinanceLeaderboardsPayload,
  type HeaderBoardItem,
} from "../utils/headerRankBoards";

export function useHeaderRankBoards() {
  const [boards, setBoards] = useState(emptyBinanceBoards());
  const [meta, setMeta] = useState<{
    sourceLabel: string;
    updatedAt: number | null;
    refreshSec: number;
    error: string | null;
    ok: boolean;
  }>({
    sourceLabel: "Binance U本位永续",
    updatedAt: null,
    refreshSec: HEADER_FETCH_MS / 1000,
    error: null,
    ok: false,
  });

  const applyPayload = useCallback((body: BinanceLeaderboardsPayload) => {
    const next = emptyBinanceBoards();
    const raw = body.boards;
    if (raw) {
      for (const key of Object.keys(next) as (keyof typeof next)[]) {
        const rows = raw[key];
        if (Array.isArray(rows)) next[key] = rows.filter((r) => r?.symbol);
      }
    }
    setBoards(next);
    setMeta({
      sourceLabel: String(body.source_label || "Binance U本位永续"),
      updatedAt: body.updated_at ? body.updated_at * 1000 : null,
      refreshSec: Number(body.refresh_sec) > 0 ? Number(body.refresh_sec) : HEADER_FETCH_MS / 1000,
      error: body.error ? String(body.error) : null,
      ok: body.ok !== false,
    });
  }, []);

  const fetchLeaderboards = useCallback(async () => {
    try {
      const res = await fetch("/api/binance/leaderboards", { cache: "no-store" });
      if (!res.ok) {
        const hint =
          res.status === 404
            ? "API 未就绪，请重启 OI（pnpm run oi:start 或 collect:ui）"
            : `HTTP ${res.status}`;
        setMeta((m) => ({ ...m, ok: false, error: hint }));
        return;
      }
      const body = (await res.json()) as BinanceLeaderboardsPayload;
      applyPayload(body);
    } catch (e) {
      setMeta((m) => ({
        ...m,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      }));
    }
  }, [applyPayload]);

  useEffect(() => {
    void fetchLeaderboards();
    const id = window.setInterval(() => void fetchLeaderboards(), HEADER_FETCH_MS);
    return () => window.clearInterval(id);
  }, [fetchLeaderboards]);

  const boardItems = useCallback(
    (id: keyof typeof boards): HeaderBoardItem[] => boards[id] ?? [],
    [boards],
  );

  const hasBoardData = Object.values(boards).some((rows) => rows.length > 0);

  return { boards, boardItems, meta, hasBoardData, refresh: fetchLeaderboards };
}
