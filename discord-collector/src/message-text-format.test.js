import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  expandCollapsedSignalText,
  formatMessageTextForDisplay,
  splitBilingualMessageText,
  preferSingleLanguageSignalText,
} from "./message-text-format.js";

describe("message-text-format", () => {
  it("expands Binance-style single line signal", () => {
    const raw =
      "📍SIGNAL ID: #2262📍 COIN: $ADA/USDT ENTRY: 0.1815 TARGETS: 0.1900 STOP LOSS: 0.1650 ➖➖➖ - Binance Killers®";
    const out = expandCollapsedSignalText(raw);
    assert.match(out, /\nENTRY:/);
    assert.match(out, /\nTARGETS:/);
    assert.match(out, /\nSTOP LOSS:/);
    assert.match(out, /\n➖➖➖/);
  });

  it("keeps existing newlines", () => {
    const raw = "line1\nline2";
    assert.equal(formatMessageTextForDisplay(raw), "line1\nline2");
  });

  it("decodes br and literal backslash-n", () => {
    assert.equal(formatMessageTextForDisplay("a<br>b"), "a\nb");
    assert.equal(formatMessageTextForDisplay("a\\nb"), "a\nb");
  });

  it("splits English + Chinese signal translation block", () => {
    const raw = `Wallstreet Queen Official ViP
BOT
Coin: #XAUUSDT
Direction: SHORT
Leverage: 50x
Entry: 3564$ - 3578$
Targets: 3560 - 3550 - 3540 - 3526$
Stoploss: 3586$
币种：#XAUUSDT
方向：做空（SHORT）
入场：3564$ - 3578$`;
    const formatted = formatMessageTextForDisplay(raw);
    const parts = splitBilingualMessageText(formatted);
    assert.ok(parts);
    assert.match(parts.english, /Coin:\s*#XAUUSDT/i);
    assert.match(parts.chinese, /^币种：#XAUUSDT/m);
    assert.equal(splitBilingualMessageText("仅中文\n币种：BTC"), null);
    const zhOnly = preferSingleLanguageSignalText(raw);
    assert.doesNotMatch(zhOnly, /Direction:\s*SHORT/i);
    assert.match(zhOnly, /^币种：#XAUUSDT/m);
    assert.match(zhOnly, /止损：3586/m);
    assert.match(zhOnly, /目标：3560/m);
    assert.match(zhOnly, /杠杆：50/);
  });

  it("fills missing zh fields from english template", () => {
    const raw = `Coin: #BTCUSDT
Entry: 100
Targets: 110 - 120
Stoploss: 90
币种：#BTCUSDT
入场：100`;
    const zh = preferSingleLanguageSignalText(raw);
    assert.match(zh, /目标：110/);
    assert.match(zh, /止损：90/);
  });
});