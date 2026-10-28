import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  cardSourceTypeMatchesAnyFilter,
  cardSourceTypeMatchesFilterToken,
  buildSourceTypeFilterSql,
  fitCompositeSourceType,
} from "./card-source-filter.js";
import { isValidCardSourceType, normalizeCardSourceType } from "./card-archive-service.js";

describe("normalizeCardSourceType / validation", () => {
  it("accepts python-ai-operate composite and binance_square platform", () => {
    assert.equal(normalizeCardSourceType("python-ai-operate:x"), "python-ai-operate:x");
    assert.equal(isValidCardSourceType("python-ai-operate:binance_square"), true);
    assert.equal(normalizeCardSourceType("twitter"), "x");
  });

  it("truncates long project while keeping platform suffix", () => {
    const platform = "binance_square";
    const out = fitCompositeSourceType("python-ai-operate-extra-long-name", platform);
    assert.ok(out.length <= 32);
    assert.ok(out.endsWith(`:${platform}`));
    assert.equal(isValidCardSourceType(out), true);
  });
});

describe("cardSourceTypeMatchesFilterToken", () => {
  it("matches platform filter against composite stored type", () => {
    assert.equal(cardSourceTypeMatchesFilterToken("python-ai-operate:x", "x"), true);
    assert.equal(cardSourceTypeMatchesFilterToken("x", "x"), true);
  });

  it("matches python-ai-operate project filter", () => {
    assert.equal(cardSourceTypeMatchesFilterToken("python-ai-operate:x", "python-ai-operate"), true);
    assert.equal(cardSourceTypeMatchesFilterToken("x", "python-ai-operate"), false);
  });

  it("matches any filter list", () => {
    assert.equal(
      cardSourceTypeMatchesAnyFilter("python-ai-operate:telegram", ["discord", "telegram"]),
      true
    );
  });
});

describe("buildSourceTypeFilterSql", () => {
  it("builds project prefix SQL for python-ai-operate", () => {
    const part = buildSourceTypeFilterSql("python-ai-operate");
    assert.match(part.sql, /LIKE/);
    assert.deepEqual(part.params, ["python-ai-operate", "python-ai-operate:%"]);
  });
});
