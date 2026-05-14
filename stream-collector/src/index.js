#!/usr/bin/env node
/**
 * 入口：collect = CDP 监听 + 落库；replay = 顺序回放。
 */
import "dotenv/config";
import { config } from "./config.js";
import { startCdpWebSocketMonitor } from "./cdp-ws-monitor.js";
import { createLogger, setLogLevel } from "./logger.js";
import { processBuffer } from "./processor.js";
import { hashBuffer, openStore } from "./store.js";
import { runReplayScheduler } from "./replay-scheduler.js";

setLogLevel(config.logLevel);
const log = createLogger("index");

const mode = process.argv.includes("--mode=replay") ? "replay" : "collect";
const durationArg = process.argv.find((a) => a.startsWith("--duration="));
const durationSec = durationArg ? Number(durationArg.split("=")[1]) : 0;

let frameCount = 0;
let insertOk = 0;
let insertDup = 0;
let insertErr = 0;

async function collect() {
  if (config.collectStartUsedTargetFallback) {
    log.info(
      `COLLECTOR_START_URL 未设或为 about:blank，无头 collect 已改用 TARGET_PAGE_URL → ${config.startUrl}`
    );
  }
  log.info(
    `启动 collect | MySQL ${config.mysql.host}:${config.mysql.port}/${config.mysql.database} | 页面 ${config.startUrl} | 网络诊断=${config.collectNetworkTrace ? "开" : "关"} | LOG_LEVEL=${config.logLevel}`
  );
  if (config.cdpConnectUrl) {
    log.info(
      `附加模式: CDP_CONNECT_URL=${config.cdpConnectUrl} — 监听「该 Chrome 实例」内各标签页的 WS；请在该浏览器中打开/刷新 ${config.startUrl}`
    );
  } else {
    log.info(
      "无头模式: Playwright 自启 Chromium 并打开 COLLECTOR_START_URL。要采本机已登录的页面，请改用 CDP_CONNECT_URL（Chrome 带 --remote-debugging-port）并在该浏览器里打开目标页。"
    );
    if ((config.startUrl ?? "").trim() === "about:blank") {
      log.info(
        "当前 COLLECTOR_START_URL=about:blank，页面本身不会产生 WS；无头采集请把该变量改成含 WebSocket 的 https 地址，或配置 CDP_CONNECT_URL 走附加模式。"
      );
    }
  }

  const store = await openStore(config.mysql, createLogger("store"));

  const session = await startCdpWebSocketMonitor(
    {
      startUrl: config.startUrl,
      cdpConnectUrl: config.cdpConnectUrl,
      pageReloadIntervalMs: config.pageReloadIntervalMs,
      networkTrace: config.collectNetworkTrace,
      onData(buf, meta) {
        frameCount += 1;
        if (meta.pageUrl) {
          log.debug(`帧 #${frameCount} 来自页面: ${meta.pageUrl}`);
        }
        const hash = hashBuffer(buf);
        const proc = processBuffer(buf, config.requiredTopLevelKeys);
        if (!proc.ok) {
          log.debug(
            `帧 #${frameCount} 解析未入库 schema | opcode=${meta.opcode} len=${buf.length} hash=${hash.slice(0, 12)}… | ${proc.parseError}`
          );
        }
        void store
          .insertFrame({
            receivedAt: proc.receivedAt,
            payloadHash: hash,
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
          .catch((err) => {
            insertErr += 1;
            log.error(`MySQL 写入失败: ${err.message}`, err.code ? `(code=${err.code})` : "");
          });
      },
    },
    createLogger("cdp")
  );

  const shutdown = async (reason = "shutdown") => {
    log.info(
      `结束 (${reason}) | CDP 收到帧=${frameCount} | 新插入=${insertOk} | 去重跳过=${insertDup} | 写入错误=${insertErr}`
    );
    await session.close().catch((e) => log.warn(`关闭 CDP 会话: ${e.message}`));
    await store.close().catch((e) => log.warn(`关闭 MySQL 池: ${e.message}`));
    process.exit(0);
  };

  log.info("CDP 已连接，监听 WebSocket 帧中…");
  if (durationSec > 0) {
    log.info(`${durationSec}s 后自动退出`);
    setTimeout(() => {
      void shutdown("duration");
    }, durationSec * 1000);
  } else {
    log.info("按 Ctrl+C 结束");
  }

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

async function replay() {
  log.info(`启动 replay | LOG_LEVEL=${config.logLevel}`);

  const t0 = Date.now();
  const store = await openStore(config.mysql, createLogger("store"));
  const rows = await store.getReplayRows();
  const normalized = rows.map((r) => ({
    id: r.id,
    received_at:
      r.received_at instanceof Date ? r.received_at.toISOString() : String(r.received_at),
    parsed_json: typeof r.parsed_json === "string" ? r.parsed_json : JSON.stringify(r.parsed_json),
  }));
  log.info(`待回放 ${normalized.length} 条（parsed_json 非空）`);

  let played = 0;
  await runReplayScheduler({
    rows: normalized,
    baseDelayMs: config.replayBaseDelayMs,
    speedMultiplier: config.replaySpeedMultiplier,
    onProgress: (current, total) => {
      if (current === 1 || current === total || current % 100 === 0) {
        log.info(`回放进度 ${current}/${total}`);
      }
    },
    async onFrame(obj, meta) {
      played += 1;
      const line = JSON.stringify({ meta, event: obj });
      log.debug(line);
      const dbg = String(config.logLevel).toLowerCase() === "debug";
      if (!dbg && (played <= 3 || played > normalized.length - 3)) {
        log.info(`样例: ${line}`);
      }
    },
  });

  await store.close();
  const ms = Date.now() - t0;
  log.info(`回放完成 | 共 ${played} 条 | 耗时 ${ms}ms`);
}

if (mode === "replay") {
  replay().catch((e) => {
    log.error(String(e?.stack ?? e));
    process.exit(1);
  });
} else {
  collect().catch((e) => {
    log.error(String(e?.stack ?? e));
    process.exit(1);
  });
}
