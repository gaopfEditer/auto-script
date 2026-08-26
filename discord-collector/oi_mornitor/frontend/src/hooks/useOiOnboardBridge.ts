import { useEffect } from "react";

const OI_MSG_MEASURE = "dc-oi-onboard-measure";
const OI_MSG_RECT = "dc-oi-onboard-rect";

type Options = {
  onEnsurePatternTab?: () => void;
};

/**
 * 响应父页（discord-collector Vue）新手指引的测量 / 切 tab 请求。
 */
export function useOiOnboardBridge(opts: Options = {}) {
  const { onEnsurePatternTab } = opts;

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      const data = e.data;
      if (!data || data.type !== OI_MSG_MEASURE) return;

      onEnsurePatternTab?.();

      const selector = typeof data.selector === "string" ? data.selector : "";
      window.requestAnimationFrame(() => {
        window.requestAnimationFrame(() => {
          const el = selector ? document.querySelector(selector) : null;
          const r = el?.getBoundingClientRect();
          const rect = r
            ? { top: r.top, left: r.left, width: r.width, height: r.height }
            : null;
          try {
            window.parent?.postMessage({ type: OI_MSG_RECT, rect }, "*");
          } catch {
            /* ignore */
          }
        });
      });
    };

    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [onEnsurePatternTab]);
}
