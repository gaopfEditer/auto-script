import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  PANGMAO_SIGNAL_CHANNEL_ID,
  DEFAULT_DISCORD_SIGNAL_OCR_CHANNEL_IDS,
  getDiscordSignalOcrChannelIds,
  isDiscordSignalOcrChannel,
} from "./discord-signal-ocr-config.js";
import {
  extractProfitRatePct,
  parseExchangePosterOcr,
  classifyOcrPoster,
  buildOcrSignalFingerprint,
} from "./discord-signal-ocr-parser.js";
import { createOcrSignalFingerprintDedup } from "./discord-signal-ocr-dedup.js";

/** WEEX ETHUSDT 永续 做多 200x +311.97% 开仓 2258.50（样例晒单） */
const WEEX_SHOW_OFF_OCR = [
  "WEEX",
  "ETHUSDT 永續",
  "做多 | 200x",
  "+311.97%",
  "開倉價格 2,258.50",
  "標記價格 2,293.73",
].join("\n");

describe("Discord 信号 OCR 配置", () => {
  it("默认 OCR 频道含胖猫社区", () => {
    assert.equal(PANGMAO_SIGNAL_CHANNEL_ID, "1562351038277619783");
    assert.deepEqual(DEFAULT_DISCORD_SIGNAL_OCR_CHANNEL_IDS, [PANGMAO_SIGNAL_CHANNEL_ID]);
    assert.equal(isDiscordSignalOcrChannel(PANGMAO_SIGNAL_CHANNEL_ID), true);
    assert.equal(isDiscordSignalOcrChannel("1444962339743989843"), false);
    assert.ok(getDiscordSignalOcrChannelIds().has(PANGMAO_SIGNAL_CHANNEL_ID));
    assert.equal(isDiscordSignalOcrChannel("1444962410002911396"), false);
  });
});

describe("OCR 晒单盈利率与 WEEX 样例", () => {
  it("样例 +311.97% → 晒单（≥66%）", () => {
    assert.equal(extractProfitRatePct(WEEX_SHOW_OFF_OCR), 311.97);
    const c = classifyOcrPoster(WEEX_SHOW_OFF_OCR, 66);
    assert.equal(c.isShowOff, true);
    assert.equal(c.parsed, null);
  });

  it("盈利率低于 66% → 可解析为开仓", () => {
    const text = "ETHUSDT 永续 做多 10x +12.5% 开仓价格 2258.50";
    const c = classifyOcrPoster(text, 66);
    assert.equal(c.isShowOff, false);
    assert.ok(c.parsed);
    assert.equal(c.parsed?.symbol, "ETH");
    assert.equal(c.parsed?.direction, "做多");
    assert.equal(c.parsed?.entry, "2258.50");
    assert.equal(c.parsed?.leverage, "10");
    assert.equal(c.parsed?.signalPhase, "open");
  });

  it("parseExchangePosterOcr 写入 parsed 字段", () => {
    const p = parseExchangePosterOcr(WEEX_SHOW_OFF_OCR);
    assert.ok(p);
    assert.equal(p.symbol, "ETH");
    assert.equal(p.direction, "做多");
    assert.equal(p.leverage, "200");
    assert.equal(p.entry, "2258.50");
  });
});

describe("OCR 开仓指纹 5 分钟去重", () => {
  it("同频道相同指纹在窗口内去重", () => {
    const dedup = createOcrSignalFingerprintDedup(5 * 60_000);
    const fp = buildOcrSignalFingerprint({
      symbol: "ETH",
      direction: "做多",
      entry: "2258.50",
    });
    assert.ok(fp.includes("ETH"));
    const cid = PANGMAO_SIGNAL_CHANNEL_ID;
    assert.equal(dedup.isDuplicate(cid, fp), false);
    dedup.remember(cid, fp);
    assert.equal(dedup.isDuplicate(cid, fp), true);
  });
});
