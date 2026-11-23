import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  isKolvipSignalCardTelegramRoute,
  sendKolvipSignalCardTelegramOnly,
} from "./kolvip-top10-telegram.js";
import { parseKolvipScanVirtualChannelId } from "./kolvip-scan-config.js";

function ingestFlags(mode, curated) {
  // current live policy in kolvip-ingest.js
  return {
    skipTelegram: true,
    kolvipIngest: mode === "live",
    skipKolvipTop10Mirror: mode !== "live",
    curated: Boolean(curated),
  };
}

function wouldAttemptSpecialGroup(flags, channelId) {
  if (flags.skipKolvipTop10Mirror) return false;
  return isKolvipSignalCardTelegramRoute(channelId, {
    kolvipIngest: Boolean(flags.kolvipIngest || flags.skipTelegram),
  });
}

function wouldAttemptMainGroup(flags, channelId) {
  if (flags.skipTelegram) return false;
  if (wouldAttemptSpecialGroup(flags, channelId)) return false;
  return true;
}

describe("kolvip telegram route (mock transport, no real send)", () => {
  it("routes live kolvip to the special group, not the main push group", () => {
    const liveCurated = ingestFlags("live", true);
    const liveScan = ingestFlags("live", false);
    const backfill = ingestFlags("backfill", true);
    const scanCid = "kolvip-scan-31";
    const discordLikeCid = "1444962339743989843";

    assert.equal(parseKolvipScanVirtualChannelId(scanCid), "31");
    assert.equal(isKolvipSignalCardTelegramRoute(scanCid, { kolvipIngest: true }), true);
    assert.equal(isKolvipSignalCardTelegramRoute(discordLikeCid, { kolvipIngest: true }), true);

    assert.equal(wouldAttemptSpecialGroup(liveCurated, discordLikeCid), true);
    assert.equal(wouldAttemptMainGroup(liveCurated, discordLikeCid), false);
    assert.equal(wouldAttemptSpecialGroup(liveScan, scanCid), true);
    assert.equal(wouldAttemptMainGroup(liveScan, scanCid), false);

    assert.equal(wouldAttemptSpecialGroup(backfill, discordLikeCid), false);
    assert.equal(wouldAttemptMainGroup(backfill, discordLikeCid), false);
  });

  it("mock sender receives live kolvip cards and not backfill", async () => {
    const sent = [];
    const sender = {
      enabled: true,
      send: async (text, meta = {}) => {
        sent.push({
          textLen: String(text ?? "").length,
          channelId: String(meta.channelId ?? ""),
          kind: String(meta.kind ?? ""),
          hasCardId: meta.cardId != null,
        });
        return { ok: true };
      },
    };
    const log = { info() {}, warn() {}, error() {}, debug() {} };
    const live = await sendKolvipSignalCardTelegramOnly(
      log,
      sender,
      {
        text: "【dry-run-kolvip-route】#BTC 多",
        channelId: "kolvip-scan-31",
        channelName: "dry-run",
        cardId: "dry-run-1",
        messageId: "dry-run-msg-1",
        symbol: "BTC",
      },
      { requireTop10Channel: false },
    );
    assert.equal(live.ok, true);
    assert.equal(live.kolvipOnly, true);
    assert.equal(sent.length, 1);
    assert.equal(sent[0].kind, "kolvip_signal_card");
    assert.equal(sent[0].channelId, "kolvip-scan-31");

    const before = sent.length;
    const skipped = await sendKolvipSignalCardTelegramOnly(
      log,
      sender,
      {
        text: "【dry-run-kolvip-route】#ETH 空",
        channelId: "not-a-kolvip-channel-xyz",
        cardId: "dry-run-2",
        messageId: "dry-run-msg-2",
        symbol: "ETH",
      },
      { requireTop10Channel: true },
    );
    assert.equal(skipped.skipped, "not_top10_channel");
    assert.equal(sent.length, before);
  });

  it("disabled mock transport does not send", async () => {
    const sent = [];
    const sender = {
      enabled: false,
      send: async () => {
        sent.push("nope");
        return { ok: true };
      },
    };
    const log = { info() {}, warn() {}, error() {}, debug() {} };
    const res = await sendKolvipSignalCardTelegramOnly(log, sender, {
      text: "【dry-run-kolvip-route】#BTC 多",
      channelId: "kolvip-scan-31",
      cardId: "dry-run-3",
    });
    assert.equal(res.skipped, "kolvip_top10_disabled");
    assert.equal(sent.length, 0);
  });
});
