/**
 * 系统级 Telegram 提醒（CDP 断连等，非频道消息）。
 */
import { createDiscordSignalTelegramPush } from "./discord-signal-telegram.js";

const DEFAULT_COOLDOWN_MS = 5 * 60 * 1000;

/**
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 * @param {{
 *   cooldownMs?: number,
 *   cdpNotifyDisconnect?: boolean,
 *   cdpNotifyConnect?: boolean,
 *   cdpDisconnectNotifyAfterMs?: number,
 * }} [opts]
 */
export function createSystemTelegramAlert(log, opts = {}) {
  const telegram = createDiscordSignalTelegramPush(log);
  const cooldownMs = Math.max(60_000, Number(opts.cooldownMs) || DEFAULT_COOLDOWN_MS);
  const cdpNotifyDisconnect = opts.cdpNotifyDisconnect !== false;
  const cdpNotifyConnect = opts.cdpNotifyConnect !== false;
  const cdpDisconnectNotifyAfterMs = Math.max(
    60_000,
    Number(opts.cdpDisconnectNotifyAfterMs) || 15 * 60_000,
  );
  /** @type {Map<string, number>} */
  const lastSentByKind = new Map();

  /** @type {ReturnType<typeof setTimeout> | null} */
  let cdpOutageNotifyTimer = null;
  let cdpOutageActive = false;
  let cdpOutageDisconnectNotified = false;
  /** @type {{ reason?: string, connectUrl?: string, message?: string } | null} */
  let cdpOutagePendingInfo = null;

  function clearCdpOutageWatch() {
    if (cdpOutageNotifyTimer) {
      clearTimeout(cdpOutageNotifyTimer);
      cdpOutageNotifyTimer = null;
    }
    cdpOutageActive = false;
    cdpOutagePendingInfo = null;
    cdpOutageDisconnectNotified = false;
  }

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
  async function sendCdpDisconnectedNow(info) {
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
      `已断开超过 ${Math.round(cdpDisconnectNotifyAfterMs / 60_000)} 分钟且仍未恢复。`,
      "请检查 Chrome 是否仍开着调试端口（--remote-debugging-port）。",
    ].join("\n");
    return notify(text, { kind: "cdp_disconnected" });
  }

  /**
   * @param {{ reason?: string, connectUrl?: string, message?: string }} info
   */
  async function notifyCdpDisconnected(info) {
    if (!cdpNotifyDisconnect) return { skipped: "cdp_notify_disabled" };
    cdpOutagePendingInfo = info;
    cdpOutageActive = true;
    if (cdpOutageNotifyTimer) {
      return { skipped: "outage_watch_pending" };
    }
    log.info(
      `[system-telegram] CDP 断连，${Math.round(cdpDisconnectNotifyAfterMs / 60_000)} 分钟内若未恢复则不提醒`
    );
    cdpOutageNotifyTimer = setTimeout(() => {
      cdpOutageNotifyTimer = null;
      if (!cdpOutageActive) return;
      const pending = cdpOutagePendingInfo;
      cdpOutageDisconnectNotified = true;
      void sendCdpDisconnectedNow(pending ?? info).catch(() => {});
    }, cdpDisconnectNotifyAfterMs);
    return { skipped: "outage_watch_started" };
  }

  /**
   * 首次 attach 或 collect:ui 启动 CDP 成功。
   * @param {{ connectUrl?: string, tabCount?: number }} info
   */
  async function notifyCdpConnected(info) {
    clearCdpOutageWatch();
    if (!cdpNotifyConnect) return { skipped: "cdp_notify_disabled" };
    const connectUrl = String(info.connectUrl ?? "").trim() || "—";
    const tabs = Number(info.tabCount);
    const text = [
      "✅ Discord Collector CDP 已连接",
      "",
      `CDP: ${connectUrl}`,
      Number.isFinite(tabs) && tabs >= 0 ? `已挂载标签: ${tabs}` : null,
      `时间: ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      "",
      "Gateway 监听已就绪；若长时间无新消息请确认 Discord 页已登录且标签未关。",
    ]
      .filter(Boolean)
      .join("\n");
    return notify(text, { kind: "cdp_connected" });
  }

  /**
   * 断线后自动重连成功。
   * @param {{ connectUrl?: string, attempt?: number, tabCount?: number }} info
   */
  async function notifyCdpReconnected(info) {
    const hadLongOutageAlert = cdpOutageDisconnectNotified;
    clearCdpOutageWatch();
    if (!cdpNotifyConnect) return { skipped: "cdp_notify_disabled" };
    if (!hadLongOutageAlert) {
      log.debug("[system-telegram] CDP 短暂断连已恢复，跳过 Telegram");
      return { skipped: "brief_outage" };
    }
    const connectUrl = String(info.connectUrl ?? "").trim() || "—";
    const attempt = Number(info.attempt) || 0;
    const tabs = Number(info.tabCount);
    const text = [
      "✅ Discord Collector CDP 已恢复",
      "",
      `CDP: ${connectUrl}`,
      attempt > 0 ? `重连次数: ${attempt}` : null,
      Number.isFinite(tabs) && tabs >= 0 ? `已挂载标签: ${tabs}` : null,
      `时间: ${new Date().toLocaleString("zh-CN", { hour12: false })}`,
      "",
      "已重新附加并刷新 Discord 保活频道。",
    ]
      .filter(Boolean)
      .join("\n");
    return notify(text, { kind: "cdp_reconnected" });
  }

  return {
    notify,
    notifyCdpDisconnected,
    notifyCdpConnected,
    notifyCdpReconnected,
    enabled: telegram.enabled,
  };
}
