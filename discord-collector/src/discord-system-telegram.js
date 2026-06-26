/**
 * 系统级 Telegram 提醒（CDP 断连等，非频道消息）。
 */
import { createDiscordSignalTelegramPush } from "./discord-signal-telegram.js";

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {{ cooldownMs?: number }} [opts]
 */
export function createSystemTelegramAlert(log, opts = {}) {
  const telegram = createDiscordSignalTelegramPush(log);
  const cooldownMs = Math.max(60_000, Number(opts.cooldownMs) || DEFAULT_COOLDOWN_MS);
  /** @type {Map<string, number>} */
  const lastSentByKind = new Map();

  /**
   * @param {string} text
   * @param {{ kind?: string }} [meta]
   */
  async function notify(text, meta = {}) {
    if (!telegram.enabled) return { skipped: "telegram_disabled" };
    const kind = String(meta.kind ?? "system");
    const now = Date.now();
    const last = lastSentByKind.get(kind) ?? 0;
    if (now - last < cooldownMs) return { skipped: "cooldown" };
    lastSentByKind.set(kind, now);
    try {
      const result = await telegram.send(text, { skipChannelLabel: true, kind });
      log.info(`[system-telegram] 已推送 kind=${kind}`);
      return result;
    } catch (e) {
      log.warn(`[system-telegram] 推送失败 kind=${kind}: ${/** @type {Error} */ (e).message}`);
      return { error: String(/** @type {Error} */ (e).message ?? e) };
    }
  }

  /**
   * @param {{ reason?: string, connectUrl?: string, message?: string }} info
   */
  async function notifyCdpDisconnected(info) {
    const connectUrl = String(info.connectUrl ?? "").trim() || "—";
    const reason = String(info.reason ?? "browser_disconnected");
    const reasonLabel =
      reason === "browser_disconnected"
        ? "Chrome 调试连接已断开（connectOverCDP）"
        : reason;
    const text = [
      "⚠️ Discord Collector CDP 连接中断",
      "",
      `原因: ${reasonLabel}`,
      `CDP: ${connectUrl}`,
      `时间: ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      "",
      "请检查 Chrome 是否休眠/已关闭，并重新启动带 --remote-debugging-port 的 Chrome。",
    ].join("\n");
    return notify(text, { kind: "cdp_disconnected" });
  }

  return { notify, notifyCdpDisconnected, enabled: telegram.enabled };
}
