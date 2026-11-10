import { describe, it } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import {
  isCdpSendChannel,
  isPlaceAnOrderChannel,
  isTelegramGroupChatId,
  readTelegramChannelProfiles,
} from "./telegram-channel-profiles.js";
import { isTelegramAutoTradeChannel, TELEGRAM_TRADE_INITIAL_SL_PCT, TELEGRAM_TRADE_LEVERAGE } from "./telegram-auto-trade.js";
import {
  getAutoTradeChannelIds,
  getTradeOrderSizeUsdt,
  isAutoTradeChannel,
  isAutoTradeExcludedMajorSymbol,
  setTradeOrderSizeUsdt,
} from "./trade-platform-toggles.js";
import { resolveChannelBitgetTrade } from "./bitget-trade-config.js";
import { classifyWeexAutoTradeChannel } from "./weex-trade-config.js";

const PLACE_AN_ORDER = [
  "-1001720924085",
  "-1003962150986",
  "-1001908181865",
  "-1002404948215",
  "-1001766481463",
  "-1002355647897",
  "-1003938902957",
];

const SEND_ONLY = "-1004346465376";
const DISCORD_ENV = ["1444963372134301827", "1444963506431463474"];
const EXAMPLE = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "..",
  "telegram",
  "channel_profiles.example.json"
);

/** @type {import("./bitget-trade-config.js").BitgetTradeConfig} */
function tradeCfg() {
  return {
    enabled: true,
    dryRun: true,
    default: {
      marginMode: "crossed",
      leverage: 30,
      orderSizeUsdt: 9,
      orderType: "limit",
      productType: "USDT-FUTURES",
      stagedTrade: false,
      initialSlPct: 4.3,
      tpPartialRatios: [0.3, 0.3, 1],
    },
    channels: {
      [SEND_ONLY]: { enabled: true, leverage: 50, name: "should-not-apply" },
    },
  };
}

describe("telegram placeAnOrder gate", { concurrency: 1 }, () => {
  it("示例文件保留用户列出的 placeAnOrder，且不删掉无关键", () => {
    const raw = JSON.parse(fs.readFileSync(EXAMPLE, "utf8"));
    assert.deepEqual(raw.placeAnOrder, PLACE_AN_ORDER);
    assert.ok(raw.send.includes(SEND_ONLY));
    assert.equal(raw["-1001766481463"].avatar, "avatar/1001766481463.png");
    assert.equal(raw["-1002666021235"].name, "Ashley的旺財情報局");

    const parsed = readTelegramChannelProfiles(EXAMPLE);
    assert.equal(parsed.ok, true);
    assert.deepEqual(parsed.placeAnOrderChatIds, PLACE_AN_ORDER);
    assert.ok(parsed.channels.some((c) => c.chatId === "-1002666021235"));
    assert.equal(parsed.channels.some((c) => c.chatId === "placeAnOrder"), false);
  });

  it("placeAnOrder 群可以下单；只在 send 里的群不行", () => {
    const allowed = "-1001720924085";
    assert.equal(isPlaceAnOrderChannel(allowed, EXAMPLE), true);
    assert.equal(isTelegramAutoTradeChannel(allowed, EXAMPLE), true);
    assert.equal(isAutoTradeChannel(allowed, { profilesFile: EXAMPLE, discordChannelIds: [] }), true);
    assert.equal(isCdpSendChannel(allowed, EXAMPLE), true);

    const orderOnly = "-1002404948215";
    assert.equal(isTelegramAutoTradeChannel(orderOnly, EXAMPLE), true);
    assert.equal(isCdpSendChannel(orderOnly, EXAMPLE), false);

    assert.equal(isCdpSendChannel(SEND_ONLY, EXAMPLE), true);
    assert.equal(isPlaceAnOrderChannel(SEND_ONLY, EXAMPLE), false);
    assert.equal(isTelegramAutoTradeChannel(SEND_ONLY, EXAMPLE), false);
    assert.equal(
      isAutoTradeChannel(SEND_ONLY, { profilesFile: EXAMPLE, discordChannelIds: [] }),
      false
    );
  });

  it("比较 id 时保留 -100 前缀", () => {
    const full = "-1001720924085";
    assert.equal(isPlaceAnOrderChannel(full, EXAMPLE), true);
    assert.equal(isPlaceAnOrderChannel("1001720924085", EXAMPLE), false);
    assert.equal(isPlaceAnOrderChannel("-1720924085", EXAMPLE), false);
    assert.equal(isTelegramGroupChatId(full), true);
    assert.equal(isTelegramGroupChatId("1001720924085"), false);
    assert.equal(isTelegramGroupChatId(DISCORD_ENV[0]), false);
  });

  it("BITGET_AUTO_TRADE_CHANNEL_IDS 单独不能授权 Telegram 群", () => {
    const envIds = [SEND_ONLY, ...DISCORD_ENV];
    assert.equal(
      isAutoTradeChannel(SEND_ONLY, { profilesFile: EXAMPLE, discordChannelIds: envIds }),
      false
    );
    assert.equal(
      isAutoTradeChannel("-1003938902957", { profilesFile: EXAMPLE, discordChannelIds: [] }),
      true
    );
    assert.equal(isAutoTradeChannel(DISCORD_ENV[0], { discordChannelIds: DISCORD_ENV }), true);
    assert.equal(isAutoTradeChannel(DISCORD_ENV[1], { discordChannelIds: [DISCORD_ENV[0]] }), false);

    const ids = getAutoTradeChannelIds({
      profilesFile: EXAMPLE,
      discordChannelIds: envIds,
    });
    assert.equal(ids.includes(DISCORD_ENV[0]), true);
    assert.equal(ids.includes(DISCORD_ENV[1]), true);
    assert.equal(ids.includes(SEND_ONLY), false);
    for (const id of PLACE_AN_ORDER) assert.equal(ids.includes(id), true);
  });

  it("Bitget / WEEX 的 Discord 白名单不放行、也不拦截 placeAnOrder 群", () => {
    setTradeOrderSizeUsdt(1);
    assert.equal(getTradeOrderSizeUsdt(), 1);

    const prevBitget = config.bitgetAutoTradeChannelIds;
    config.bitgetAutoTradeChannelIds = [SEND_ONLY, ...DISCORD_ENV];
    try {
      const allowed = resolveChannelBitgetTrade("-1001720924085", tradeCfg(), EXAMPLE);
      assert.ok(allowed);
      assert.equal(allowed.channel.leverage, TELEGRAM_TRADE_LEVERAGE);
      assert.equal(allowed.channel.orderSizeUsdt, 1);
      assert.equal(allowed.channel.initialSlPct, TELEGRAM_TRADE_INITIAL_SL_PCT);
      assert.equal(allowed.channel.orderType, "market");
      assert.equal(allowed.channel.stagedTrade, true);

      assert.equal(resolveChannelBitgetTrade(SEND_ONLY, tradeCfg(), EXAMPLE), null);
      assert.equal(resolveChannelBitgetTrade("1001720924085", tradeCfg(), EXAMPLE), null);

      const discord = resolveChannelBitgetTrade(DISCORD_ENV[0], tradeCfg(), EXAMPLE);
      assert.ok(discord);
      assert.equal(discord.channel.leverage, 30);
      assert.equal(discord.channel.orderType, "limit");
      assert.notEqual(discord.channel.name, "telegram");
    } finally {
      config.bitgetAutoTradeChannelIds = prevBitget;
    }

    assert.equal(
      classifyWeexAutoTradeChannel("-1001720924085", DISCORD_ENV, EXAMPLE),
      "telegram"
    );
    assert.equal(
      classifyWeexAutoTradeChannel(SEND_ONLY, [SEND_ONLY, ...DISCORD_ENV], EXAMPLE),
      "reject"
    );
    assert.equal(classifyWeexAutoTradeChannel(DISCORD_ENV[0], DISCORD_ENV, EXAMPLE), "discord");
    assert.equal(classifyWeexAutoTradeChannel("1444963405185159238", DISCORD_ENV, EXAMPLE), "reject");
  });

  it("数字形式的 -100 id 仍按带负号的字符串比较", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "place-an-order-"));
    const file = path.join(dir, "channel_profiles.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        send: ["-1001111111111"],
        placeAnOrder: [-1002404948215],
        "-1001111111111": { name: "send-only" },
      })
    );
    try {
      const parsed = readTelegramChannelProfiles(file);
      assert.deepEqual(parsed.placeAnOrderChatIds, ["-1002404948215"]);
      assert.equal(isTelegramAutoTradeChannel("-1002404948215", file), true);
      assert.equal(isTelegramAutoTradeChannel("-1001111111111", file), false);
      assert.equal(isCdpSendChannel("-1001111111111", file), true);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("BTC / ETH 仍排除在自动交易之外", () => {
    assert.equal(isAutoTradeExcludedMajorSymbol("BTC"), true);
    assert.equal(isAutoTradeExcludedMajorSymbol("ETHUSDT"), true);
    assert.equal(isAutoTradeExcludedMajorSymbol("SOL"), false);
  });
});
