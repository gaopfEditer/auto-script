import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  parseAoyingPosition,
  parseSignalText,
  formatCardFallback,
} from "./discord-signal-parsers.js";

const sample = `熬鹰交易信号

📈 注意，新开仓
币种：BTCUSDT 永续 | 全仓 | 10x
方向：做空 🟥
持仓量：66.55 BTC
开仓均价：60674.37 USDT
强平价格：66985.40 USDT`;

describe("parseAoyingPosition", () => {
  it("parses 新开仓 BTC short", () => {
    const r = parseAoyingPosition(sample);
    assert.equal(r?.symbol, "BTC");
    assert.equal(r?.direction, "做空");
    assert.equal(r?.entry, "60674.37");
    assert.equal(r?.parser, "aoying_position");
    assert.equal(r?.awaitingTpsl, true);
  });

  it("skips portfolio-only snapshot", () => {
    const t = "熬鹰当前全部持仓\n1. 币种：BTCUSDT";
    assert.equal(parseAoyingPosition(t), null);
  });

  it("kind aoying_position", () => {
    const r = parseSignalText(sample, "aoying_position");
    assert.equal(r?.symbol, "BTC");
  });

  it("cn_brief 不出 JSON", () => {
    const r = parseAoyingPosition(sample);
    assert.ok(r);
    const brief = formatCardFallback(r, "cn_brief");
    assert.ok(brief.startsWith("📉 BTC"));
    assert.ok(!brief.includes('"parser"'));
    assert.ok(!brief.includes("路径核算"));
  });
});