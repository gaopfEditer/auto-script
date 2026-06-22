/**
 * discord-collector 配置（环境变量覆盖）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const _repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

/** @typedef {{ host: string; port: number; user: string; password: string; database: string }} MysqlConfig */

/** @type {MysqlConfig} */
export const mysql = {
  host: process.env.MYSQL_HOST ?? "127.0.0.1",
  port: Number(process.env.MYSQL_PORT ?? 3306),
  user: process.env.MYSQL_USER ?? "root",
  password: process.env.MYSQL_PASSWORD ?? "",
  database: process.env.MYSQL_DATABASE ?? "discord_collector",
};

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
  return { url: "https://discord.com/login", usedTargetFallback: false };
}

const collectStart = resolveCollectStartUrl();

function parseIdList(raw) {
  if (!raw?.trim()) return [];
  return [
    ...new Set(
      raw
        .replace(/\|/g, ",")
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean)
    ),
  ];
}

export const config = {
  mysql,
  logLevel: process.env.LOG_LEVEL ?? "info",
  startUrl: collectStart.url,
  collectStartUsedTargetFallback: collectStart.usedTargetFallback,
  cdpConnectUrl: (process.env.CDP_CONNECT_URL ?? "").trim(),
  pageReloadIntervalMs: Number(process.env.COLLECTOR_PAGE_RELOAD_INTERVAL_MS ?? 0),
  collectNetworkTrace: ["1", "true", "yes", "on"].includes(
    String(process.env.COLLECTOR_NETWORK_TRACE ?? "0").toLowerCase()
  ),
  collectWsFrameTrace: ["1", "true", "yes", "on"].includes(
    String(process.env.COLLECTOR_WS_FRAME_TRACE ?? "0").toLowerCase()
  ),
  /** 打印 Gateway MESSAGE_CREATE 等实时消息行（默认关，避免群聊刷屏） */
  gatewayMessageLog: ["1", "true", "yes", "on"].includes(
    String(process.env.DISCORD_GATEWAY_MESSAGE_LOG ?? "0").toLowerCase()
  ),
  collectUiPort: Number(process.env.COLLECTOR_UI_PORT ?? 3851),
  requiredTopLevelKeys: (process.env.COLLECTOR_REQUIRED_KEYS ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean),
  /** 非空时仅入库/展示这些 guild 的消息 */
  monitoredGuildIds: parseIdList(process.env.DISCORD_MONITORED_GUILD_IDS ?? ""),
  /** 信号卡片监听频道（默认内置 4 个） */
  discordSignalChannelIds: parseIdList(process.env.DISCORD_SIGNAL_CHANNEL_IDS ?? ""),
  /** Telegram 推送频道（空=内置 8 个） */
  discordTelegramPushChannelIds: parseIdList(process.env.DISCORD_TELEGRAM_PUSH_CHANNEL_IDS ?? ""),
  /** 实时推送频道，不参与 debounce（空=无，全部走 2 分钟聚合） */
  discordTelegramRealtimeChannelIds: parseIdList(process.env.DISCORD_TELEGRAM_REALTIME_CHANNEL_IDS ?? ""),
  /** 非实时频道：最后一条消息后等待毫秒再批量转发（默认 120000） */
  telegramPushDebounceMs: Number(process.env.DISCORD_TELEGRAM_PUSH_DEBOUNCE_MS ?? 120_000),
  ollamaGenerateUrl: (process.env.OLLAMA_GENERATE_URL ?? "http://127.0.0.1:11434/api/generate").trim(),
  ollamaModel: (process.env.OLLAMA_MODEL ?? "gemma4:26b").trim(),
  ollamaGenerateTimeoutMs: Number(process.env.OLLAMA_GENERATE_TIMEOUT_MS ?? 60_000),
  ollamaEnabled: !["0", "false", "no", "off"].includes(
    String(process.env.OLLAMA_ENABLED ?? "1").toLowerCase()
  ),
  telegramSendUrl: (process.env.TELEGRAM_SEND_URL ?? "http://127.0.0.1:8000/api/telegram/send").trim(),
  telegramPushChatId: (() => {
    const v = String(process.env.TELEGRAM_PUSH_CHAT_ID ?? "").trim();
    if (!v) return "";
    const n = Number(v);
    return Number.isFinite(n) ? n : v;
  })(),
  telegramSendTimeoutMs: Number(process.env.TELEGRAM_SEND_TIMEOUT_MS ?? 15_000),
  /** 默认 true：全量 WS/API 日志与 UI；设 DISCORD_DEBUG_MODE=0 为精简模式 */
  debugMode: ["0", "false", "no", "off"].includes(
    String(process.env.DISCORD_DEBUG_MODE ?? "1").toLowerCase()
  )
    ? false
    : true,
  /** youtube-fetch 本地归档目录（前端文稿预览） */
  youtubeArchivesDir: (process.env.YOUTUBE_ARCHIVES_DIR ?? "").trim()
    ? path.resolve(process.env.YOUTUBE_ARCHIVES_DIR.trim())
    : path.join(_repoRoot, "youtube-fetch", "archives"),
  /** youtube-fetch HTTP API（队列拉取） */
  youtubeFetchUrl: (process.env.YOUTUBE_FETCH_URL ?? "http://127.0.0.1:3920").trim(),
  /** 统一卡片开放 API Key（Header: X-Cards-Api-Key 或 Bearer） */
  cardsApiKey: (process.env.CARDS_API_KEY ?? "").trim(),
  /** 币安行情（卡片价格校验 / 接近推送） */
  binanceFapiUrl: (process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com").trim(),
  binanceRequestTimeoutMs: Number(process.env.BINANCE_REQUEST_TIMEOUT_MS ?? 15_000),
  cardPriceMonitorIntervalMs: Number(process.env.CARD_PRICE_MONITOR_INTERVAL_MS ?? 60_000),
  /** 加密接近推送：每 1h 检查，距关键位 ≤ 1% */
  cardProximityCryptoCheckMs: Number(process.env.CARD_PROXIMITY_CRYPTO_CHECK_MS ?? 3_600_000),
  cardProximityCryptoBandPct: Number(process.env.CARD_PROXIMITY_CRYPTO_BAND_PCT ?? 1.0),
  /** 股票接近推送：每 1 天检查，剩余落差 ≤ 10%（100→110 则在 109–110 提醒） */
  cardProximityStockCheckMs: Number(process.env.CARD_PROXIMITY_STOCK_CHECK_MS ?? 86_400_000),
  cardProximityStockGapPct: Number(process.env.CARD_PROXIMITY_STOCK_GAP_PCT ?? 0.1),
  cardProximityTelegram: !["0", "false", "no", "off"].includes(
    String(process.env.CARD_PROXIMITY_TELEGRAM ?? "1").toLowerCase()
  ),
  /** 价格校验：加密默认 3 小时；股票较长周期（天） */
  cardVerifyDefaultWindowHours: Number(process.env.CARD_VERIFY_DEFAULT_HOURS ?? 3),
  cardVerifyStockWindowDays: Number(process.env.CARD_VERIFY_STOCK_WINDOW_DAYS ?? 30),
};
