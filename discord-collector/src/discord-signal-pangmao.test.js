import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { parsePangmao, parseSignalText } from "./discord-signal-parsers.js";
import { DEFAULT_SIGNAL_CHANNELS, isSignalChannel, getSignalChannelConfig } from "./discord-signal-config.js";
import { isStagedTradeChannel, STAGED_TRADE_PARSERS } from "./discord-signal-staged-trade.js";

const PANGMAO_ID = "1562351038277619783";

describe("胖猫社区 parser + 频道配置", () => {
  it("DEFAULT_SIGNAL_CHANNELS 含胖猫且 parser=pangmao", () => {
    const cfg = DEFAULT_SIGNAL_CHANNELS[PANGMAO_ID];
    assert.ok(cfg);
    assert.equal(cfg.name, "胖猫社区");
    assert.equal(cfg.parser, "pangmao");
    assert.equal(getSignalChannelConfig(PANGMAO_ID)?.parser, "pangmao");
  });

  it("分阶段交易包含胖猫频道", () => {
    assert.equal(isStagedTradeChannel(PANGMAO_ID), true);
    assert.equal(STAGED_TRADE_PARSERS.has("pangmao"), true);
  });

  const opens = [
    ["jct低位做多", "JCT", "做多"],
    ["order现价格做多", "ORDER", "做多"],
    ["order现在价格做空", "ORDER", "做空"],
    ["irys继续做多", "IRYS", "做多"],
    ["magma做空", "MAGMA", "做空"],
    ["magma现在做多，", "MAGMA", "做多"],
    ["iost做多", "IOST", "做多"],
    ["xny现价格做多", "XNY", "做多"],
    ["ain继续做多", "AIN", "做多"],
    ["ain现价格做多", "AIN", "做多"],
    ["闪迪现价格做空", "SNDK", "做空"],
    ["bulla现价格做多，我休息完了", "BULLA", "做多"],
    ["alt做多，三四个点止损，看看是不是走二段了", "ALT", "做多"],
    ["jct现价格做空，止损上方五个点左右", "JCT", "做空"],
    ["ake也值得做多，破前高，三个点止损", "AKE", "做多"],
    ["以太坊2426附近空，2450止损，目标破前低", "ETH", "做空"],
  ];

  for (const [text, symbol, direction] of opens) {
    it(`开仓: ${text}`, () => {
      const r = parsePangmao(text);
      assert.ok(r, `should parse: ${text}`);
      assert.equal(r.symbol, symbol);
      assert.equal(r.direction, direction);
      assert.equal(r.signalPhase, "open");
      assert.equal(r.parser, "pangmao");
      const via = parseSignalText(text, "pangmao");
      assert.ok(via);
      assert.equal(via.symbol, symbol);
    });
  }

  it("仅止损 0.059止损", () => {
    const r = parsePangmao("0.059止损");
    assert.ok(r);
    assert.equal(r.signalPhase, "tpsl");
    assert.equal(r.stopLoss, "0.059");
  });

  it("仅目标 目标0.048", () => {
    const r = parsePangmao("目标0.048");
    assert.ok(r);
    assert.equal(r.signalPhase, "tpsl");
    assert.deepEqual(r.takeProfits, ["0.048"]);
  });

  it("以太坊附近空带绝对止损", () => {
    const r = parsePangmao("以太坊2426附近空，2450止损，目标破前低");
    assert.ok(r);
    assert.equal(r.symbol, "ETH");
    assert.equal(r.entry, "2426");
    assert.equal(r.stopLoss, "2450");
  });

  it("拒绝长文策略/复盘", () => {
    assert.equal(parsePangmao("闪迪策略：① 回踩1262 止损1255"), null);
    assert.equal(parsePangmao("兄弟们，复盘整理好了🐱 MAGMA多单"), null);
  });

  it("短句仍可通过 parseSignalText(pangmao)（绕过 MIN_SIGNAL_TEXT_LEN）", () => {
    const r = parseSignalText("magma做空", "pangmao");
    assert.ok(r);
    assert.equal(r.symbol, "MAGMA");
  });
});
