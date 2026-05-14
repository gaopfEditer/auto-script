import { ref, onUnmounted } from "vue";

/**
 * 连接同源 `/ws`，推送服务端广播的 JSON 行。
 * @param {(msg: Record<string, unknown>) => void} onMessage
 */
export function useCollectorSocket(onMessage) {
  const status = ref("connecting");
  const error = ref("");

  const proto = typeof location !== "undefined" && location.protocol === "https:" ? "wss:" : "ws:";
  const url = typeof location !== "undefined" ? `${proto}//${location.host}/ws` : "";

  const ws = new WebSocket(url);

  ws.onopen = () => {
    status.value = "open";
    error.value = "";
  };
  ws.onclose = () => {
    status.value = "closed";
  };
  ws.onerror = () => {
    status.value = "error";
    error.value = "WebSocket 错误";
  };
  ws.onmessage = (ev) => {
    try {
      const msg = JSON.parse(ev.data);
      onMessage(msg);
    } catch {
      onMessage({ ts: Date.now(), channel: "?", kind: "parse_err", raw: ev.data });
    }
  };

  onUnmounted(() => {
    try {
      ws.close();
    } catch {
      /* ignore */
    }
  });

  return { status, error };
}
