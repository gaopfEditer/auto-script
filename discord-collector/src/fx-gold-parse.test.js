import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseFxGoldSignal, parseSignalText, formatCardFallback } from "./discord-signal-parsers.js";

const buyNow = `$XAUUSD BUY NOW 3629  TP 3632 TP 3636 TP 3640 TP 3644 TP 3648 TP 3652  SL. 3619 ⁣⁣ $XAUUSD 现价买入 3629  止盈 3632 止盈 3636 止盈 3640 止盈 3644 止盈 3648 止盈 3652  止损 3619`;
const sellNow = `$XAUUSD SELL NOW 3628  TP 3625 TP 3622 TP 3618 TP 3614 TP 3610  SL. 3638 ⁣⁣ $XAUUSD 现价卖出 3628  止盈 3625 止盈 3622 止盈 3618 止盈 3614 止盈 3610  止损 3638`;
const tpHit = `$XAUUSD BUY 📈  TP 1 HIT SUCCESSFULLY ✔️  30+PIPS RUNNING PROFIT DONE 🔥🔥🔥 ⁣⁣ $XAUUSD 买入 📈  第一止盈目标成功命中 ✔️  已实现 30+ 点浮动盈利 🔥🔥🔥`;

describe("parseFxGoldSignal", () => {
  it("BUY NOW 解出 XAU 做多、入场、多档止盈和止损（今早 #3106 原文）", () => {
    const r = parseSignalText(buyNow, "generic");
    assert.equal(r?.parser, "fx_gold");
    assert.equal(r?.symbol, "XAU");
    assert.equal(r?.direction, "做多");
    assert.equal(r?.entry, "3629");
    assert.equal(r?.stopLoss, "3619");
    assert.deepEqual(r?.takeProfits, ["3632", "3636", "3640", "3644", "3648", "3652"]);
  });

  it("SELL NOW 解出 XAU 做空", () => {
    const r = parseFxGoldSignal(sellNow);
    assert.equal(r?.parser, "fx_gold");
    assert.equal(r?.symbol, "XAU");
    assert.equal(r?.direction, "做空");
    assert.equal(r?.entry, "3628");
    assert.equal(r?.stopLoss, "3638");
    assert.deepEqual(r?.takeProfits, ["3625", "3622", "3618", "3614", "3610"]);
  });

  it("仅中文 现价买入 也可解析", () => {
    const r = parseFxGoldSignal("$XAUUSD 现价买入 3629 止盈 3632 止盈 3636 止损 3619");
    assert.equal(r?.parser, "fx_gold");
    assert.equal(r?.direction, "做多");
    assert.equal(r?.entry, "3629");
    assert.equal(r?.stopLoss, "3619");
  });

  it("TP HIT 更新不建开仓信号", () => {
    assert.equal(parseFxGoldSignal(tpHit), null);
    assert.equal(parseSignalText(tpHit, "generic"), null);
  });

  it("generic 不再把该模板解析成空币种的 altcoin_king", () => {
    const r = parseSignalText(buyNow, "generic");
    assert.ok(r);
    assert.notEqual(r?.parser, "altcoin_king");
    assert.ok(r?.symbol);
    assert.ok(r?.direction);
  });

  it("cn_brief 能打出币种和方向", () => {
    const r = parseFxGoldSignal(buyNow);
    const text = formatCardFallback(/** @type {Record<string, unknown>} */ (r), "cn_brief");
    assert.match(text, /XAU/);
    assert.match(text, /做多/);
    assert.match(text, /止损：3619/);
  });
});
