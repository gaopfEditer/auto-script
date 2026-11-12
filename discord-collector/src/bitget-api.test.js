import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { resolveBitgetTpslExecutePrice } from "./bitget-api.js";

describe("resolveBitgetTpslExecutePrice", () => {
  it("未传执行价时回退为触发价且 > 0", () => {
    assert.equal(resolveBitgetTpslExecutePrice("0.07892"), "0.07892");
    assert.equal(resolveBitgetTpslExecutePrice("0.08724", undefined), "0.08724");
  });

  it("拒绝 0、空或非法价", () => {
    assert.equal(resolveBitgetTpslExecutePrice("0.07892", "0"), undefined);
    assert.equal(resolveBitgetTpslExecutePrice("0.07892", ""), "0.07892");
    assert.equal(resolveBitgetTpslExecutePrice(undefined, undefined), undefined);
    assert.equal(resolveBitgetTpslExecutePrice(undefined, "0"), undefined);
  });

  it("显式执行价优先", () => {
    assert.equal(resolveBitgetTpslExecutePrice("0.07892", "0.07890"), "0.07890");
  });
});
