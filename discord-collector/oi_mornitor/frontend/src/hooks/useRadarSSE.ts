import { useCallback, useEffect, useRef, useState } from "react";
import type { PatternPayload, RadarSnapshot } from "../types";
import { EMPTY_SNAPSHOT } from "../types";

const SILENT_REFRESH_FIRST_MS = 30_000;
const SILENT_REFRESH_EVERY_MS = 5 * 60_000;

export function useRadarSSE(intervalMs = 5000) {
  const [snapshot, setSnapshot] = useState<RadarSnapshot>(EMPTY_SNAPSHOT);
  const [online, setOnline] = useState(false);
  const retryRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downSinceRef = useRef(0);
  const didFirstSilentRef = useRef(false);
  const [reconnectEpoch, setReconnectEpoch] = useState(0);

  const apply = useCallback((data: RadarSnapshot) => {
    setSnapshot(data);
  }, []);

  /** 本地补丁：watch/pin/remove 等 API 成功后立刻反映，不必等下一轮 SSE */
  const patchPattern = useCallback((partial: Partial<PatternPayload>) => {
    setSnapshot((prev) => ({
      ...prev,
      pattern: {
        ...(prev.pattern ?? EMPTY_SNAPSHOT.pattern!),
        ...partial,
      },
    }));
  }, []);

  useEffect(() => {
    let es: EventSource | null = null;
    let cancelled = false;
    let watchTimer: ReturnType<typeof setTimeout> | null = null;
    let onlineNow = false;

    if (!downSinceRef.current) downSinceRef.current = Date.now();

    const clearWatch = () => {
      if (watchTimer) {
        clearTimeout(watchTimer);
        watchTimer = null;
      }
    };

    const markUp = () => {
      onlineNow = true;
      downSinceRef.current = 0;
      didFirstSilentRef.current = false;
      clearWatch();
      setOnline(true);
    };

    const markDown = () => {
      onlineNow = false;
      setOnline(false);
      if (!downSinceRef.current) downSinceRef.current = Date.now();
    };

    const bootstrap = async () => {
      try {
        const res = await fetch("/api/snapshot");
        if (!res.ok) throw new Error(String(res.status));
        apply(await res.json());
        markUp();
      } catch {
        markDown();
      }
    };

    const armWatch = () => {
      clearWatch();
      if (cancelled || onlineNow) return;
      if (!downSinceRef.current) downSinceRef.current = Date.now();
      const elapsed = Date.now() - downSinceRef.current;
      const delay = !didFirstSilentRef.current
        ? Math.max(200, SILENT_REFRESH_FIRST_MS - elapsed)
        : SILENT_REFRESH_EVERY_MS;
      watchTimer = setTimeout(() => {
        watchTimer = null;
        if (cancelled || onlineNow) return;
        didFirstSilentRef.current = true;
        console.info("[radar-sse] silent refresh · rebootstrap + reconnect");
        void bootstrap().finally(() => {
          if (cancelled) return;
          // bootstrap 成功会 markUp 清掉标记；保持「已做过首次」以免又变回 30s
          didFirstSilentRef.current = true;
          if (!onlineNow) setReconnectEpoch((n) => n + 1);
        });
      }, delay);
    };

    const connect = () => {
      if (cancelled) return;
      es = new EventSource("/api/stream");
      es.onopen = () => {
        markUp();
      };
      es.onmessage = (ev) => {
        try {
          apply(JSON.parse(ev.data));
          if (!onlineNow) markUp();
        } catch {
          /* ignore malformed */
        }
      };
      es.onerror = () => {
        markDown();
        es?.close();
        armWatch();
        retryRef.current = setTimeout(connect, intervalMs);
      };
    };

    armWatch();
    void bootstrap().then(connect);

    return () => {
      cancelled = true;
      clearWatch();
      es?.close();
      if (retryRef.current) clearTimeout(retryRef.current);
    };
  }, [apply, intervalMs, reconnectEpoch]);

  return { snapshot, online, patchPattern };
}
