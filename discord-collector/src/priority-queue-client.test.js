import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  buildPangmaoPriorityEnqueueBody,
  enqueuePriorityCard,
  resetPriorityQueueLogForTests,
} from "./priority-queue-client.js";

describe("胖猫优先队列客户端", () => {
  it("请求体 source=pangmao，OCR 保留收益率，文字卡 yield 为 null", () => {
    const ocr = buildPangmaoPriorityEnqueueBody({
      parser: "pangmao",
      card: { id: 1, symbol: "ETH" },
      via: "ocr",
      yieldPct: -5,
    });
    assert.deepEqual(ocr, {
      source: "pangmao",
      card: { id: 1, symbol: "ETH" },
      meta: { via: "ocr", yield_pct: -5 },
    });
    const text = buildPangmaoPriorityEnqueueBody({
      parser: "pangmao",
      card: { id: 2 },
      via: "text",
      yieldPct: 12,
    });
    assert.equal(text?.meta.via, "text");
    assert.equal(text?.meta.yield_pct, null);
    const zero = buildPangmaoPriorityEnqueueBody({
      parser: "pangmao",
      card: { id: 3 },
      via: "ocr",
      yieldPct: 0,
    });
    assert.equal(zero?.meta.yield_pct, 0);
  });

  it("非胖猫、来源升级、没有卡片都不入队", () => {
    assert.equal(
      buildPangmaoPriorityEnqueueBody({ parser: "fengge", card: { id: 1 }, via: "text" }),
      null,
    );
    assert.equal(
      buildPangmaoPriorityEnqueueBody({
        parser: "pangmao",
        card: { id: 1 },
        skipped: "source_upgraded",
        via: "text",
      }),
      null,
    );
    assert.equal(
      buildPangmaoPriorityEnqueueBody({ parser: "pangmao", card: null, via: "text" }),
      null,
    );
  });

  it("未配置 base 或 secret 时跳过并只记一次日志，不发请求", async () => {
    resetPriorityQueueLogForTests();
    /** @type {string[]} */
    const notes = [];
    const log = {
      info: (m) => notes.push(String(m)),
      warn: (m) => notes.push(String(m)),
    };
    const fetchImpl = async () => {
      throw new Error("should not fetch");
    };
    const body = {
      source: "pangmao",
      card: { id: 1 },
      meta: { via: "text", yield_pct: null },
    };
    const a = await enqueuePriorityCard(body, { baseUrl: "", secret: "", log, fetchImpl });
    const b = await enqueuePriorityCard(body, {
      baseUrl: "http://127.0.0.1:9",
      secret: "",
      log,
      fetchImpl,
    });
    assert.equal(a.skipped, "unconfigured");
    assert.equal(b.skipped, "unconfigured");
    assert.equal(notes.length, 1);
  });

  it("按约定 POST，失败不抛错也不带出 secret", async () => {
    /** @type {Array<{ url: string, init: RequestInit }>} */
    const calls = [];
    const ok = await enqueuePriorityCard(
      {
        source: "pangmao",
        card: { id: 9, title: "ETH · 胖猫" },
        meta: { via: "ocr", yield_pct: 12 },
      },
      {
        baseUrl: "http://127.0.0.1:8787/",
        secret: "test-secret",
        timeoutMs: 1000,
        log: { warn() {}, info() {} },
        fetchImpl: async (url, init) => {
          calls.push({ url: String(url), init: /** @type {RequestInit} */ (init) });
          return /** @type {Response} */ ({ ok: true, status: 200 });
        },
      },
    );
    assert.equal(ok.ok, true);
    assert.equal(calls[0].url, "http://127.0.0.1:8787/queue/priority");
    const headers = /** @type {Record<string, string>} */ (calls[0].init.headers);
    assert.equal(headers.Authorization, "Bearer test-secret");
    const sent = JSON.parse(String(calls[0].init.body));
    assert.equal(sent.source, "pangmao");
    assert.equal(sent.meta.via, "ocr");
    assert.equal(sent.meta.yield_pct, 12);
    assert.equal(sent.card.id, 9);

    /** @type {string[]} */
    const warns = [];
    const down = await enqueuePriorityCard(
      { source: "pangmao", card: { id: 1 }, meta: { via: "text", yield_pct: null } },
      {
        baseUrl: "http://127.0.0.1:8787",
        secret: "test-secret",
        log: { warn: (m) => warns.push(String(m)), info() {} },
        fetchImpl: async () => {
          throw new Error("connect ECONNREFUSED");
        },
      },
    );
    assert.equal(down.ok, false);
    assert.match(warns[0], /不可达/);
    assert.equal(warns[0].includes("test-secret"), false);

    const http = await enqueuePriorityCard(
      { source: "pangmao", card: { id: 1 }, meta: { via: "text", yield_pct: null } },
      {
        baseUrl: "http://127.0.0.1:8787",
        secret: "test-secret",
        log: { warn() {}, info() {} },
        fetchImpl: async () => /** @type {Response} */ ({ ok: false, status: 503 }),
      },
    );
    assert.equal(http.error, "HTTP 503");
  });
});
