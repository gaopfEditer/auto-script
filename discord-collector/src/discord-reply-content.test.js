import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  dedupeContentLines,
  isReplyRepostOfReference,
  resolveSignalContentFromRaw,
  stripEmbeddedQuotedContent,
} from "./discord-reply-content.js";

describe("discord-reply-content", () => {
  it("stripEmbeddedQuotedContent 去掉前缀引用块", () => {
    const quote = "JCT 低位做多\n入场 0.12";
    const body = `${quote}\n止盈 0.15`;
    assert.equal(stripEmbeddedQuotedContent(body, quote), "止盈 0.15");
  });

  it("dedupeContentLines 去重行", () => {
    const t = "A\nB\nA\nC\nB";
    assert.equal(dedupeContentLines(t), "A\nB\nC");
  });

  it("resolveSignalContentFromRaw 用 referenced_message 剥离", () => {
    const raw = {
      content: "JCT 低位做多\n入场 0.12\n止盈 0.15",
      referenced_message: {
        content: "JCT 低位做多\n入场 0.12",
      },
    };
    assert.equal(resolveSignalContentFromRaw(raw), "止盈 0.15");
  });

  it("isReplyRepostOfReference 识别复读", () => {
    const ref = "order 现价格做多\n入场 1.2";
    assert.equal(isReplyRepostOfReference(ref, ref), true);
    assert.equal(isReplyRepostOfReference("order 现价格做多\n入场 1.2\n", ref), true);
    assert.equal(isReplyRepostOfReference("仅止盈 1.5", ref), false);
  });
});
