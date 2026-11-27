import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parsePangmao,
  parseSignalText,
  formatCardFallback,
  isPangmaoDisplayOnly,
  buildPangmaoPriorityDisplayCard,
} from "./discord-signal-parsers.js";
import { DEFAULT_SIGNAL_CHANNELS, isSignalChannel, getSignalChannelConfig } from "./discord-signal-config.js";
import { isStagedTradeChannel, STAGED_TRADE_PARSERS } from "./discord-signal-staged-trade.js";
import { runSignalCardPipelineForRows } from "./discord-signal-pipeline.js";

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

  const oral = [
    ["init给我多进去，速度，拉盘了牛来了", "INIT", "做多"],
    ["ake轻仓空进去", "AKE", "做空"],
    ["bless空进去", "BLESS", "做空"],
    ["btw做空", "BTW", "做空"],
    ["btw开空", "BTW", "做空"],
    ["fhe开多", "FHE", "做多"],
    ["tac多进去，止损放在0.01263", "TAC", "做多"],
    ["蚂蚁仓空evaa", "EVAA", "做空"],
    ["1837接个空", "ETH", "做空"],
    ["1795附近多  止损1780", "ETH", "做多"],
  ];

  for (const [text, symbol, direction] of oral) {
    it(`口语开仓: ${text}`, () => {
      const r = parsePangmao(text);
      assert.ok(r, `should parse: ${text}`);
      assert.equal(r.symbol, symbol);
      assert.equal(r.direction, direction);
      assert.equal(r.signalPhase, "open");
    });
  }

  it("tac 口语附带绝对止损", () => {
    const r = parsePangmao("tac多进去，止损放在0.01263");
    assert.equal(r.stopLoss, "0.01263");
    assert.equal(r.signalPhase, "open");
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

  const TEXT_22923 =
    "btw小心了，这个币等会可以反抽做空，基本上算是一个纯纯的垃圾币，向下的空间巨大";

  it("btw做空 仍是 BTW 做空", () => {
    const r = parsePangmao("btw做空");
    assert.ok(r);
    assert.equal(r.symbol, "BTW");
    assert.equal(r.direction, "做空");
    assert.equal(r.signalPhase, "open");
    assert.equal(isPangmaoDisplayOnly(r), false);
    assert.equal(r.orderMode, "market");
  });

  it("kolvip-16-22923 口语中间隔着币种和反抽做空", () => {
    const r = parsePangmao(TEXT_22923);
    assert.ok(r);
    assert.equal(r.symbol, "BTW");
    assert.equal(r.direction, "做空");
    assert.equal(r.signalPhase, "open");
    assert.equal(isPangmaoDisplayOnly(r), false);
  });

  it("开多/开空 与止损可以离币种更远", () => {
    const fhe = parsePangmao("fhe可以开多试试现在，止损放进一点");
    assert.ok(fhe);
    assert.equal(fhe.symbol, "FHE");
    assert.equal(fhe.direction, "做多");
    assert.match(String(fhe.note), /止损放进/);

    const mmt = parsePangmao("mmt关注一下，可以考虑做多，止损放在 0.12");
    assert.ok(mmt);
    assert.equal(mmt.symbol, "MMT");
    assert.equal(mmt.direction, "做多");
    assert.equal(mmt.stopLoss, "0.12");
    assert.equal(isPangmaoDisplayOnly(mmt), false);
  });

  it("the/this/can 不当币种；纯聊天和返佣不成交卡片", () => {
    for (const text of ["can做空", "the做空", "this可以开多"]) {
      const r = parsePangmao(text);
      assert.equal(isPangmaoDisplayOnly(r), true, text);
      assert.equal(r.symbol, "");
      assert.notEqual(r.orderMode, "market");
    }
    assert.equal(parsePangmao("the btw做空")?.symbol, "BTW");
    assert.equal(parsePangmao("今天吃肉了"), null);
    assert.equal(parsePangmao("哈哈今天天气不错"), null);
    assert.equal(parsePangmao("返佣邀请码在这，开多这个平台"), null);
    assert.equal(parsePangmao("千万不要学做空"), null);
    const two = parsePangmao("关注 fhe 和 mmt，可以做多");
    assert.equal(isPangmaoDisplayOnly(two), true);
    assert.equal(two.symbol, "");
  });

  it("有交易意图但没有币种：展示卡，不编造 symbol", () => {
    const text = "这个币等会可以反抽做空";
    const r = parsePangmao(text);
    assert.ok(r);
    assert.equal(r.symbol, "");
    assert.equal(r.direction, "做空");
    assert.equal(r.signalPhase, "incomplete");
    assert.equal(r.displayOnly, true);
    assert.equal(r.orderMode, undefined);
    const display = buildPangmaoPriorityDisplayCard(text, {
      messageId: "kolvip-16-no-ticker",
      channelId: PANGMAO_ID,
    });
    assert.equal(display?.signalPhase, "incomplete");
    assert.equal(display?.symbol, "");
    assert.equal(buildPangmaoPriorityDisplayCard("btw做空"), null);
    assert.equal(buildPangmaoPriorityDisplayCard("今天天气不错"), null);
  });

  it("无币种的交易意图仍入优先队列，闲聊和返佣不入队", async () => {
    const log = { info() {}, warn() {}, debug() {} };
    /**
     * @param {string} content
     * @param {{ skipped?: string, card?: Record<string, unknown> }} [result]
     */
    async function enqueueOf(content, result = { skipped: "parse_failed" }) {
      /** @type {unknown[]} */
      const enqueued = [];
      await runSignalCardPipelineForRows(
        [
          {
            messageId: "pm-q",
            channelId: PANGMAO_ID,
            content,
            source: "kolvip_api",
            rawJson: { content, attachments: [] },
          },
        ],
        {
          signalCards: {
            ensureHydrated: async () => {},
            dedup: { isDuplicate: () => false, remember: async () => {} },
            onMessage: async () => result,
          },
          store: {},
          log,
          respectKolvipBypass: false,
          enqueuePriority: async (body) => {
            enqueued.push(body);
            return { ok: true };
          },
        },
      );
      return enqueued;
    }

    const trade = await enqueueOf("这个币等会可以反抽做空");
    assert.equal(trade.length, 1);
    assert.equal(trade[0].source, "pangmao");
    assert.equal(trade[0].meta.via, "text");
    assert.equal(trade[0].card.symbol, "");
    assert.equal(trade[0].card.direction, "做空");
    assert.equal(trade[0].card.signalPhase, "incomplete");
    assert.equal(trade[0].card.displayOnly, true);
    assert.equal(trade[0].card.orderMode, undefined);

    assert.equal((await enqueueOf("今天天气不错啊")).length, 0);
    assert.equal((await enqueueOf("返佣邀请码注册链接，开多")).length, 0);
    assert.equal((await enqueueOf("千万不要学做空")).length, 0);
  });

  it("formatCardFallback 胖猫用可读卡片而非 JSON", () => {
    const open = parsePangmao("以太坊2426附近空，2450止损");
    assert.ok(open);
    const text = formatCardFallback(open, "cn_brief");
    assert.equal(text.includes("{"), false);
    assert.match(text, /ETH/);
    assert.match(text, /做空/);
    assert.match(text, /入场：2426/);
    assert.match(text, /止损：2450/);

    const tpsl = parsePangmao("0.059止损");
    assert.ok(tpsl);
    const tpslText = formatCardFallback(tpsl, "cn_brief");
    assert.equal(tpslText.trim().startsWith("{"), false);
    assert.match(tpslText, /止损：0\.059/);
  });

});
