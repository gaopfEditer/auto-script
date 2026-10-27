import { useCallback, useEffect, useState } from "react";
import { displaySymbol } from "../utils/symbol";
import type { FocusEntryMeta } from "../utils/headerRankBoards";

const LS_KEY = "oi_special_focus_symbols_v1";
const LS_ENTRIES_KEY = "oi_special_focus_entries_v1";
const DEFAULT_FOCUS = ["BTCUSDT", "ETHUSDT"];

function normalizeSymbol(raw: string): string {
  let s = String(raw || "").trim().toUpperCase();
  if (!s) return "";
  if (s.endsWith("USD") && !s.endsWith("USDT") && !s.endsWith("USDC")) s = `${s}T`;
  if (!/(USDT|USDC|BUSD)$/.test(s) && /^[A-Z0-9]+$/.test(s)) s = `${s}USDT`;
  return s;
}

function readLocal(): string[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [...DEFAULT_FOCUS];
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [...DEFAULT_FOCUS];
    const out: string[] = [];
    for (const x of parsed) {
      const n = normalizeSymbol(String(x));
      if (n && !out.includes(n)) out.push(n);
    }
    return out.length ? out : [...DEFAULT_FOCUS];
  } catch {
    return [...DEFAULT_FOCUS];
  }
}

function readLocalEntries(): Record<string, FocusEntryMeta> {
  try {
    const raw = localStorage.getItem(LS_ENTRIES_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as unknown;
    if (!parsed || typeof parsed !== "object") return {};
    return parsed as Record<string, FocusEntryMeta>;
  } catch {
    return {};
  }
}

function writeLocal(symbols: string[], entries: Record<string, FocusEntryMeta>) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(symbols));
    localStorage.setItem(LS_ENTRIES_KEY, JSON.stringify(entries));
  } catch {
    /* ignore */
  }
}

export function useSpecialFocus() {
  const [symbols, setSymbols] = useState<string[]>(() => readLocal());
  const [entries, setEntries] = useState<Record<string, FocusEntryMeta>>(() => readLocalEntries());
  const [ready, setReady] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const pull = async () => {
      try {
        const res = await fetch("/api/focus-symbols", { cache: "no-store" });
        const data = (await res.json()) as {
          ok?: boolean;
          symbols?: string[];
          entries?: Record<string, FocusEntryMeta>;
        };
        if (!cancelled && data.ok && Array.isArray(data.symbols)) {
          const next = data.symbols.map(normalizeSymbol).filter(Boolean);
          const uniq = [...new Set(next)];
          const ent = data.entries && typeof data.entries === "object" ? data.entries : {};
          setSymbols(uniq.length ? uniq : [...DEFAULT_FOCUS]);
          setEntries(ent);
          writeLocal(uniq.length ? uniq : [...DEFAULT_FOCUS], ent);
        }
      } catch {
        /* 用 localStorage */
      } finally {
        if (!cancelled) setReady(true);
      }
    };
    void pull();
    const id = window.setInterval(pull, 5 * 60_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, []);

  const sync = useCallback(async (next: string[], ent = entries) => {
    const cleaned = [...new Set(next.map(normalizeSymbol).filter(Boolean))];
    setSymbols(cleaned);
    setEntries(ent);
    writeLocal(cleaned, ent);
    try {
      await fetch("/api/focus-symbols", {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbols: cleaned }),
      });
    } catch {
      /* 本地已更新 */
    }
    return cleaned;
  }, [entries]);

  const add = useCallback(
    async (symbol: string) => {
      const n = normalizeSymbol(symbol);
      if (!n) return symbols;
      if (symbols.includes(n)) return symbols;
      return sync([...symbols, n]);
    },
    [symbols, sync],
  );

  const remove = useCallback(
    async (symbol: string) => {
      const n = normalizeSymbol(symbol);
      const nextEnt = { ...entries };
      delete nextEnt[n];
      return sync(
        symbols.filter((s) => s !== n),
        nextEnt,
      );
    },
    [symbols, entries, sync],
  );

  const toggle = useCallback(
    async (symbol: string) => {
      const n = normalizeSymbol(symbol);
      if (!n) return symbols;
      if (symbols.includes(n)) return remove(n);
      return add(n);
    },
    [symbols, add, remove],
  );

  const has = useCallback(
    (symbol: string) => symbols.includes(normalizeSymbol(symbol)),
    [symbols],
  );

  const label = useCallback((symbol: string) => displaySymbol(symbol), []);

  return { symbols, entries, ready, add, remove, toggle, has, label, sync };
}
