import { useEffect, useRef, useState } from "react";
import type { ChartTimeframe } from "../utils/chartTimeframe";
import {
  binanceChartLiveWsUrl,
  parseBinanceChartLiveMessage,
  type LiveKlineUpdate,
} from "../utils/binanceWs";

const RETRY_MS = 3000;
const SILENT_REFRESH_FIRST_MS = 30_000;
const SILENT_REFRESH_EVERY_MS = 5 * 60_000;

export function useBinanceChartLive(
  symbol: string,
  interval: ChartTimeframe,
  enabled: boolean,
  onKline?: (update: LiveKlineUpdate) => void,
  /** 静默刷新：重拉近期 K 线等，非整页 reload */
  onStaleRefresh?: () => void,
) {
  const [markPrice, setMarkPrice] = useState<number | null>(null);
  const [connected, setConnected] = useState(false);
  const onKlineRef = useRef(onKline);
  onKlineRef.current = onKline;
  const onStaleRefreshRef = useRef(onStaleRefresh);
  onStaleRefreshRef.current = onStaleRefresh;

  const downSinceRef = useRef(0);
  const didFirstSilentRef = useRef(false);
  const streamKeyRef = useRef("");
  const [reconnectEpoch, setReconnectEpoch] = useState(0);

  useEffect(() => {
    if (!enabled || !symbol) {
      setConnected(false);
      setMarkPrice(null);
      downSinceRef.current = 0;
      didFirstSilentRef.current = false;
      streamKeyRef.current = "";
      return;
    }

    const streamKey = `${symbol}:${interval}`;
    if (streamKeyRef.current !== streamKey) {
      streamKeyRef.current = streamKey;
      downSinceRef.current = 0;
      didFirstSilentRef.current = false;
    }

    let ws: WebSocket | null = null;
    let retryTimer: ReturnType<typeof setTimeout> | null = null;
    let watchTimer: ReturnType<typeof setTimeout> | null = null;
    let cancelled = false;
    let connectedNow = false;

    if (!downSinceRef.current) downSinceRef.current = Date.now();

    const clearWatch = () => {
      if (watchTimer) {
        clearTimeout(watchTimer);
        watchTimer = null;
      }
    };

    const armWatch = () => {
      clearWatch();
      if (cancelled || connectedNow) return;
      if (!downSinceRef.current) downSinceRef.current = Date.now();
      const elapsed = Date.now() - downSinceRef.current;
      const delay = !didFirstSilentRef.current
        ? Math.max(200, SILENT_REFRESH_FIRST_MS - elapsed)
        : SILENT_REFRESH_EVERY_MS;
      watchTimer = setTimeout(() => {
        watchTimer = null;
        if (cancelled || connectedNow) return;
        didFirstSilentRef.current = true;
        console.info("[chart-ws] silent refresh · force reconnect");
        onStaleRefreshRef.current?.();
        setReconnectEpoch((n) => n + 1);
      }, delay);
    };

    const connect = () => {
      if (cancelled) return;
      ws?.close();
      ws = new WebSocket(binanceChartLiveWsUrl(symbol, interval));

      ws.onopen = () => {
        if (cancelled) return;
        connectedNow = true;
        downSinceRef.current = 0;
        didFirstSilentRef.current = false;
        clearWatch();
        setConnected(true);
      };

      ws.onmessage = (ev) => {
        const parsed = parseBinanceChartLiveMessage(ev.data);
        if (!parsed) return;
        if (parsed.markPrice != null && parsed.markPrice > 0) {
          setMarkPrice(parsed.markPrice);
          return;
        }
        if (parsed.candle.time > 0) {
          onKlineRef.current?.(parsed);
        }
      };

      ws.onerror = () => {
        connectedNow = false;
        setConnected(false);
      };

      ws.onclose = () => {
        connectedNow = false;
        setConnected(false);
        if (cancelled) return;
        if (!downSinceRef.current) downSinceRef.current = Date.now();
        armWatch();
        retryTimer = setTimeout(connect, RETRY_MS);
      };
    };

    armWatch();
    connect();

    return () => {
      cancelled = true;
      clearWatch();
      if (retryTimer) clearTimeout(retryTimer);
      ws?.close();
      setConnected(false);
    };
  }, [symbol, interval, enabled, reconnectEpoch]);

  return { markPrice, connected };
}
