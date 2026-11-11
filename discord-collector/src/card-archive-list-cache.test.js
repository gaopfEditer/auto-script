import { test } from "node:test";
import assert from "node:assert/strict";
import { archiveCardMatchesSourceTypes } from "./card-archive-list-cache.js";

test("archiveCardMatchesSourceTypes includes telegram when listed", () => {
  assert.equal(archiveCardMatchesSourceTypes("telegram", ["discord", "telegram"]), true);
  assert.equal(archiveCardMatchesSourceTypes("telegram", ["discord"]), false);
  assert.equal(archiveCardMatchesSourceTypes("kol:telegram", ["telegram"]), true);
});

test("archiveCardMatchesSourceTypes matches python-ai-operate composite platforms", () => {
  assert.equal(archiveCardMatchesSourceTypes("python-ai-operate:x", ["x"]), true);
  assert.equal(archiveCardMatchesSourceTypes("python-ai-operate:binance", ["binance"]), true);
  assert.equal(archiveCardMatchesSourceTypes("python-ai-operate:x", ["binance"]), false);
  assert.equal(archiveCardMatchesSourceTypes("x", ["x"]), true);
});
