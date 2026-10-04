/**
 * 定时用 CDP 打开 Discord 频道，触发网页端拉历史。
 * 每次定时只切换 **一个** 频道（轮询），避免一轮内连跳十余次像「不停刷新」。
 */
import { parseDiscordChannelUrl } from "./cdp-ws-monitor.js";
import { getSignalChannelIds } from "./discord-signal-config.js";
import { DABIAOKE_SIGNAL_CHANNEL_ID } from "./discord-telegram-push-config.js";

/**
 * @param {{
 *   navigate: (guildId: string, channelId: string) => Promise<{ ok?: boolean, error?: string, skipped?: boolean } | unknown>,
 *   startUrl?: string,
 *   guildIdFallback?: string,
 *   intervalMs?: number,
 *   dwellMs?: number,
 *   enabled?: boolean,
 *   log?: { info: Function, warn: Function, debug?: Function },
 * }} opts
 */
export function startCdpChannelRotate(opts) {
  const log = opts.log || console;
  const enabled = opts.enabled !== false;
  // 默认 15 分钟切一个频道；一轮 N 个频道约 N×15 分钟扫完
  const intervalMs = Math.max(60_000, Number(opts.intervalMs) || 900_000);
  const navigate = opts.navigate;
  if (!enabled || typeof navigate !== "function") {
    return { stop() {} };
  }

  /** @type {ReturnType<typeof setTimeout> | null} */
  let timer = null;
  let stopped = false;
  let stepInFlight = false;
  let cursor = 0;

  function resolveGuildId() {
    const fromStart = parseDiscordChannelUrl(String(opts.startUrl || ""));
    if (fromStart?.guildId && fromStart.guildId !== "@me") return fromStart.guildId;
    return String(opts.guildIdFallback || "").trim();
  }

  /** @returns {{ guildId: string, channelId: string }[]} */
  function buildTargets() {
    const guildId = resolveGuildId();
    if (!guildId) return [];
    /** @type {string[]} */
    const ids = [...getSignalChannelIds()];
    const start = parseDiscordChannelUrl(String(opts.startUrl || ""));
    if (start?.channelId) ids.push(start.channelId);
    const trimmed = ids.map((x) => String(x).trim()).filter(Boolean);
    const priority = [DABIAOKE_SIGNAL_CHANNEL_ID].filter((id) => trimmed.includes(id));
    const rest = trimmed.filter((id) => !priority.includes(id));
    const uniq = [...new Set([...priority, ...rest])];
    return uniq.map((channelId) => ({ guildId, channelId }));
  }

  async function runStep() {
    if (stopped || stepInFlight) return;
    const targets = buildTargets();
    if (!targets.length) {
      log.warn?.("[channel-rotate] 无轮询目标（检查 startUrl guild / 信号频道配置）");
      return;
    }
    if (cursor >= targets.length) cursor = 0;
    const t = targets[cursor];
    const idx = cursor;
    cursor = (cursor + 1) % targets.length;
    stepInFlight = true;
    try {
      const out = /** @type {{ ok?: boolean, error?: string, skipped?: boolean }} */ (
        await navigate(t.guildId, t.channelId)
      );
      if (out && out.ok === false) {
        const err = out.error || "unknown";
        if (err.includes("未连接")) {
          log.warn?.(
            `[channel-rotate] ${idx + 1}/${targets.length} ${t.channelId} 失败: ${err}（调试 Chrome/CDP 断线或重连中；见 collect:ui 日志 [CDP] 与 GET /api/discord/cdp-status）`
          );
        } else {
          log.warn?.(
            `[channel-rotate] ${idx + 1}/${targets.length} ${t.channelId} 失败: ${err}`
          );
        }
      } else if (out?.skipped) {
        log.info?.(
          `[channel-rotate] ${idx + 1}/${targets.length} 跳过 ${t.channelId}（${out.reason || "skipped"}）`
        );
      } else {
        log.info?.(
          `[channel-rotate] ${idx + 1}/${targets.length} 已打开 ${t.channelId}（下次约 ${Math.round(intervalMs / 60000)} 分钟）`
        );
      }
    } catch (e) {
      log.warn?.(
        `[channel-rotate] ${idx + 1}/${targets.length} ${t.channelId}: ${/** @type {Error} */ (e).message}`
      );
    } finally {
      stepInFlight = false;
    }
  }

  function scheduleNext(delay) {
    if (stopped) return;
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      void runStep().finally(() => scheduleNext(intervalMs));
    }, delay);
  }

  const bootDelay = Math.min(60_000, Math.max(20_000, Math.floor(intervalMs / 15)));
  log.info(
    `[channel-rotate] 已启用：每次只切 1 个信号频道，间隔约 ${Math.round(intervalMs / 60000)} 分钟（${Math.round(bootDelay / 1000)}s 后首次）`
  );
  scheduleNext(bootDelay);

  return {
    stop() {
      stopped = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
      }
    },
  };
}
