import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { PANGMAO_SIGNAL_CHANNEL_ID } from "./discord-signal-ocr-config.js";
import { DEFAULT_KOLVIP_CHANNEL_MAPPINGS } from "./kolvip-cdp-config.js";
import { kolvipMessageToDiscordRow } from "./kolvip-cdp-message.js";
import { isSignalIngestOcrEligible } from "./discord-signal-pipeline.js";
import { resolveSignalFromRowWithOcr } from "./discord-signal-image-ocr.js";

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

describe("kolvip_api_backfill 图片 OCR 门控", () => {
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

  it("非 OCR 频道（峰哥）+ 附件 → resolveSignalFromRowWithOcr 不进入 OCR", async () => {
    const fengge = DEFAULT_KOLVIP_CHANNEL_MAPPINGS.find((m) => m.logicName === "峰哥");
    assert.ok(fengge);
    const row = kolvipImageRow(fengge.discordChannelId, "kolvip_api_backfill");
    assert.equal(isSignalIngestOcrEligible(fengge.discordChannelId), false);
    const resolved = await resolveSignalFromRowWithOcr(row);
    assert.equal(resolved, null);
  });

  it("OCR 白名单（胖猫）+ 附件 → 仍尝试 OCR（失败快速返回）", async () => {
    const row = kolvipImageRow(PANGMAO_SIGNAL_CHANNEL_ID, "kolvip_api_backfill");
    assert.equal(isSignalIngestOcrEligible(PANGMAO_SIGNAL_CHANNEL_ID), true);
    const resolved = await resolveSignalFromRowWithOcr(row);
    assert.equal(resolved?.skipped, "ocr_failed");
  });
});
