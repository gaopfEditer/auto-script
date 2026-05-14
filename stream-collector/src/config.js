/**
 * 默认配置：可通过环境变量覆盖。
 */

/**
 * @typedef {{
 *   host: string;
 *   port: number;
 *   user: string;
 *   password: string;
 *   database: string;
 * }} MysqlConfig
 */

/** @type {MysqlConfig} */
export const mysql = {
  host: process.env.MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.MYSQL_PORT ?? 5832),
  user: process.env.MYSQL_USER ?? "root",
  password: process.env.MYSQL_PASSWORD ?? "Cambridge#*DR",
  database: process.env.MYSQL_DATABASE ?? "stream_collector",
};

/**
 * 无头 collect 的 `goto` 地址：优先 `COLLECTOR_START_URL`；
 * 若未设、空串或 `about:blank`，则使用 `TARGET_PAGE_URL`（与 collect:persistent 共用，少配一项）；
 * 若仍无则 `about:blank`。附加 CDP 时仍作日志提示用。
 */
function resolveCollectStartUrl() {
  const primary = (process.env.COLLECTOR_START_URL ?? "").trim();
  const blankish =
    !primary ||
    primary.toLowerCase() === "about:blank" ||
    primary.toLowerCase() === "about:blank/";
  const target = (process.env.TARGET_PAGE_URL ?? "").trim();
  if (blankish && target) {
    return { url: target, usedTargetFallback: true };
  }
  if (primary) {
    return { url: primary, usedTargetFallback: false };
  }
  return { url: "about:blank", usedTargetFallback: false };
}

const collectStart = resolveCollectStartUrl();

export const config = {
  mysql,
  /** 日志级别：silent | error | warn | info | debug */
  logLevel: process.env.LOG_LEVEL ?? "info",
  /** @see resolveCollectStartUrl */
  startUrl: collectStart.url,
  /** 为 true 表示因 COLLECTOR_START_URL 空/about:blank 而使用了 TARGET_PAGE_URL */
  collectStartUsedTargetFallback: collectStart.usedTargetFallback,
  /** 回放：每条记录之间的基础间隔（毫秒），再除以 speedMultiplier */
  replayBaseDelayMs: Number(process.env.COLLECTOR_REPLAY_DELAY_MS ?? 50),
  replaySpeedMultiplier: Number(process.env.COLLECTOR_REPLAY_SPEED ?? 1),
  /** JSON 校验：要求顶层必须存在的键（空数组表示仅校验为 object） */
  requiredTopLevelKeys: (process.env.COLLECTOR_REQUIRED_KEYS ?? "type,payload")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /**
   * 连接本机已启动的 Chrome（需带 --remote-debugging-port），以采集你在该浏览器里打开/刷新页面时的 WS 帧。
   * 例: http://127.0.0.1:9222
   */
  cdpConnectUrl: (process.env.CDP_CONNECT_URL ?? "").trim(),
  /**
   * Playwright 控制的页面定时 reload（毫秒）。0 表示关闭。
   * 用于「页面只连一次 WS、服务端发完即断」时，在无头浏览器里周期性重建连接。
   * 无头模式下若页面 WS 只建一次、需周期性重连时可设正数；纯附加 CDP 时常为 0。
   */
  pageReloadIntervalMs: Number(process.env.COLLECTOR_PAGE_RELOAD_INTERVAL_MS ?? 0),
  /**
   * collect：打印主文档 / XHR / Fetch / WebSocket 握手与页面生命周期（默认开）。
   * 设 COLLECTOR_NETWORK_TRACE=0|false|off 关闭。
   */
  collectNetworkTrace: !["0", "false", "no", "off"].includes(
    String(process.env.COLLECTOR_NETWORK_TRACE ?? "1").toLowerCase()
  ),
  /** `pnpm run collect:ui` 监听端口 */
  collectUiPort: Number(process.env.COLLECTOR_UI_PORT ?? 3840),
};
