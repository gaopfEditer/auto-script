/**
 * OI → Telegram 形态推送回测：解析 alert、组 signals、一键 validate。
 */
import { requireLocalRequest } from "./local-request.js";
import { requireOpenApiKey } from "./card-archive-api.js";
import { createLogger } from "./logger.js";
import { config } from "./config.js";
import {
  getTelegramOiRollingSpec,
  oiAlertToBacktestSignal,
  parseOiTelegramAlerts,
  telegramOiBacktestTierLabel,
} from "./card-telegram-oi-backtest.js";

const log = createLogger("oi-tg-backtest");

/**
 * @param {import("express").Express} app
 * @param {ReturnType<typeof import("./card-validate-api.js").createCardValidateRunner>} validateRunner
 * @param {{ requireOpenApiKey?: import("express").RequestHandler }} [deps]
 */
export function registerOiTelegramBacktestRoutes(app, validateRunner, deps = {}) {
  const openAuth = deps.requireOpenApiKey ?? requireOpenApiKey;

  function policyHandler(_req, res) {
    res.json({
      ok: true,
      backtestPolicy: "telegram_oi",
      note: "OI 形态/结构 Telegram 推送回测；阈值按价格涨跌幅 %",
      major: getTelegramOiRollingSpec("major"),
      altcoin: getTelegramOiRollingSpec("altcoin"),
      labels: {
        major: telegramOiBacktestTierLabel("major"),
        altcoin: telegramOiBacktestTierLabel("altcoin"),
      },
      env: {
        TG_SIGNAL_BACKTEST_MAJOR_STEP_PCT: config.tgSignalBacktestMajorStepPct,
        TG_SIGNAL_BACKTEST_MAJOR_INITIAL_H: config.tgSignalBacktestMajorInitialH,
        TG_SIGNAL_BACKTEST_ALT_STEP_PCT: config.tgSignalBacktestAltStepPct,
        TG_SIGNAL_BACKTEST_ALT_INITIAL_H: config.tgSignalBacktestAltInitialH,
        TG_SIGNAL_BACKTEST_ALT_EXTEND_H: config.tgSignalBacktestAltExtendH,
        TG_SIGNAL_BACKTEST_MAX_H: config.tgSignalBacktestMaxH,
      },
      validate: {
        endpoint: "/api/v1/cards/validate",
        bodyExample: {
          backtestPolicy: "telegram_oi",
          signals: [
            {
              symbol: "BTC",
              direction: "long",
              signalAt: "2026-08-21T10:00:00.000Z",
              price: 95000,
              side: "bull",
              interval: "15m",
            },
          ],
        },
      },
      telegramChatIds: {
        candle: process.env.OI_CANDLE_CARD_TELEGRAM_CHAT_ID ?? "",
        main: process.env.MAIN_CARD_TELEGRAM_CHAT_ID ?? "",
      },
    });
  }

  function parseHandler(req, res) {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      const raw = body.alerts ?? body.signals ?? body.items ?? [];
      const signals = parseOiTelegramAlerts(raw);
      if (!signals.length) {
        res.status(400).json({
          ok: false,
          error: "alerts[] 为空或字段不足（需 symbol、side/kline_open_time 或 signalAt）",
        });
        return;
      }
      res.json({
        ok: true,
        count: signals.length,
        backtestPolicy: "telegram_oi",
        signals,
        hint: "POST /api/v1/cards/validate { backtestPolicy: 'telegram_oi', signals }",
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  }

  async function runHandler(req, res) {
    try {
      const body = req.body && typeof req.body === "object" ? req.body : {};
      let signals = parseOiTelegramAlerts(body.alerts ?? body.signals ?? []);
      if (!signals.length && Array.isArray(body.items)) {
        signals = body.items
          .map((row, i) => oiAlertToBacktestSignal(row, i))
          .filter(Boolean);
      }
      if (!signals.length) {
        res.status(400).json({
          ok: false,
          error: "请传 alerts[] 或 signals[]（OI 形态 alert 或标准 signal）",
        });
        return;
      }
      const job = validateRunner.startJob({
        signals,
        backtestPolicy: "telegram_oi",
        mock: false,
        persist: false,
      });
      log.info(`OI TG 回测 jobId=${job.id} n=${signals.length}`);
      res.status(202).json({
        ok: true,
        jobId: job.id,
        status: job.status,
        backtestPolicy: "telegram_oi",
        signalCount: signals.length,
        poll: `/api/v1/cards/validate/${job.id}`,
        ws: { path: "/ws", channel: "meta", events: ["card_validate_*"] },
      });
    } catch (e) {
      res.status(500).json({ ok: false, error: String(/** @type {Error} */ (e).message ?? e) });
    }
  }

  app.get("/api/oi/telegram/backtest/policy", requireLocalRequest, policyHandler);
  app.get("/api/v1/oi/telegram/backtest/policy", openAuth, policyHandler);
  app.post("/api/oi/telegram/backtest/parse", requireLocalRequest, parseHandler);
  app.post("/api/v1/oi/telegram/backtest/parse", openAuth, parseHandler);
  app.post("/api/oi/telegram/backtest", requireLocalRequest, runHandler);
  app.post("/api/v1/oi/telegram/backtest", openAuth, runHandler);
}
