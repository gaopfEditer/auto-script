import type { SeriesMarker, UTCTimestamp } from "lightweight-charts";

/** MACD 金叉/死叉小圆点（画在 DIF 线上） */
export function buildMacdCrossMarkers(
  line: { time: number; value: number }[],
  signal: { time: number; value: number }[],
): SeriesMarker<UTCTimestamp>[] {
  const sigByTime = new Map(signal.map((p) => [p.time, p.value]));
  const markers: SeriesMarker<UTCTimestamp>[] = [];
  let prevDiff: number | null = null;

  for (const p of line) {
    const sig = sigByTime.get(p.time);
    if (sig == null || !Number.isFinite(p.value) || !Number.isFinite(sig)) {
      prevDiff = null;
      continue;
    }
    const diff = p.value - sig;
    if (prevDiff != null) {
      if (prevDiff <= 0 && diff > 0) {
        markers.push({
          time: p.time as UTCTimestamp,
          position: "inBar",
          shape: "circle",
          color: "#00e676",
          size: 0.6,
        });
      } else if (prevDiff >= 0 && diff < 0) {
        markers.push({
          time: p.time as UTCTimestamp,
          position: "inBar",
          shape: "circle",
          color: "#ff5252",
          size: 0.6,
        });
      }
    }
    prevDiff = diff;
  }
  return markers;
}
