import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseKolvipBrief,
  parseSignalText,
  formatCardFallback,
} from "./discord-signal-parsers.js";
import { prependKolvipCoinToMessageText } from "./kolvip-message-text.js";

describe("parseKolvipBrief", () => {
  const xau =
    "做空（SHORT） 杠杆：50倍 入场价：3548美元 - 3565美元 目标位：3540 - 3525 - 3510 - 3500美元 止损：3575美元";
  const xau2 =
    "做空（SHORT） 杠杆：50倍 入场：3564$ - 3578$ 目标：3560 - 3550 - 3540 - 3526$ 止损：3586$";
  const arc =
    "做空 杠杆：10倍 入场：0.02560$ - 0.02626$ 目标：0.02500 - 0.02450 - 0.02400 - 0.02300$ 止损：0.02675$";

  it("黄金按美元区间识别为 XAU", () => {
    const r = parseKolvipBrief(xau);
    assert.equal(r?.symbol, "XAU");
    assert.equal(r?.takeProfits?.length, 4);
    assert.equal(r?.stopLoss, "3575");
  });

  it("generic 优先走 kolvip_brief 而非 streak_cn 默认 BTC", () => {
    const r = parseSignalText(xau2, "generic");
    assert.equal(r?.parser, "kolvip_brief");
    assert.equal(r?.symbol, "XAU");
  });

  it("入场区间 / 目标价 / 止损价 模板", () => {
    const t =
      "做空 杠杆：20倍 入场区间：3952美元 - 3965美元 目标价：3945 - 3935 - 3920美元 止损价：3978美元";
    const r = parseKolvipBrief(t);
    assert.equal(r?.symbol, "XAU");
    assert.equal(r?.stopLoss, "3978");
  });

  it("单行双语：入场不吞目标/止损", () => {
    const t =
      "Coin: #XAUUSDT Direction: SHORT 杠杆：50倍 入场价：3560$ - 3568$ 目标价：3552 - 3540 - 3528 - 3519$ 止损：3576$";
    const r = parseKolvipBrief(t);
    assert.equal(r?.entry, "3560$ - 3568$");
    assert.equal(r?.stopLoss, "3576");
    assert.equal(r?.takeProfits?.length, 4);
  });

  it("cn_brief 巨鲸模板为可读多行而非 JSON", () => {
    const r = parseKolvipBrief(
      "做空 杠杆：50倍 入场价：3560$ - 3568$ 目标价：3552 - 3540 止损：3576$"
    );
    const text = formatCardFallback(/** @type {Record<string, unknown>} */ (r), "cn_brief");
    assert.match(text, /^📉/);
    assert.match(text, /入场：3560/);
    assert.ok(!text.trim().startsWith("{"));
  });

  it("API 注入币种后解析 ARC", () => {
    const t = prependKolvipCoinToMessageText(arc, "ARC");
    const r = parseSignalText(t, "generic");
    assert.equal(r?.symbol, "ARC");
    assert.equal(r?.takeProfits?.length, 4);
  });

  const queen3134Multiline = `Coin: #XAUUSDT

Direction: SHORT

Leverage: 60x

Entry: 3568$ - 3590$

Targets: 3555 - 3542 - 3525- 3510$

Stoploss: 3600$`;
  const queen3134Flat =
    "Coin: #XAUUSDT Direction: SHORT Leverage: 60x Entry: 3568$ - 3590$ Targets: 3555 - 3542 - 3525- 3510$ Stoploss: 3600$";

  it("#3134 纯英文多行：XAUUSDT 做空，保留入场区间与全部 TP/SL，不被 binance_killers 吞字段", () => {
    const r = parseSignalText(queen3134Multiline, "generic");
    assert.equal(r?.parser, "kolvip_brief");
    assert.equal(r?.symbol, "XAUUSDT");
    assert.equal(r?.direction, "做空");
    assert.equal(r?.entry, "3568$ - 3590$");
    assert.equal(r?.stopLoss, "3600");
    assert.deepEqual(r?.takeProfits, ["3555", "3542", "3525", "3510"]);
    assert.equal(r?.leverage, "60倍");
  });

  it("#3134 纯英文单行同样截断 Entry，不把 Targets/Stoploss 吞进入场", () => {
    const r = parseKolvipBrief(queen3134Flat);
    assert.equal(r?.parser, "kolvip_brief");
    assert.equal(r?.symbol, "XAUUSDT");
    assert.equal(r?.direction, "做空");
    assert.equal(r?.entry, "3568$ - 3590$");
    assert.equal(r?.stopLoss, "3600");
    assert.deepEqual(r?.takeProfits, ["3555", "3542", "3525", "3510"]);
    const all = parseSignalText(queen3134Flat, "generic");
    assert.equal(all?.parser, "kolvip_brief");
    assert.notEqual(all?.parser, "binance_killers");
    assert.ok(!String(all?.direction ?? "").includes("Leverage"));
    assert.ok(!String(all?.entry ?? "").includes("Targets"));
  });

  it("cn_brief 纯英文区间信号仍打出币种、方向、区间入场", () => {
    const r = parseKolvipBrief(queen3134Multiline);
    const text = formatCardFallback(/** @type {Record<string, unknown>} */ (r), "cn_brief");
    assert.match(text, /XAU/);
    assert.match(text, /做空/);
    assert.match(text, /入场：3568\$ - 3590\$/);
    assert.match(text, /止损：3600/);
  });
});
