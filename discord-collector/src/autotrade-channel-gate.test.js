import { describe, it } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { config } from "./config.js";
import {
  getAutoTradeChannelIds,
  getTradeOrderSizeUsdt,
  isAutoTradeChannel,
  shouldPushToTradePlatform,
} from "./trade-platform-toggles.js";
import { resolveChannelBitgetTrade, loadBitgetTradeConfig } from "./bitget-trade-config.js";
import {
  defaultKolvipBitgetAutotradePath,
  listKolvipAutotradeChannelIds,
  resolveKolvipBitgetPolicy,
} from "./kolvip-bitget-autotrade.js";
import { classifyWeexAutoTradeChannel } from "./weex-trade-config.js";

const EXAMPLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "telegram",
  "channel_profiles.example.json"
);

/** seven / 山寨之王：保留在 BITGET_AUTO_TRADE_CHANNEL_IDS 的常见 Discord 白名单 */
const DISCORD_ENV = ["1444963372134301827", "1444963506431463474"];

const KOLVIP_CHANNELS = [
  { id: "kolvip-scan-39", name: "华尔街女王" },
  { id: "kolvip-scan-13", name: "零下二度VIP禁言群" },
  { id: "kolvip-scan-33", name: "kacang-团队" },
  { id: "kolvip-scan-31", name: "FX-黄金信号" },
  { id: "kolvip-scan-37", name: "币安杀手" },
  { id: "kolvip-scan-27", name: "熬鹰" },
];

const TELEGRAM_AUTO_TRADE = [
  { id: "-1001720924085", name: "Leo-加密貨幣頻道" },
  { id: "-1003962150986", name: "熊貓說交易" },
  { id: "-1001766481463", name: "砸锅卖铁去炒币" },
  { id: "-1002355647897", name: "[KAI]的幣圈策略分享" },
  { id: "-1003938902957", name: "Nine Call" },
];

describe("autotrade channel gate", { concurrency: 1 }, () => {
  it("kolvip-autotrade.json 列出用户要求的 KOLVIP 频道 id", () => {
    const ids = listKolvipAutotradeChannelIds();
    for (const ch of KOLVIP_CHANNELS) {
      assert.equal(ids.includes(ch.id), true, `缺少 ${ch.name} (${ch.id})`);
    }
  });

  it("isAutoTradeChannel：仅 env 有 seven/山寨时仍放行 kolvip 虚拟频道", () => {
    const prev = config.bitgetAutoTradeChannelIds;
    config.bitgetAutoTradeChannelIds = [...DISCORD_ENV];
    try {
      for (const ch of DISCORD_ENV) {
        assert.equal(isAutoTradeChannel(ch, { discordChannelIds: DISCORD_ENV }), true);
      }
      for (const ch of KOLVIP_CHANNELS) {
        assert.equal(
          isAutoTradeChannel(ch.id, { discordChannelIds: DISCORD_ENV, profilesFile: EXAMPLE }),
          true,
          `${ch.name} 应通过门禁`
        );
      }
      assert.equal(isAutoTradeChannel("999999999999999999", { discordChannelIds: DISCORD_ENV }), false);
    } finally {
      config.bitgetAutoTradeChannelIds = prev;
    }
  });

  it("getAutoTradeChannelIds 与 isAutoTradeChannel 均包含 kolvip + Telegram placeAnOrder", () => {
    const ids = getAutoTradeChannelIds({ profilesFile: EXAMPLE, discordChannelIds: DISCORD_ENV });
    for (const ch of KOLVIP_CHANNELS) assert.equal(ids.includes(ch.id), true);
    for (const ch of TELEGRAM_AUTO_TRADE) assert.equal(ids.includes(ch.id), true);
    for (const ch of DISCORD_ENV) assert.equal(ids.includes(ch), true);
  });

  it("shouldPushToTradePlatform 在 BITGET/WEEX_ENABLED 打开时放行上述频道", () => {
    const prevB = config.bitgetEnabled;
    const prevW = config.weexEnabled;
    const prevIds = config.bitgetAutoTradeChannelIds;
    config.bitgetEnabled = true;
    config.weexEnabled = true;
    config.bitgetAutoTradeChannelIds = [...DISCORD_ENV];
    try {
      const baseOpts = {
        tradePlatforms: { bitget: true, weex: true },
        profilesFile: EXAMPLE,
        discordChannelIds: DISCORD_ENV,
      };
      for (const ch of KOLVIP_CHANNELS) {
        assert.equal(shouldPushToTradePlatform("bitget", ch.id, baseOpts), true, ch.name);
        assert.equal(shouldPushToTradePlatform("weex", ch.id, baseOpts), true, ch.name);
      }
      for (const ch of TELEGRAM_AUTO_TRADE) {
        assert.equal(shouldPushToTradePlatform("bitget", ch.id, baseOpts), true, ch.name);
        assert.equal(shouldPushToTradePlatform("weex", ch.id, baseOpts), true, ch.name);
      }
      config.bitgetEnabled = false;
      assert.equal(shouldPushToTradePlatform("bitget", KOLVIP_CHANNELS[0].id, baseOpts), false);
    } finally {
      config.bitgetEnabled = prevB;
      config.weexEnabled = prevW;
      config.bitgetAutoTradeChannelIds = prevIds;
    }
  });

  it("KOLVIP 策略保证金统一为 2 USDT", () => {
    const cfgPath = defaultKolvipBitgetAutotradePath();
    for (const ch of KOLVIP_CHANNELS) {
      const pol = resolveKolvipBitgetPolicy(ch.id, ch.name);
      assert.ok(pol, ch.name);
      assert.equal(pol.orderSizeUsdt, 2, `${ch.name} orderSizeUsdt`);
    }
    const cfg = loadBitgetTradeConfig();
    assert.equal(cfg.default.orderSizeUsdt, 2);
    assert.equal(getTradeOrderSizeUsdt(), 2);
  });

  it("resolveChannelBitgetTrade 在 env 仅 seven/山寨 时仍解析 kolvip 频道", () => {
    const prev = config.bitgetAutoTradeChannelIds;
    config.bitgetAutoTradeChannelIds = [...DISCORD_ENV];
    const tradeCfg = loadBitgetTradeConfig();
    tradeCfg.enabled = true;
    try {
      const huajie = resolveChannelBitgetTrade("kolvip-scan-39", tradeCfg, EXAMPLE, "华尔街女王");
      assert.ok(huajie);
      assert.equal(huajie.channel.orderSizeUsdt, 2);
      assert.equal(huajie.channel.executionTemplate, "track2");
    } finally {
      config.bitgetAutoTradeChannelIds = prev;
    }
  });

  it("classifyWeexAutoTradeChannel 放行 kolvip Discord 频道", () => {
    assert.equal(classifyWeexAutoTradeChannel("kolvip-scan-27", DISCORD_ENV, EXAMPLE), "discord");
    assert.equal(classifyWeexAutoTradeChannel("1444963405185159238", DISCORD_ENV, EXAMPLE), "reject");
  });

  it("BITGET_DRY_RUN=0 时不被 bitget-trade-channels.json 强制模拟", () => {
    const prev = process.env.BITGET_DRY_RUN;
    process.env.BITGET_DRY_RUN = "0";
    try {
      const cfg = loadBitgetTradeConfig();
      assert.equal(cfg.dryRun, false);
    } finally {
      if (prev === undefined) delete process.env.BITGET_DRY_RUN;
      else process.env.BITGET_DRY_RUN = prev;
    }
  });
});