import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, it } from "node:test";
import { createRangeEntryPendingStore } from "./range-entry-pending-store.js";

describe("range-entry-pending-store", () => {
  it("登记 waiting，重复同一信号不双开，重启后能恢复", () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), "range-entry-"));
    const file = path.join(dir, "pending.json");
    const a = createRangeEntryPendingStore(file);
    const first = a.addWaiting({
      exchange: "bitget",
      cardId: 9001,
      symbol: "XAUUSDT",
      direction: "做空",
      entryRaw: "3568$ - 3590$",
    });
    assert.equal(first, null);
    const dup = a.addWaiting({
      exchange: "bitget",
      cardId: 9001,
      symbol: "XAUUSDT",
      direction: "做空",
      entryRaw: "3568$ - 3590$",
    });
    assert.ok(dup);
    assert.equal(String(dup.status), "waiting");
    assert.equal(a.listWaiting().length, 1);

    a.addWaiting({
      exchange: "weex",
      cardId: 9001,
      symbol: "XAUUSDT",
      direction: "做空",
      entryRaw: "3568$ - 3590$",
    });
    assert.equal(a.listWaiting().length, 2);

    const b = createRangeEntryPendingStore(file);
    const recovered = b.listWaiting();
    assert.equal(recovered.length, 2);
    assert.ok(recovered.some((it) => it.key === "bitget:9001"));
    assert.ok(recovered.some((it) => it.key === "weex:9001"));

    b.complete("bitget:9001", "triggered");
    const c = createRangeEntryPendingStore(file);
    const still = c.listWaiting();
    assert.equal(still.length, 1);
    assert.equal(still[0].key, "weex:9001");
  });
});
