#!/usr/bin/env node
/**
 * 入口：collect = CDP 监听 Discord 网页 Gateway/API + 可选落库。
 */
import "./load-env.js";
import { buildFrameChannelPayload } from "./collect-ws-decode.js";
import { config } from "./config.js";
import { setDebugMode } from "./discord-debug.js";
import { startCdpWebSocketMonitor } from "./cdp-ws-monitor.js";
import { createDiscordMessageIngest } from "./discord-message-ingest.js";
import { createDiscordTelegramMessagePush } from "./discord-telegram-message-push.js";
import { createDiscordWebhookForward } from "./discord-webhook-forward.js";
import { createSystemTelegramAlert } from "./discord-system-telegram.js";
import { createLogger, setLogLevel } from "./logger.js";
import { hashBuffer, openStore } from "./store.js";

setLogLevel(config.logLevel);
setDebugMode(config.debugMode);
const log = createLogger("index");

const mode = process.argv.includes("--mode=replay") ? "replay" : "collect";

let frameCount = 0;
let insertOk = 0;
let insertDup = 0;

async function collect() {
  log.info(
    `启动 discord-collector | MySQL ${config.mysql.host}:${config.mysql.port}/${config.mysql.database} | 页面 ${config.startUrl}`
  );
  if (config.cdpConnectUrl) {
    log.info(
      `附加模式: CDP_CONNECT_URL=${config.cdpConnectUrl} — 请在 Chrome 中打开/刷新 Discord 网页并登录`
    );
  } else {
    log.info("无 CDP：Playwright 将自启 Chromium 打开 COLLECTOR_START_URL（需手动登录 Discord）");
  }

  const store = await openStore(config.mysql, createLogger("store"));
  const telegramPush = createDiscordTelegramMessagePush(createLogger("telegram-push"));
  const webhookForward = createDiscordWebhookForward(createLogger("webhook-forward"));
  const systemTelegram = createSystemTelegramAlert(createLogger("system-telegram"));
  const discordIngest = createDiscordMessageIngest(store, createLogger("discord-ingest"), undefined, {
    telegramPush,
    webhookForward,
  });

  const session = await startCdpWebSocketMonitor(
    {
      startUrl: config.startUrl,
      cdpConnectUrl: config.cdpConnectUrl,
      pageReloadIntervalMs: config.pageReloadIntervalMs,
      networkTrace: config.collectNetworkTrace,
      wsFrameTrace: config.collectWsFrameTrace,
      diagnosticSink: (evt) => {
        void discordIngest.onDiag(evt).catch((e) => {
          log.debug(`discord ingest diag: ${/** @type {Error} */ (e).message}`);
        });
      },
      onConnectionLost: (info) => systemTelegram.notifyCdpDisconnected(info),
      onData(buf, meta) {
        frameCount += 1;
        const { payload, proc } = buildFrameChannelPayload(
          buf,
          meta,
          frameCount,
          config.requiredTopLevelKeys
        );
        void discordIngest.onWsFrame(payload).catch((e) => {
          log.debug(`discord ingest ws: ${/** @type {Error} */ (e).message}`);
        });
        void store
          .insertFrame({
            receivedAt: proc.receivedAt,
            payloadHash: hashBuffer(buf),
            opcode: meta.opcode,
            requestId: meta.requestId || null,
            rawPayload: buf,
            parsedJson: proc.ok ? proc.parsedJson : null,
            parseError: proc.ok ? null : proc.parseError,
          })
          .then((r) => {
            if (r.inserted) insertOk += 1;
            else if (r.duplicate) insertDup += 1;
          })
          .catch((err) => log.error(`MySQL 写入失败: ${err.message}`));
      },
    },
    createLogger("cdp")
  );

  const shutdown = async (reason = "shutdown") => {
    log.info(
      `结束 (${reason}) | 帧=${frameCount} | 新插入=${insertOk} | 去重=${insertDup}`
    );
    await telegramPush.flushAll().catch((e) => log.warn(String(e?.message ?? e)));
    await session.close().catch((e) => log.warn(String(e?.message ?? e)));
    await store.close().catch((e) => log.warn(String(e?.message ?? e)));
    process.exit(0);
  };

  log.info("CDP 已连接，监听 Discord Gateway WebSocket 与 API …");
  log.info("按 Ctrl+C 结束");

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

if (mode === "replay") {
  log.error("discord-collector 暂未实现 replay 模式");
  process.exit(1);
} else {
  collect().catch((e) => {
    log.error(String(e?.stack ?? e));
    process.exit(1);
  });
}
