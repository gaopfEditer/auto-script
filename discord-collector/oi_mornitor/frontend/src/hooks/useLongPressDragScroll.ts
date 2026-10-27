import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";

const LONG_PRESS_MS = 380;
const MOVE_CANCEL_THRESHOLD = 8;

/** 长按后水平拖动滚动（与 PatternAlertTicker 交互一致） */
export function useLongPressDragScroll(enabled: boolean, measureDeps: unknown[] = []) {
  const ref = useRef<HTMLDivElement>(null);
  const slidingRef = useRef(false);
  const suppressClickRef = useRef(false);
  const pointerStartXRef = useRef(0);
  const scrollAtPointerDownRef = useRef(0);
  const longPressTimerRef = useRef(0);
  const activePointerIdRef = useRef<number | null>(null);
  const [sliding, setSliding] = useState(false);
  const [isScrollable, setIsScrollable] = useState(false);

  const clearLongPressTimer = useCallback(() => {
    if (longPressTimerRef.current) {
      window.clearTimeout(longPressTimerRef.current);
      longPressTimerRef.current = 0;
    }
  }, []);

  const endSliding = useCallback(
    (el?: HTMLDivElement | null, pointerId?: number | null) => {
      clearLongPressTimer();
      if (!slidingRef.current && activePointerIdRef.current == null) return;
      slidingRef.current = false;
      setSliding(false);
      const pid = pointerId ?? activePointerIdRef.current;
      activePointerIdRef.current = null;
      if (el && pid != null) {
        try {
          el.releasePointerCapture(pid);
        } catch {
          /* ignore */
        }
      }
    },
    [clearLongPressTimer],
  );

  useEffect(() => () => clearLongPressTimer(), [clearLongPressTimer]);

  useEffect(() => {
    if (!enabled) {
      setIsScrollable(false);
      return;
    }
    const el = ref.current;
    if (!el) return;
    const check = () => setIsScrollable(el.scrollWidth > el.clientWidth + 2);
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    const mo = new MutationObserver(check);
    mo.observe(el, { childList: true, subtree: true });
    return () => {
      ro.disconnect();
      mo.disconnect();
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps -- remeasure when list content changes
  }, [enabled, ...measureDeps]);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!enabled || e.button !== 0) return;
      clearLongPressTimer();
      slidingRef.current = false;
      suppressClickRef.current = false;
      setSliding(false);
      pointerStartXRef.current = e.clientX;
      scrollAtPointerDownRef.current = e.currentTarget.scrollLeft;
      activePointerIdRef.current = e.pointerId;
      const target = e.currentTarget;
      const pointerId = e.pointerId;
      longPressTimerRef.current = window.setTimeout(() => {
        longPressTimerRef.current = 0;
        if (activePointerIdRef.current !== pointerId) return;
        slidingRef.current = true;
        suppressClickRef.current = true;
        setSliding(true);
        try {
          target.setPointerCapture(pointerId);
        } catch {
          /* ignore */
        }
      }, LONG_PRESS_MS);
    },
    [enabled, clearLongPressTimer],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!enabled) return;
      if (!slidingRef.current) {
        if (Math.abs(e.clientX - pointerStartXRef.current) > MOVE_CANCEL_THRESHOLD) {
          clearLongPressTimer();
        }
        return;
      }
      const dx = e.clientX - pointerStartXRef.current;
      e.currentTarget.scrollLeft = scrollAtPointerDownRef.current - dx;
    },
    [enabled, clearLongPressTimer],
  );

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!enabled) return;
      const wasSliding = slidingRef.current;
      clearLongPressTimer();
      endSliding(e.currentTarget, e.pointerId);
      if (wasSliding) {
        suppressClickRef.current = true;
        window.setTimeout(() => {
          suppressClickRef.current = false;
        }, 0);
      }
    },
    [enabled, clearLongPressTimer, endSliding],
  );

  const onPointerLeave = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      endSliding(e.currentTarget, e.pointerId);
    },
    [endSliding],
  );

  return {
    ref,
    sliding,
    isScrollable,
    suppressClickRef,
    handlers: {
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onPointerLeave,
      onPointerCancel: onPointerUp,
    },
  };
}
