import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseKacangGoldSignal, parseSignalText, formatCardFallback } from "./discord-signal-parsers.js";

const kacangBuy = `Gold buy now indicator keramat guys @3619 - 3615

tp1 : 3629
tp2 : 3635
sl : 3611

Layer slowly in zone !
⁣⁣
黄金现价买入，指标神准，各位 @3619 - 3615

第一止盈位（tp1）：3629
第二止盈位（tp2）：3635
止损位（sl）：3611

在区间内逐步分批建仓！`;

const kacangSell =
  "Gold sell now indicator keramat @ 4052 - 4056 tp1 : 4042 tp2 : 4035 sl : 4060 Layer slowly in zone !";

const chatOnly = "Ready signal indicator keramat";

describe("parseKacangGoldSignal", () => {
  it("解析 #36241 同类区间做多：保留 @3619-3615 与 tp/sl", () => {
    const r = parseSignalText(kacangBuy, "generic");
    assert.equal(r?.parser, "kacang_gold");
    assert.equal(r?.symbol, "XAU");
    assert.equal(r?.direction, "做多");
    assert.equal(r?.entry, "3619 - 3615");
    assert.equal(r?.stopLoss, "3611");
    assert.deepEqual(r?.takeProfits, ["3629", "3635"]);
  });

  it("Gold sell now 区间做空", () => {
    const r = parseKacangGoldSignal(kacangSell);
    assert.equal(r?.parser, "kacang_gold");
    assert.equal(r?.direction, "做空");
    assert.equal(r?.entry, "4052 - 4056");
    assert.equal(r?.stopLoss, "4060");
    assert.deepEqual(r?.takeProfits, ["4042", "4035"]);
  });

  it("闲聊不建开仓信号", () => {
    assert.equal(parseKacangGoldSignal(chatOnly), null);
    assert.equal(parseSignalText(chatOnly, "generic"), null);
  });

  it("cn_brief 打出区间入场", () => {
    const r = parseKacangGoldSignal(kacangBuy);
    const text = formatCardFallback(/** @type {Record<string, unknown>} */ (r), "cn_brief");
    assert.match(text, /XAU/);
    assert.match(text, /做多/);
    assert.match(text, /入场：3619 - 3615/);
    assert.match(text, /止损：3611/);
  });
});
