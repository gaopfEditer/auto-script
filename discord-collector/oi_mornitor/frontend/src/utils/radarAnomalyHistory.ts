import type { OiAlertItem, OiAlertKind, OiAlertWindow } from "./deriveOiAlerts";
import type { RadarAnomalyHistory, RadarAnomalyRecord, TickerRow } from "../types";

const DEFAULT_RETENTION_MS = 4 * 60 * 60_000;

export function retentionMsFromHistory(h?: RadarAnomalyHistory | null): number {
  const sec = Number(h?.retention_sec);
  if (Number.isFinite(sec) && sec > 0) return sec * 1000;
  return DEFAULT_RETENTION_MS;
}

function rowFromRecord(rec: RadarAnomalyRecord): TickerRow {
  const base = (rec.row || {}) as TickerRow;
  return {
    ...base,
    symbol: rec.symbol || base.symbol || "",
  };
}

export function anomalyRecordToItem(rec: RadarAnomalyRecord): OiAlertItem | null {
  if (!rec?.id || !rec.symbol) return null;
  const kind = rec.kind as OiAlertKind;
  if (kind !== "oi" && kind !== "price" && kind !== "board") return null;
  const window = (rec.window === "15m" ? "15m" : "5m") as OiAlertWindow;
  const alertTs = Number(rec.alert_ts || rec.first_seen_ts || 0);
  if (!Number.isFinite(alertTs) || alertTs <= 0) return null;
  const tags = Array.isArray(rec.tags) ? rec.tags.filter(Boolean) : [];
  if (kind === "board" && rec.board_label) {
    tags.unshift(String(rec.board_label));
  }
  return {
    id: rec.id,
    row: rowFromRecord(rec),
    kind,
    window,
    deltaUsd: Number(rec.delta_usd) || 0,
    pct: Number(rec.pct) || 0,
    isPump: Boolean(rec.is_pump),
    isSuppressed: Boolean(rec.is_suppressed),
    alertTs,
    tags: [...new Set(tags)].slice(0, 4),
  };
}

export function historyRecordsToItems(h?: RadarAnomalyHistory | null): OiAlertItem[] {
  if (!h) return [];
  const raw = [...(h.oi_price || []), ...(h.board || [])];
  const items: OiAlertItem[] = [];
  for (const rec of raw) {
    const it = anomalyRecordToItem(rec);
    if (it) items.push(it);
  }
  return items;
}

/** 服务端历史 + 本地/本轮 live 合并（同 id 保留较早 alertTs） */
export function mergeAnomalyFeed(
  serverItems: OiAlertItem[],
  localItems: OiAlertItem[],
  retentionMs: number,
  maxItems = 120,
): OiAlertItem[] {
  const cutoffSec = (Date.now() - retentionMs) / 1000;
  const byId = new Map<string, OiAlertItem>();
  for (const it of [...serverItems, ...localItems]) {
    if ((it.alertTs || 0) < cutoffSec) continue;
    const prev = byId.get(it.id);
    if (!prev) {
      byId.set(it.id, it);
      continue;
    }
    const alertTs = Math.min(prev.alertTs || 0, it.alertTs || 0) || it.alertTs;
    byId.set(it.id, { ...prev, ...it, alertTs });
  }
  return [...byId.values()]
    .sort((a, b) => (b.alertTs || 0) - (a.alertTs || 0))
    .slice(0, maxItems);
}
