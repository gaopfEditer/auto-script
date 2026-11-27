import assert from "node:assert/strict";
import { describe, it } from "node:test";

import {
  buildPlazaBotWebhookText,
  resetPlazaBotWebhookStateForTest,
  shouldPlazaNotifySignalCard,
} from "./plaza-bot-webhook.js";
import { loadPlazaBotWebhookConfig } from "./plaza-bot-webhook-config.js";

describe("plaza-bot-webhook", () => {
  it("本地配置文件可读且 enabled", () => {
    const cfg = loadPlazaBotWebhookConfig();
    assert.equal(typeof cfg.enabled, "boolean");
    if (cfg.enabled) {
      assert.match(String(cfg.url ?? ""), /^http/);
      assert.ok(String(cfg.authorization_bearer ?? "").length > 8);
    }
  });

  it("KOLVIP 来源应通知", () => {
    resetPlazaBotWebhookStateForTest();
    const ok = shouldPlazaNotifySignalCard({
      id: 1,
      channelId: "kolvip-scan-33",
      symbol: "XAUUSDT",
      source: "kolvip_api",
      execution: { direction: "做空", planned: { entryPrice: "3568" } },
    });
    assert.equal(ok, true);
  });

  it("正文含来源与四行", () => {
    const text = buildPlazaBotWebhookText(
      {
        id: 99,
        channelId: "kolvip-scan-31",
        symbol: "XAUUSDT",
        signalAt: "2026-11-25T03:13:58.000Z",
        source: "kolvip_api",
        execution: { direction: "做空", planned: { entryPrice: "3568" } },
      },
      { channelName: "FX-黄金信号" },
    );
    assert.match(text, /新交易信号卡 #99/);
    assert.match(text, /KOLVIP·FX-黄金信号/);
    assert.match(text, /币种：#XAUUSDT/);
    assert.match(text, /入场：/);
  });
});