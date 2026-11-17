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
  PANGMAO_OCR_YIELD_EMIT_BELOW_PCT,
  shouldEmitPangmaoOcrYield,
} from "./discord-signal-ocr-parser.js";
import { createOcrSignalFingerprintDedup } from "./discord-signal-ocr-dedup.js";
import {
  classifyPangmaoImagePost,
  resetOcrSignalDedupForTests,
  resolveSignalFromRowWithOcr,
} from "./discord-signal-image-ocr.js";

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

describe("胖猫单图 OCR 收益率门槛（默认 40，保留符号）", () => {
  it("默认门槛是 40", () => {
    assert.equal(PANGMAO_OCR_YIELD_EMIT_BELOW_PCT, 40);
  });

  it("提取有符号收益率，优先收益率标签", () => {
    assert.equal(extractProfitRatePct(WEEX_SHOW_OFF_OCR), 311.97);
    assert.equal(extractProfitRatePct("手续费 0.04% 收益率 -12.3%"), -12.3);
    assert.equal(extractProfitRatePct("ETHUSDT 做多 +1% +39.9%"), 39.9);
    assert.equal(extractProfitRatePct("BTCUSDT 做空 −5.2%"), -5.2);
  });

  for (const [label, yieldPct, emit] of [
    ["39.9", 39.9, true],
    ["40", 40, false],
    ["41", 41, false],
    ["0", 0, true],
    ["负数", -5, true],
  ]) {
    it(`${label}% → ${emit ? "出卡" : "不出卡"}`, () => {
      assert.equal(shouldEmitPangmaoOcrYield(yieldPct, 40), emit);
      const sign = yieldPct > 0 ? "+" : "";
      const text = `ETHUSDT 永续 做多 10x ${sign}${yieldPct}% 开仓价格 2258.50`;
      const c = classifyOcrPoster(text, PANGMAO_OCR_YIELD_EMIT_BELOW_PCT);
      assert.equal(c.emit, emit);
      assert.equal(c.profitRatePct, yieldPct);
      if (emit) {
        assert.equal(c.parsed?.symbol, "ETH");
        assert.equal(c.parsed?.direction, "做多");
        assert.equal(c.parsed?.ocrPoster, true);
      } else {
        assert.equal(c.parsed, null);
        assert.equal(c.reason, "yield_gate");
      }
    });
  }

  it("没有收益率、没有币或没有方向都不出卡", () => {
    const noYield = classifyOcrPoster("ETHUSDT 永续 做多 10x 开仓价格 2258.50", 40);
    assert.equal(noYield.reason, "missing_yield");
    assert.equal(noYield.parsed, null);

    const noCoin = classifyOcrPoster("做多 +10%", 40);
    assert.equal(noCoin.reason, "missing_fields");
    assert.equal(noCoin.parsed, null);

    const noDir = classifyOcrPoster("ETHUSDT +10%", 40);
    assert.equal(noDir.reason, "missing_fields");
    assert.equal(noDir.parsed, null);

    assert.equal(shouldEmitPangmaoOcrYield(null, 40), false);
  });

  it("大额亏损仍出卡（不用绝对值当成晒单）", () => {
    const c = classifyOcrPoster("ETHUSDT 做空 -80%", 40);
    assert.equal(c.profitRatePct, -80);
    assert.equal(c.emit, true);
    assert.equal(c.parsed?.direction, "做空");
  });
});

/**
 * @param {{ text?: string, images?: string[], messageId?: string }} [opts]
 */
function pangmaoRow(opts = {}) {
  const text = opts.text ?? "";
  const images = opts.images ?? [];
  const attachments = images.map((url, i) => ({
    url,
    filename: `img-${i}.jpg`,
    content_type: "image/jpeg",
  }));
  return {
    messageId: opts.messageId ?? "m1",
    channelId: PANGMAO_SIGNAL_CHANNEL_ID,
    content: text,
    source: "kolvip_api",
    rawJson: { content: text, attachments, channel_id: PANGMAO_SIGNAL_CHANNEL_ID },
  };
}

describe("胖猫单图 / 配文 / 相册（假 OCR，不访问网络）", () => {
  it("单图无配文才是 single_image", () => {
    assert.equal(classifyPangmaoImagePost(pangmaoRow({ images: ["https://cdn.example/a.jpg"] })), "single_image");
    assert.equal(
      classifyPangmaoImagePost(pangmaoRow({ text: "ETH做多", images: ["https://cdn.example/a.jpg"] })),
      "image_with_text",
    );
    assert.equal(
      classifyPangmaoImagePost(
        pangmaoRow({ images: ["https://cdn.example/a.jpg", "https://cdn.example/b.jpg"] }),
      ),
      "album",
    );
    assert.equal(classifyPangmaoImagePost(pangmaoRow({ text: "ETH做多" })), "text");
  });

  it("配文或相册不调用 OCR", async () => {
    let calls = 0;
    const ocrImage = async () => {
      calls += 1;
      return { success: true, text: "ETHUSDT 做多 +10%" };
    };
    const withText = await resolveSignalFromRowWithOcr(
      pangmaoRow({ text: "自己看", images: ["https://cdn.example/a.jpg"] }),
      { ocrImage, yieldThreshold: 40 },
    );
    const album = await resolveSignalFromRowWithOcr(
      pangmaoRow({ images: ["https://cdn.example/a.jpg", "https://cdn.example/b.jpg"] }),
      { ocrImage, yieldThreshold: 40 },
    );
    assert.equal(withText, null);
    assert.equal(album, null);
    assert.equal(calls, 0);
  });

  it("单图用 OCR 文本解析；39.9 出卡，40 不出，缺字段不出", async () => {
    resetOcrSignalDedupForTests();
    /**
     * @param {string} text
     */
    const fake = (text) => async () => ({ success: true, text, lines: [{ text }] });

    const low = await resolveSignalFromRowWithOcr(
      pangmaoRow({ images: ["https://cdn.example/low.jpg"], messageId: "low" }),
      { ocrImage: fake("ETHUSDT 永续 做多 10x +39.9% 开仓价格 2258.5"), yieldThreshold: 40 },
    );
    assert.equal(low?.parsed?.symbol, "ETH");
    assert.equal(low?.parsed?.direction, "做多");
    assert.equal(low?.profitRatePct, 39.9);
    assert.equal(low?.skipped, undefined);

    const at = await resolveSignalFromRowWithOcr(
      pangmaoRow({ images: ["https://cdn.example/at.jpg"], messageId: "at" }),
      { ocrImage: fake("ETHUSDT 做多 +40%"), yieldThreshold: 40 },
    );
    assert.equal(at?.skipped, "ocr_yield_gate");
    assert.equal(at?.parsed, undefined);

    const high = await resolveSignalFromRowWithOcr(
      pangmaoRow({ images: ["https://cdn.example/high.jpg"], messageId: "high" }),
      { ocrImage: fake("ETHUSDT 做多 +41%"), yieldThreshold: 40 },
    );
    assert.equal(high?.skipped, "ocr_yield_gate");

    const zero = await resolveSignalFromRowWithOcr(
      pangmaoRow({ images: ["https://cdn.example/zero.jpg"], messageId: "zero" }),
      { ocrImage: fake("ETHUSDT 做多 0%"), yieldThreshold: 40 },
    );
    assert.equal(zero?.profitRatePct, 0);
    assert.equal(zero?.parsed?.symbol, "ETH");

    const neg = await resolveSignalFromRowWithOcr(
      pangmaoRow({ images: ["https://cdn.example/neg.jpg"], messageId: "neg" }),
      { ocrImage: fake("BTCUSDT 做空 收益率 -5%"), yieldThreshold: 40 },
    );
    assert.equal(neg?.profitRatePct, -5);
    assert.equal(neg?.parsed?.symbol, "BTC");
    assert.equal(neg?.parsed?.direction, "做空");

    const missing = await resolveSignalFromRowWithOcr(
      pangmaoRow({ images: ["https://cdn.example/miss.jpg"], messageId: "miss" }),
      { ocrImage: fake("ETHUSDT 做多 开仓价格 1"), yieldThreshold: 40 },
    );
    assert.equal(missing?.skipped, "ocr_missing_yield");
    assert.equal(missing?.content, undefined);
  });

  it("OCR 服务宕机只记失败，不抛错", async () => {
    const resolved = await resolveSignalFromRowWithOcr(
      pangmaoRow({ images: ["https://cdn.example/down.jpg"] }),
      {
        yieldThreshold: 40,
        ocrImage: async () => {
          throw new Error("PaddleOCR 不可达或超时 base=http://127.0.0.1:8866: aborted");
        },
      },
    );
    assert.equal(resolved?.skipped, "ocr_failed");
  });

  it("只有 lines 的 OCR JSON 也能解析", async () => {
    resetOcrSignalDedupForTests();
    const resolved = await resolveSignalFromRowWithOcr(
      pangmaoRow({ images: ["https://cdn.example/lines.jpg"], messageId: "lines" }),
      {
        yieldThreshold: 40,
        ocrImage: async () => ({
          success: true,
          text: "",
          lines: [{ text: "SOLUSDT" }, { text: "做多" }, { text: "+12%" }],
        }),
      },
    );
    assert.equal(resolved?.parsed?.symbol, "SOL");
    assert.equal(resolved?.profitRatePct, 12);
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
