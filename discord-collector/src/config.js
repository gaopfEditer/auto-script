/**
 * discord-collector 配置（环境变量覆盖）。
 */
import path from "node:path";
import { fileURLToPath } from "node:url";

const _repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const _collectorRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

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

/** @param {string[]} envKeys */
function envProxy(...envKeys) {
  for (const key of envKeys) {
    const v = (process.env[key] ?? "").trim();
    if (v) return v;
  }
  return "";
}

const commonProxy = envProxy("COMMON_PROXY");

export const config = {
  mysql,
  logLevel: process.env.LOG_LEVEL ?? "info",
  startUrl: collectStart.url,
  collectStartUsedTargetFallback: collectStart.usedTargetFallback,
  cdpConnectUrl: (process.env.CDP_CONNECT_URL ?? "").trim(),
  /**
   * CDP 附加后自动打开 startUrl（Discord 频道）并定时刷新保活。
   * 默认开；COLLECTOR_CDP_AUTO_GOTO=0 关闭。
   */
  cdpAutoGoto: !["0", "false", "no", "off"].includes(
    String(process.env.COLLECTOR_CDP_AUTO_GOTO ?? "1").toLowerCase()
  ),
  /**
   * CDP 注入脚本：伪造页面始终前台，减轻 Discord 后台节流 Gateway。
   * 默认开；COLLECTOR_CDP_VISIBILITY_KEEPALIVE=0 关闭。
   */
  cdpVisibilityKeepalive: !["0", "false", "no", "off"].includes(
    String(process.env.COLLECTOR_CDP_VISIBILITY_KEEPALIVE ?? "1").toLowerCase()
  ),
  /**
   * 定时用 CDP 轮询打开信号频道（每次只切 1 个，避免连跳）。
   * 默认开；COLLECTOR_CDP_CHANNEL_ROTATE=0 关闭。
   * 间隔默认 15 分钟切下一个（勿依赖前端点频道触发）。
   */
  cdpChannelRotate: !["0", "false", "no", "off"].includes(
    String(process.env.COLLECTOR_CDP_CHANNEL_ROTATE ?? "1").toLowerCase()
  ),
  cdpChannelRotateIntervalMs: Math.max(
    60_000,
    Number(process.env.COLLECTOR_CDP_CHANNEL_ROTATE_INTERVAL_MS) || 900_000
  ),
  /** @deprecated 已改为每次只切 1 频道，dwell 不再使用；保留以免旧配置报错 */
  cdpChannelRotateDwellMs: Math.max(
    3_000,
    Number(process.env.COLLECTOR_CDP_CHANNEL_ROTATE_DWELL_MS) || 12_000
  ),
  /**
   * Discord 页定时刷新间隔（ms）。0=不刷新。
   * 未配置且 startUrl 为 /channels/… 时默认 5 分钟，避免 Gateway 假死。
   */
  pageReloadIntervalMs: (() => {
    const raw = process.env.COLLECTOR_PAGE_RELOAD_INTERVAL_MS;
    if (raw != null && String(raw).trim() !== "") {
      return Math.max(0, Number(raw) || 0);
    }
    if (/discord\.com\/channels\//i.test(collectStart.url)) return 5 * 60_000;
    return 0;
  })(),
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
  /** Webhook 转发逐条日志（POST / 已转发等，默认关） */
  webhookForwardLog: ["1", "true", "yes", "on"].includes(
    String(process.env.DISCORD_WEBHOOK_FORWARD_LOG ?? "0").toLowerCase()
  ),
  /** 卡片价格校验 / 回测 / 接近检查逐条日志（默认关） */
  cardPullForwardLog: ["1", "true", "yes", "on"].includes(
    String(process.env.DISCORD_CARDPULL_FORWARD_LOG ?? "0").toLowerCase()
  ),
  /** 新卡片桌面通知（浏览器 Notification API，默认关） */
  cardToastDesktop: ["1", "true", "yes", "on"].includes(
    String(process.env.CARD_TOAST_DESKTOP ?? "0").toLowerCase()
  ),
  /** 新卡片 Toast 位置：bottom-right | top-right */
  cardToastPosition:
    String(process.env.CARD_TOAST_POSITION ?? "bottom-right").toLowerCase() === "top-right"
      ? "top-right"
      : "bottom-right",
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
  telegramPushDebounceMs: Number(process.env.DISCORD_TELEGRAM_PUSH_DEBOUNCE_MS ?? 120),
  /** Gateway 消息：先转发 Telegram/Webhook，再入库（默认开启，省 20–150ms+） */
  telegramPriorityForward: !["0", "false", "no", "off"].includes(
    String(process.env.DISCORD_TELEGRAM_PRIORITY_FORWARD ?? "1").toLowerCase()
  ),
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
  /** WhisprRT 等目录：启动后延时扫描 *.txt 并解析（第一行标题） */
  pasteParseInputDir: (process.env.PASTE_PARSE_INPUT_DIR ?? "").trim()
    ? path.resolve(process.env.PASTE_PARSE_INPUT_DIR.trim())
    : path.resolve(_repoRoot, "..", "WhisprRT", "output"),
  /** 文稿解析结果 JSON 目录（与源 txt 同名 .json，已存在则跳过） */
  pasteParseOutputDir: (process.env.PASTE_PARSE_OUTPUT_DIR ?? "").trim()
    ? path.resolve(process.env.PASTE_PARSE_OUTPUT_DIR.trim())
    : path.join(_collectorRoot, "data", "paste-parse"),
  pasteParseStartupDelayMs: Number(process.env.PASTE_PARSE_STARTUP_DELAY_MS ?? 15_000),
  /** 输入目录轮询间隔：探测新 .txt 并自动解析（默认 10 分钟） */
  pasteParseWatchIntervalMs: Number(process.env.PASTE_PARSE_WATCH_INTERVAL_MS ?? 600_000),
  /** 统一卡片开放 API Key（Header: X-Cards-Api-Key 或 Bearer）；未设 env 时用下方默认 */
  cardsApiKey: (process.env.CARDS_API_KEY ?? "Gpf123456").trim(),
  /**
   * POST /api/v1/cards 等归档时：若 channelId 为已知 Discord 频道，写入该频道时间线一条最新消息。
   * 默认开；CARD_API_INJECT_CHANNEL_MESSAGE=0 关闭。
   */
  cardApiInjectChannelMessage: !["0", "false", "no", "off"].includes(
    String(process.env.CARD_API_INJECT_CHANNEL_MESSAGE ?? "1").toLowerCase()
  ),
  /** 统一 HTTP(S) 代理（Bitget / WEEX / Webhook / 币安等默认共用） */
  commonProxy,
  /** 币安行情（卡片价格校验 / 接近推送） */
  binanceFapiUrl: (process.env.BINANCE_FAPI_URL ?? "https://fapi.binance.com").trim(),
  binanceRequestTimeoutMs: Number(process.env.BINANCE_REQUEST_TIMEOUT_MS ?? 15_000),
  /** 币安 API 代理（国内直连常失败；默认 COMMON_PROXY） */
  binanceProxy: envProxy("BINANCE_PROXY", "COMMON_PROXY", "DISCORD_WEBHOOK_PROXY", "HTTPS_PROXY", "HTTP_PROXY"),
  cardPriceMonitorIntervalMs: Number(process.env.CARD_PRICE_MONITOR_INTERVAL_MS ?? 300_000),
  /** 加密接近推送：每 5min 检查，距入场 ±5% */
  cardProximityCryptoCheckMs: Number(process.env.CARD_PROXIMITY_CRYPTO_CHECK_MS ?? 300_000),
  cardProximityCryptoBandPct: Number(process.env.CARD_PROXIMITY_CRYPTO_BAND_PCT ?? 5.0),
  /** 是否启用 TP1/2/3 自动评价（默认开） */
  cardAutoEvalEnabled: !["0", "false", "no", "off"].includes(
    String(process.env.CARD_AUTO_EVAL_ENABLED ?? "1").toLowerCase()
  ),
  /** 档位进度状态机：每小时检查入场/TP/SL（1/N 分批） */
  cardLevelCheckEnabled: !["0", "false", "no", "off"].includes(
    String(process.env.CARD_LEVEL_CHECK_ENABLED ?? "1").toLowerCase()
  ),
  cardLevelCheckMs: Number(process.env.CARD_LEVEL_CHECK_MS ?? 3_600_000),
  /** 超过该时长未完结的卡片视为失效，不再拉 K 线兜底核验（默认 8h） */
  cardKlineVerifyMaxAgeMs: Number(process.env.CARD_KLINE_VERIFY_MAX_AGE_MS ?? 8 * 3_600_000),
  /**
   * 卡片挂 Bitget/WEEX 单后：TP1 触达则把止损移到开仓价（默认开，每 30s 扫一次）。
   */
  cardTp1BreakevenEnabled: !["0", "false", "no", "off"].includes(
    String(process.env.CARD_TP1_BREAKEVEN_ENABLED ?? "1").toLowerCase()
  ),
  cardTp1BreakevenIntervalMs: Number(process.env.CARD_TP1_BREAKEVEN_INTERVAL_MS ?? 30_000),
  /** 股票接近推送：每 1 天检查，剩余落差 ≤ 10%（100→110 则在 109–110 提醒） */
  cardProximityStockCheckMs: Number(process.env.CARD_PROXIMITY_STOCK_CHECK_MS ?? 86_400_000),
  cardProximityStockGapPct: Number(process.env.CARD_PROXIMITY_STOCK_GAP_PCT ?? 0.1),
  cardProximityTelegram: !["0", "false", "no", "off"].includes(
    String(process.env.CARD_PROXIMITY_TELEGRAM ?? "0").toLowerCase()
  ),
  /** 浮盈达阶梯提醒上移止损（默认 5/10/15/20%） */
  cardProfitTrailEnabled: !["0", "false", "no", "off"].includes(
    String(process.env.CARD_PROFIT_TRAIL_ENABLED ?? "1").toLowerCase()
  ),
  cardProfitTrailTelegram: !["0", "false", "no", "off"].includes(
    String(process.env.CARD_PROFIT_TRAIL_TELEGRAM ?? "1").toLowerCase()
  ),
  cardProfitTrailLevels: String(process.env.CARD_PROFIT_TRAIL_LEVELS ?? "5,10,15,20").trim(),
  /** 同卡两次盈利阶梯提醒最短间隔（毫秒，默认 1h） */
  cardProfitTrailCooldownMs: Math.max(
    60_000,
    Number(process.env.CARD_PROFIT_TRAIL_COOLDOWN_MS ?? 3_600_000) || 3_600_000
  ),
  /** 价格校验：加密默认 1 天（Binance K 线）；legacy 3h；股票较长周期 */
  cardVerifyCryptoWindowDays: Number(process.env.CARD_VERIFY_CRYPTO_WINDOW_DAYS ?? 1),
  cardVerifyDefaultWindowHours: Number(process.env.CARD_VERIFY_DEFAULT_HOURS ?? 3),
  cardVerifyStockWindowDays: Number(process.env.CARD_VERIFY_STOCK_WINDOW_DAYS ?? 30),
  /** 自动校验盈亏按杠杆倍数（默认 100x） */
  cardVerifyLeverage: Number(process.env.CARD_VERIFY_LEVERAGE ?? 100),
  /** 评价表单：主流 BTC/ETH 默认杠杆 */
  cardEvalMajorLeverage: Number(process.env.CARD_EVAL_MAJOR_LEVERAGE ?? 100),
  /** 评价表单：山寨默认杠杆 */
  cardEvalAltcoinLeverage: Number(process.env.CARD_EVAL_ALTCOIN_LEVERAGE ?? 20),
  /** 卡片外送（外部评估服务）：默认开，WS 优先、HTTP 回退 */
  cardSinkEnabled: !["0", "false", "no", "off"].includes(
    String(process.env.CARD_SINK_ENABLED ?? "1").toLowerCase()
  ),
  cardSinkWsUrl: (process.env.CARD_SINK_WS_URL ?? "ws://127.0.0.1:8765/ws/cards").trim(),
  cardSinkHttpUrl: (process.env.CARD_SINK_HTTP_URL ?? "http://127.0.0.1:8765/api/cards").trim(),
  cardSinkTimeoutMs: Number(process.env.CARD_SINK_TIMEOUT_MS ?? 8_000),
  cardSinkReconnectMs: Number(process.env.CARD_SINK_RECONNECT_MS ?? 3_000),
  /** OI Monitor（同仓 oi_mornitor）：健康检查与 UI 嵌入地址 */
  oiWebBaseUrl: (process.env.OI_WEB_BASE_URL ?? "http://127.0.0.1:8765").replace(/\/$/, ""),
  /** iframe 优先地址；空则用 oiWebBaseUrl。oi:dev 时可设 http://127.0.0.1:5173 */
  oiEmbedUrl: (process.env.OI_EMBED_URL ?? process.env.VITE_OI_EMBED_URL ?? "").replace(/\/$/, ""),
  /**
   * 浏览器侧公网嵌入地址（前端上云时必填）。
   * 本地探测仍用 oiWebBaseUrl；iframe 优先用本字段，避免把 127.0.0.1 塞给访客浏览器。
   */
  oiPublicEmbedUrl: (
    process.env.OI_PUBLIC_EMBED_URL ??
    process.env.VITE_OI_PUBLIC_EMBED_URL ??
    ""
  ).replace(/\/$/, ""),
  oiHealthTimeoutMs: Number(process.env.OI_HEALTH_TIMEOUT_MS ?? 3_000),
  /** collect:ui 启动时自动拉起并守护 oi_mornitor（默认开） */
  oiAutoStart: !["0", "false", "no", "off"].includes(
    String(process.env.OI_AUTO_START ?? "1").toLowerCase()
  ),
  oiSupervisorIntervalMs: Number(process.env.OI_SUPERVISOR_INTERVAL_MS ?? 15_000),
  /** 图文内容板（Python SQLite content_board） */
  contentBoardBaseUrl: (process.env.CONTENT_BOARD_BASE_URL ?? "http://127.0.0.1:8767").replace(
    /\/$/,
    ""
  ),
  contentBoardAutoStart: !["0", "false", "no", "off"].includes(
    String(process.env.CONTENT_BOARD_AUTO_START ?? "1").toLowerCase()
  ),
  contentBoardSupervisorIntervalMs: Number(
    process.env.CONTENT_BOARD_SUPERVISOR_INTERVAL_MS ?? 20_000
  ),
  /** 源频道 → Webhook 转发映射 JSON（见 config/channel-webhook-forwards.json） */
  webhookForwardsFile: (process.env.DISCORD_WEBHOOK_FORWARDS_FILE ?? "").trim()
    ? path.resolve(process.env.DISCORD_WEBHOOK_FORWARDS_FILE.trim())
    : path.join(_collectorRoot, "config", "channel-webhook-forwards.json"),
  webhookForwardTimeoutMs: Number(process.env.DISCORD_WEBHOOK_FORWARD_TIMEOUT_MS ?? 15_000),
  /** Node 发 Discord Webhook 用的 HTTP(S) 代理，需与 Chrome 一致，如 http://127.0.0.1:7890 */
  webhookForwardProxy: envProxy("DISCORD_WEBHOOK_PROXY", "COMMON_PROXY", "HTTPS_PROXY", "HTTP_PROXY"),
  /** Bitget 合约自动下单（密钥仅来自环境变量） */
  bitgetEnabled: !["0", "false", "no", "off"].includes(String(process.env.BITGET_ENABLED ?? "0").toLowerCase()),
  bitgetDryRun: !["0", "false", "no", "off"].includes(String(process.env.BITGET_DRY_RUN ?? "1").toLowerCase()),
  bitgetApiKey: (process.env.BITGET_API_KEY ?? "").trim(),
  bitgetApiSecret: (process.env.BITGET_API_SECRET ?? "").trim(),
  bitgetPassphrase: (process.env.BITGET_PASSPHRASE ?? "").trim(),
  bitgetBaseUrl: (process.env.BITGET_BASE_URL ?? "https://api.bitget.com").trim(),
  bitgetRequestTimeoutMs: Number(process.env.BITGET_REQUEST_TIMEOUT_MS ?? 15_000),
  /** Bitget API 代理（国内直连常失败；默认 COMMON_PROXY） */
  bitgetProxy: envProxy("BITGET_PROXY", "COMMON_PROXY", "DISCORD_WEBHOOK_PROXY", "HTTPS_PROXY", "HTTP_PROXY"),
  /** 非空时仅这些频道触发下单（否则读 JSON channels） */
  bitgetAutoTradeChannelIds: parseIdList(process.env.BITGET_AUTO_TRADE_CHANNEL_IDS ?? ""),
  bitgetDefaultLeverage: Number(process.env.BITGET_DEFAULT_LEVERAGE ?? 30),
  bitgetOrderSizeUsdt: Number(process.env.BITGET_ORDER_SIZE_USDT ?? 1),
  bitgetMajorLeverage: Number(process.env.BITGET_MAJOR_LEVERAGE ?? 100),
  bitgetAltcoinLeverage: Number(process.env.BITGET_ALTCOIN_LEVERAGE ?? 30),
  bitgetInitialSlPct: Number(process.env.BITGET_INITIAL_SL_PCT ?? 4.3),
  bitgetTradeConfigFile: (process.env.BITGET_TRADE_CONFIG_FILE ?? "").trim()
    ? path.resolve(process.env.BITGET_TRADE_CONFIG_FILE.trim())
    : path.join(_collectorRoot, "config", "bitget-trade-channels.json"),
  /** WEEX 合约自动下单（交易参数默认与 Bitget 共用 BITGET_*） */
  weexEnabled: !["0", "false", "no", "off"].includes(String(process.env.WEEX_ENABLED ?? "0").toLowerCase()),
  weexDryRun: !["0", "false", "no", "off"].includes(
    String(process.env.WEEX_DRY_RUN ?? process.env.BITGET_DRY_RUN ?? "1").toLowerCase()
  ),
  weexApiKey: (process.env.WEEX_API_KEY ?? "").trim(),
  weexApiSecret: (process.env.WEEX_API_SECRET ?? "").trim(),
  weexPassphrase: (process.env.WEEX_PASSPHRASE ?? "").trim(),
  weexBaseUrl: (process.env.WEEX_BASE_URL ?? "https://api-contract.weex.com").trim(),
  weexRequestTimeoutMs: Number(process.env.WEEX_REQUEST_TIMEOUT_MS ?? process.env.BITGET_REQUEST_TIMEOUT_MS ?? 15_000),
  weexProxy: envProxy("WEEX_PROXY", "COMMON_PROXY", "BITGET_PROXY", "DISCORD_WEBHOOK_PROXY", "HTTPS_PROXY", "HTTP_PROXY"),
  weexAutoTradeChannelIds: parseIdList(
    process.env.WEEX_AUTO_TRADE_CHANNEL_IDS ?? process.env.BITGET_AUTO_TRADE_CHANNEL_IDS ?? ""
  ),
  /** 社区数据走本地 SQLite（默认开；与 MySQL 社区表独立） */
  communityUseSqlite: !["0", "false", "no", "off"].includes(
    String(process.env.COMMUNITY_USE_SQLITE ?? "1").toLowerCase()
  ),
  communitySqlitePath: (process.env.COMMUNITY_SQLITE_PATH ?? "").trim()
    ? path.resolve(process.env.COMMUNITY_SQLITE_PATH.trim())
    : path.join(_collectorRoot, "data", "community.sqlite"),
  /** 社区聊天室媒体上传目录 */
  communityChatUploadDir: (process.env.COMMUNITY_CHAT_UPLOAD_DIR ?? "").trim()
    ? path.resolve(process.env.COMMUNITY_CHAT_UPLOAD_DIR.trim())
    : path.join(_collectorRoot, "uploads", "chat"),
  communityChatImageMaxBytes: Number(process.env.COMMUNITY_CHAT_IMAGE_MAX_BYTES ?? 5 * 1024 * 1024),
  communityChatVideoMaxBytes: Number(process.env.COMMUNITY_CHAT_VIDEO_MAX_BYTES ?? 20 * 1024 * 1024),
  /**
   * Google Identity Services Client ID（OAuth 网页客户端）。
   * 用于社区「使用 Google 登录」；留空则仅邮箱密码。
   */
  communityGoogleClientId: (process.env.COMMUNITY_GOOGLE_CLIENT_ID ?? "").trim(),
  /** 邮箱密码注册是否仅允许 Gmail / Googlemail */
  communityEmailRequireGoogleMail: ["1", "true", "yes", "on"].includes(
    String(process.env.COMMUNITY_EMAIL_REQUIRE_GOOGLE_MAIL ?? "0").toLowerCase()
  ),
  /** 公共聊天粘贴 URL 时抓取 og/meta 预览 */
  communityLinkPreviewEnabled: !["0", "false", "no", "off"].includes(
    String(process.env.COMMUNITY_LINK_PREVIEW ?? "1").toLowerCase()
  ),
  communityLinkPreviewTimeoutMs: Math.min(
    15_000,
    Math.max(2_000, Number(process.env.COMMUNITY_LINK_PREVIEW_TIMEOUT_MS ?? 6_000) || 6_000)
  ),
  communityLinkPreviewMaxBytes: Math.min(
    2 * 1024 * 1024,
    Math.max(64 * 1024, Number(process.env.COMMUNITY_LINK_PREVIEW_MAX_BYTES ?? 512 * 1024) || 512 * 1024)
  ),
  /**
   * 本地 CDP 抓取已登录 X/Twitter 列表最新帖（默认端口 9222，可改 9223）。
   * 列表：逗号分隔的 listId 或 https://x.com/i/lists/{id}
   */
  twitterCdpEnabled: !["0", "false", "no", "off"].includes(
    String(process.env.TWITTER_CDP_ENABLED ?? "1").toLowerCase()
  ),
  twitterCdpPort: Number(process.env.TWITTER_CDP_PORT ?? 9222) || 9222,
  twitterCdpHost: (process.env.TWITTER_CDP_HOST ?? "127.0.0.1").trim() || "127.0.0.1",
  twitterCdpIntervalMs: Math.max(
    30_000,
    Number(process.env.TWITTER_CDP_INTERVAL_MS ?? 120_000) || 120_000
  ),
  twitterCdpTelegram: !["0", "false", "no", "off"].includes(
    String(process.env.TWITTER_CDP_TELEGRAM ?? "1").toLowerCase()
  ),
  twitterCdpLists: parseIdList(process.env.TWITTER_CDP_LISTS ?? ""),
  twitterCdpMaxPerList: Math.min(50, Math.max(5, Number(process.env.TWITTER_CDP_MAX_PER_LIST ?? 20) || 20)),
};
