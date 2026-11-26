import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseKolvipKidFromNote,
  resolveKolvipKidFromAutotradePolicies,
  resolveKolvipKidFromShowChannelEntries,
  resolveKolvipChannelIdForShow,
  listKolvipShowScanCatchupIds,
} from "./kolvip-channel-catchup.js";

describe("parseKolvipKidFromNote", () => {
  it("reads kid= from rank note", () => {
    assert.equal(parseKolvipKidFromNote("kolvip近30天榜单 rank wr=61.1 kid=13"), "13");
    assert.equal(parseKolvipKidFromNote("no kid here"), null);
  });
});

describe("resolveKolvipKidFromAutotradePolicies", () => {
  const policies = [
    {
      kolvipChannelId: "13",
      channelIds: ["kolvip-scan-13", "1559133861617602630"],
    },
  ];
  it("maps Discord snowflake and virtual id to kid", () => {
    assert.equal(resolveKolvipKidFromAutotradePolicies("1559133861617602630", policies), "13");
    assert.equal(resolveKolvipKidFromAutotradePolicies("kolvip-scan-13", policies), "13");
    assert.equal(resolveKolvipKidFromAutotradePolicies("unknown", policies), null);
  });
});

describe("resolveKolvipKidFromShowChannelEntries", () => {
  it("maps sidebar Discord id via note", () => {
    const entries = [
      {
        channelId: "1559133861617602630",
        name: "零下二度VIP禁言群",
        note: "kolvip近30天榜单 rank wr=61.1 kid=13",
      },
    ];
    assert.equal(resolveKolvipKidFromShowChannelEntries("1559133861617602630", entries), "13");
    assert.equal(resolveKolvipKidFromShowChannelEntries("kolvip-scan-13", entries), null);
  });
});

describe("resolveKolvipChannelIdForShow", () => {
  it("parses kolvip-scan virtual ids", () => {
    assert.equal(resolveKolvipChannelIdForShow("kolvip-scan-13"), "13");
  });
  it("maps curated-8 Discord ids", () => {
    assert.equal(resolveKolvipChannelIdForShow("1444962339743989843"), "1");
  });
  it("maps 零下二度 Discord alias to kid 13", () => {
    assert.equal(resolveKolvipChannelIdForShow("1559133861617602630"), "13");
  });
});

describe("listKolvipShowScanCatchupIds", () => {
  it("includes alias kid 13 and excludes curated 8", () => {
    const kids = listKolvipShowScanCatchupIds(
      ["1559133861617602630", "1444962339743989843", "kolvip-scan-33"],
      {
        curatedKids: ["1", "4", "8", "10", "11", "12", "16", "22"],
        policies: [
          { kolvipChannelId: "13", channelIds: ["kolvip-scan-13", "1559133861617602630"] },
          { kolvipChannelId: "33", channelIds: ["kolvip-scan-33"] },
        ],
      },
    );
    assert.deepEqual(kids, ["13", "33"]);
  });
});
