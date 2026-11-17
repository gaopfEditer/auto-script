import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PANGMAO_SIGNAL_CHANNEL_ID } from "./discord-signal-ocr-config.js";
import { DEFAULT_KOLVIP_CHANNEL_MAPPINGS } from "./kolvip-cdp-config.js";
import { kolvipMessageToDiscordRow } from "./kolvip-cdp-message.js";
import { isSignalIngestOcrEligible, runSignalCardPipelineForRows } from "./discord-signal-pipeline.js";
import { resolveSignalFromRowWithOcr } from "./discord-signal-image-ocr.js";
import { buildPangmaoPriorityEnqueueBody } from "./priority-queue-client.js";

describe("isSignalIngestOcrEligible", () => {
  it("kolvip 精选频道（峰哥）带附件仍不启用 ingest OCR", () => {
    const fengge = DEFAULT_KOLVIP_CHANNEL_MAPPINGS.find((m) => m.logicName === "峰哥");
    assert.ok(fengge);
    assert.equal(isSignalIngestOcrEligible(fengge.discordChannelId), false);
  });

  it("OCR 白名单频道（胖猫）启用 ingest OCR", () => {
    assert.equal(isSignalIngestOcrEligible(PANGMAO_SIGNAL_CHANNEL_ID), true);
  });

  it("非信号频道不启用 OCR", () => {
    assert.equal(isSignalIngestOcrEligible("9999999999999999999"), false);
  });
});

/**
 * @param {string} discordChannelId
 * @param {string} source
 */
function kolvipImageRow(discordChannelId, source) {
  const map = DEFAULT_KOLVIP_CHANNEL_MAPPINGS.find((m) => m.discordChannelId === discordChannelId);
  assert.ok(map);
  return kolvipMessageToDiscordRow(
    {
      dataId: "ocr-gate",
      text: "",
      author: map.logicName,
      timeText: "12:00",
      timeTitle: "2026-11-02 12:00:00",
      imageUrl: "https://cdn.example/kolvip-only.jpg",
    },
    { kolvipChannelId: map.kolvipChannelId, discordChannelId, source },
  );
}

describe("kolvip_api_backfill 图片 OCR 门控", () => {
  it("非 OCR 频道（峰哥）+ 附件 → resolveSignalFromRowWithOcr 不进入 OCR", async () => {
    const fengge = DEFAULT_KOLVIP_CHANNEL_MAPPINGS.find((m) => m.logicName === "峰哥");
    assert.ok(fengge);
    const row = kolvipImageRow(fengge.discordChannelId, "kolvip_api_backfill");
    assert.equal(isSignalIngestOcrEligible(fengge.discordChannelId), false);
    const resolved = await resolveSignalFromRowWithOcr(row);
    assert.equal(resolved, null);
  });

  it("OCR 白名单（胖猫）单图 → 注入的 OCR 失败时快速返回，不访问网络", async () => {
    const row = kolvipImageRow(PANGMAO_SIGNAL_CHANNEL_ID, "kolvip_api_backfill");
    assert.equal(isSignalIngestOcrEligible(PANGMAO_SIGNAL_CHANNEL_ID), true);
    const resolved = await resolveSignalFromRowWithOcr(row, {
      ocrImage: async () => ({ success: false, error: "PaddleOCR 不可达或超时 base=http://127.0.0.1:8866" }),
    });
    assert.equal(resolved?.skipped, "ocr_failed");
  });
});

describe("胖猫出卡后入优先队列", () => {
  const log = { info() {}, warn() {}, debug() {} };

  /**
   * @param {Record<string, unknown>} row
   * @param {{ card?: Record<string, unknown>, parsed?: Record<string, unknown> }} [result]
   */
  function pipelineDeps(row, result = { card: { id: 7, symbol: "ETH" } }) {
    /** @type {unknown[]} */
    const enqueued = [];
    /** @type {unknown[]} */
    const onMessageOpts = [];
    return {
      enqueued,
      onMessageOpts,
      deps: {
        signalCards: {
          ensureHydrated: async () => {},
          dedup: {
            isDuplicate: () => false,
            remember: async () => {},
          },
          onMessage: async (_row, opts) => {
            onMessageOpts.push(opts);
            return result;
          },
        },
        store: {},
        log,
        respectKolvipBypass: false,
        enqueuePriority: async (body) => {
          enqueued.push(body);
          return { ok: true };
        },
        ocrImage: async () => ({
          success: true,
          text: "ETHUSDT 永续 做多 +39.9% 开仓价格 2258.5",
          lines: [{ text: "ETHUSDT 做多 +39.9%" }],
        }),
      },
      row,
    };
  }

  it("文字卡 via=text，yield 为空", async () => {
    const row = {
      messageId: "text-1",
      channelId: PANGMAO_SIGNAL_CHANNEL_ID,
      content: "ETH做多",
      source: "kolvip_api",
      rawJson: { content: "ETH做多", attachments: [] },
    };
    const { deps, enqueued } = pipelineDeps(row);
    const out = await runSignalCardPipelineForRows([row], deps);
    assert.equal(out.created, 1);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].source, "pangmao");
    assert.equal(enqueued[0].meta.via, "text");
    assert.equal(enqueued[0].meta.yield_pct, null);
    assert.equal(enqueued[0].card.id, 7);
  });

  it("单图 OCR 过门槛 via=ocr，并关掉 Ollama", async () => {
    const row = kolvipImageRow(PANGMAO_SIGNAL_CHANNEL_ID, "kolvip_api");
    const { deps, enqueued, onMessageOpts } = pipelineDeps(row);
    await runSignalCardPipelineForRows([row], deps);
    assert.equal(enqueued.length, 1);
    assert.equal(enqueued[0].source, "pangmao");
    assert.equal(enqueued[0].meta.via, "ocr");
    assert.equal(enqueued[0].meta.yield_pct, 39.9);
    assert.equal(onMessageOpts[0].skipAiFallback, true);
    assert.equal(onMessageOpts[0].preParsed.ocrPoster, true);
  });

  it("收益率 41 不出卡也不入队", async () => {
    const row = kolvipImageRow(PANGMAO_SIGNAL_CHANNEL_ID, "kolvip_api");
    const { deps, enqueued, onMessageOpts } = pipelineDeps(row);
    deps.ocrImage = async () => ({ success: true, text: "ETHUSDT 做多 +41%" });
    const out = await runSignalCardPipelineForRows([row], deps);
    assert.equal(out.created, 0);
    assert.equal(out.skipCounts.ocr_yield_gate, 1);
    assert.equal(enqueued.length, 0);
    assert.equal(onMessageOpts.length, 0);
  });

  it("非胖猫频道不组优先队列 body", () => {
    assert.equal(
      buildPangmaoPriorityEnqueueBody({
        parser: "fengge",
        card: { id: 1 },
        via: "text",
      }),
      null,
    );
  });
});
