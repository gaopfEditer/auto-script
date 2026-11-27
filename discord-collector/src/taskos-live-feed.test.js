import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { after, test } from "node:test";
import WebSocket from "ws";
import { createTaskosLiveFeedServer } from "./taskos-live-feed-server.js";
import {
  AUTOSCRIPT_CARD_SOURCE,
  AUTOSCRIPT_CDP_SOURCE,
  AUTOSCRIPT_ORDER_SOURCE,
  feedSourceList,
  loadFeedItemsFromFiles,
  mapCollectUiCard,
  mapCollectUiMessage,
  mapPipelineAuditRow,
  mapPublishLogRow,
  cdpQueueJobId,
  mapRangePendingItem,
  mapTradeAuditRow,
  matchKolvipAutotradeChannel,
  autoscriptOrderItemId,
  mergePriorityItems,
  orderItemMeaningfullyChanged,
} from "./taskos-live-feed.js";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "taskos-live-feed-"));
after(() => { fs.rmSync(tmp, { recursive: true, force: true }); });

test("whitelist matches only the six autotrade channels", () => {
  assert.equal(matchKolvipAutotradeChannel({ channelId: "kolvip-scan-39" })?.name, "华尔街女王");
  assert.equal(matchKolvipAutotradeChannel({ channelName: "零下二度VIP禁言群" })?.sourceId, "kolvip_lingxia");
  assert.equal(matchKolvipAutotradeChannel({ messageId: "kolvip-31-123" })?.name, "FX-黄金信号");
  assert.equal(matchKolvipAutotradeChannel({ channelName: "kacang-团队" })?.key, "kacang");
  assert.equal(matchKolvipAutotradeChannel({ channelId: "1444967547169669160" })?.name, "币安杀手");
  assert.equal(matchKolvipAutotradeChannel({ channelName: "熬鹰" })?.sourceId, "kolvip_aoying");
  assert.equal(matchKolvipAutotradeChannel({ channelName: "btc乔乔", channelId: "kolvip-scan-44" }), null);
  assert.equal(feedSourceList().filter((s) => s.id.startsWith("kolvip_")).length, 6);
});

test("pipeline English card and failed trade map to feed items", () => {
  const created = mapPipelineAuditRow({
    at: "2026-11-24T18:42:52.271Z",
    event: "card_create",
    channelId: "kolvip-scan-39",
    channelName: "华尔街女王",
    cardId: 3134,
    messageId: "kolvip-39-37159",
    symbol: "XAUUSDT",
    direction: "SHORT",
    result: "created",
  });
  assert.equal(created.length, 2);
  assert.equal(created[0].source, AUTOSCRIPT_CARD_SOURCE.id);
  assert.equal(created[1].source, "kolvip_huajie");
  assert.equal(created[0].card.symbol, "XAUUSDT");
  assert.equal(created[0].card.direction, "SHORT");

  const trade = mapPipelineAuditRow({
    at: "2026-11-24T18:42:52.271Z",
    event: "trade",
    channelId: "kolvip-scan-39",
    channelName: "华尔街女王",
    cardId: 3134,
    target: "bitget",
    result: "attempted",
    reason: "invalid_symbol_or_direction",
  });
  assert.equal(trade.length, 1);
  assert.equal(trade[0].source, AUTOSCRIPT_ORDER_SOURCE.id);
  assert.equal(trade[0].card.reason, "invalid_symbol_or_direction");
  assert.equal(trade[0].card.exchange, "bitget");
  assert.equal(trade[0].id, "order:bitget:3134");
});

test("ingest from non-whitelist is ignored; whitelist becomes message detail", () => {
  assert.deepEqual(mapPipelineAuditRow({
    event: "ingest",
    channelId: "kolvip-scan-44",
    channelName: "btc乔乔",
    messageId: "kolvip-44-1",
    result: "parse_failed",
  }), []);
  const rows = mapPipelineAuditRow({
    at: "2026-11-25T01:00:00.000Z",
    event: "ingest",
    channelId: "kolvip-scan-27",
    messageId: "kolvip-27-1",
    result: "ok",
  });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].source, "kolvip_aoying");
  assert.equal(rows[0].meta.kind, "message");
});

test("trade audit and pending range map order statuses", () => {
  const failed = mapTradeAuditRow({
    at: "2026-11-24T18:42:52.261Z",
    exchange: "weex",
    event: "order_persist",
    cardId: 3134,
    symbol: "XAUUSDT",
    direction: "SHORT",
    bitgetOrder: { status: "failed", reason: "invalid_symbol_or_direction" },
  });
  assert.equal(failed.source, AUTOSCRIPT_ORDER_SOURCE.id);
  assert.equal(failed.card.status, "failed");
  assert.equal(failed.card.exchange, "weex");
  assert.equal(failed.id, "order:weex:3134");
  const pending = mapRangePendingItem({
    key: "bitget:3117",
    exchange: "bitget",
    cardId: 3117,
    symbol: "XAUUSD",
    direction: "SELL",
    status: "waiting",
    createdAt: "2026-11-25T01:00:00.000Z",
    range: { low: 3568, high: 3590 },
  });
  assert.equal(pending.card.status, "waiting");
  assert.match(String(pending.card.text), /待触发区间市价/);
  assert.equal(pending.id, "order:bitget:3117");
  assert.equal(mapRangePendingItem({ ...pending.card, status: "filled" }), null);
});

test("repeated order_persist rows for the same venue+card upsert instead of appending new cards", () => {
  const base = {
    exchange: "bitget",
    event: "order_persist",
    cardId: 3141,
    symbol: "MMT",
    direction: "long",
    bitgetOrder: { status: "tpsl_set", openOrderId: "1509314912147116033" },
  };
  const first = mapTradeAuditRow({ ...base, at: "2026-11-25T05:12:34.899Z" });
  const again = mapTradeAuditRow({ ...base, at: "2026-11-25T10:44:53.536Z" });
  assert.equal(first.id, "order:bitget:3141");
  assert.equal(again.id, first.id);
  assert.notEqual(first.createdAt, again.createdAt);
  const filled = mapTradeAuditRow({
    ...base,
    at: "2026-11-25T10:45:00.000Z",
    bitgetOrder: { status: "filled", openOrderId: "1509314912147116033" },
  });
  assert.equal(filled.id, first.id);
  assert.equal(orderItemMeaningfullyChanged(first, again), false);
  assert.equal(orderItemMeaningfullyChanged(first, filled), true);

  const pending = mapRangePendingItem({
    key: "bitget:3141",
    exchange: "bitget",
    cardId: 3141,
    symbol: "MMT",
    direction: "long",
    status: "waiting",
    createdAt: "2026-11-25T02:40:00.000Z",
    range: { low: 0.22, high: 0.23 },
  });
  assert.equal(pending.id, "order:bitget:3141");
  const merged = mergePriorityItems([pending, first], [again, filled]);
  assert.equal(merged.length, 1);
  assert.equal(merged[0].card.status, "filled");
  assert.equal(merged[0].createdAt, "2026-11-25T10:45:00.000Z");

  const weex = mapTradeAuditRow({
    at: "2026-11-25T05:12:34.899Z",
    exchange: "weex",
    event: "order_persist",
    cardId: 3141,
    bitgetOrder: { status: "failed" },
  });
  assert.equal(weex.id, "order:weex:3141");
  assert.equal(mergePriorityItems([filled], [weex]).map((it) => it.id).sort().join(","), "order:bitget:3141,order:weex:3141");
});


test("CDP publish logs keep results and drop connect_ok noise", () => {
  assert.equal(mapPublishLogRow({ event: "cdp_connect_ok", message: "CDP 已连接", ts: "2026-11-24T23:04:16+08:00" }), null);
  assert.equal(mapPublishLogRow({ event: "platform_start", platform: "gate", ts: "2026-11-24T23:04:16+08:00" }), null);
  const fail = mapPublishLogRow({
    event: "platform_fail",
    platform: "x",
    platform_name: "X / Twitter",
    message: "chrome-error://chromewebdata/",
    job_id: "abc",
    ts: "2026-11-24T23:06:09+08:00",
    failure_category: "error",
  });
  assert.equal(fail.source, AUTOSCRIPT_CDP_SOURCE.id);
  assert.equal(fail.card.status, "fail");
  assert.equal(fail.card.platform, "X / Twitter");
  assert.equal(fail.id, "cdp:platform_fail:abc:x");
});

test("run_end maps flat signal meta and sanitizes colon in content_ref job id", () => {
  const withJob = mapPublishLogRow({
    event: "run_end",
    job_id: "791282228fe147959a99977a4d0f65bc",
    content_ref: "body:d696ec2d9de5",
    success_count: 2,
    total: 4,
    message: "发布结束 成功 2/4",
    ts: "2026-11-27T10:57:19+08:00",
    channel: "FX-黄金信号",
    symbol: "XAU",
    direction: "做空",
    cardOpenedAt: "2026-11-27T02:50:00+08:00",
    cardId: "3148",
  });
  assert.equal(withJob.id, "cdp:run_end:791282228fe147959a99977a4d0f65bc:all");
  assert.equal(withJob.source, AUTOSCRIPT_CDP_SOURCE.id);
  assert.equal(withJob.meta.event, "run_end");
  assert.equal(withJob.meta.channel, "FX-黄金信号");
  assert.equal(withJob.meta.symbol, "XAU");
  assert.equal(withJob.meta.direction, "做空");
  assert.equal(withJob.meta.cardOpenedAt, "2026-11-27T02:50:00+08:00");
  assert.equal(withJob.meta.cardId, "3148");
  assert.equal(withJob.meta.successCount, 2);
  assert.equal(withJob.meta.total, 4);
  assert.equal(withJob.card.channel, "FX-黄金信号");
  assert.equal(withJob.card.symbol, "XAU");
  assert.equal(withJob.card.direction, "做空");
  assert.equal(withJob.card.cardId, "3148");
  assert.equal(withJob.meta.jobId, "791282228fe147959a99977a4d0f65bc");

  const noJob = mapPublishLogRow({
    event: "run_end",
    content_ref: "body:3913295ed88c",
    success_count: 2,
    total: 4,
    message: "发布结束 成功 2/4",
    ts: "2026-11-27T11:50:52+08:00",
  });
  assert.equal(cdpQueueJobId({ content_ref: "body:3913295ed88c" }), "body-3913295ed88c");
  assert.equal(noJob.id, "cdp:run_end:body-3913295ed88c:all");
  assert.equal(noJob.meta.jobId, "body-3913295ed88c");
  assert.equal(noJob.meta.successCount, 2);
  assert.equal(noJob.meta.total, 4);
  assert.equal(noJob.meta.channel, undefined);
  assert.equal(noJob.meta.cardId, undefined);
});

test("collect UI card/message mapping stays on whitelist for channel rows", () => {
  const cards = mapCollectUiCard({
    id: 3134,
    channelId: "kolvip-scan-39",
    channelName: "华尔街女王",
    createdAt: "2026-11-24T18:42:52.271Z",
    parsedJson: { symbol: "XAUUSDT", direction: "SHORT", entry: "3568$ - 3590$" },
    body: "Coin: #XAUUSDT Direction: SHORT",
  });
  assert.equal(cards[0].source, AUTOSCRIPT_CARD_SOURCE.id);
  assert.equal(cards[1].source, "kolvip_huajie");
  assert.equal(cards[0].card.entry, "3568$ - 3590$");
  const other = mapCollectUiMessage({
    channelId: "kolvip-scan-44",
    content: "hello",
    messageId: "x",
  });
  assert.equal(other, null);
  const msg = mapCollectUiMessage({
    channelId: "kolvip-scan-33",
    content: "Gold buy now @3619-3615",
    messageId: "kolvip-33-1",
    createdAtMs: 1795005300000,
  });
  assert.equal(msg.source, "kolvip_kacang");
  assert.match(msg.card.text, /Gold buy now/);
});

test("file loader reads jsonl and pending, and hides secrets", () => {
  const pipelineDir = path.join(tmp, "pipe");
  const tradeDir = path.join(tmp, "trade");
  const publishDir = path.join(tmp, "pub");
  fs.mkdirSync(pipelineDir);
  fs.mkdirSync(tradeDir);
  fs.mkdirSync(publishDir);
  const day = "2026-11-25";
  fs.writeFileSync(path.join(pipelineDir, `${day}.jsonl`), `${JSON.stringify({
    at: "2026-11-25T01:00:00.000Z",
    event: "card_create",
    channelId: "kolvip-scan-31",
    cardId: 9,
    symbol: "XAUUSD",
    direction: "BUY",
    apiKey: "should-not-appear",
  })}\n`);
  fs.writeFileSync(path.join(tradeDir, `${day}.jsonl`), `${JSON.stringify({
    at: "2026-11-25T01:01:00.000Z",
    exchange: "bitget",
    event: "order_persist",
    cardId: 9,
    bitgetOrder: { status: "filled" },
  })}\n`);
  fs.writeFileSync(path.join(publishDir, `publish_${day}.log`), `${JSON.stringify({
    event: "run_end",
    success_count: 0,
    total: 4,
    message: "发布结束 成功 0/4",
    ts: "2026-11-25T08:00:00+08:00",
    job_id: "j1",
  })}\n`);
  const pendingPath = path.join(tmp, "range-entry-pending.json");
  fs.writeFileSync(pendingPath, JSON.stringify({
    items: { "weex:9": { key: "weex:9", exchange: "weex", cardId: 9, status: "waiting", createdAt: "2026-11-25T01:02:00.000Z", range: { low: 1, high: 2 } } },
  }));
  const items = loadFeedItemsFromFiles({
    pipelineDir,
    tradeDir,
    publishDir,
    pendingPath,
    now: new Date("2026-11-25T12:00:00+08:00"),
    days: 1,
  });
  const sources = new Set(items.map((i) => i.source));
  assert.equal(sources.has(AUTOSCRIPT_CARD_SOURCE.id), true);
  assert.equal(sources.has(AUTOSCRIPT_ORDER_SOURCE.id), true);
  assert.equal(sources.has(AUTOSCRIPT_CDP_SOURCE.id), true);
  assert.equal(sources.has("kolvip_fxgold"), true);
  assert.equal(JSON.stringify(items).includes("should-not-appear"), false);
  assert.equal(JSON.stringify(items).includes("apiKey"), false);
});

test("HTTP and WS follow the pangmao priority protocol", async () => {
  const pipelineDir = path.join(tmp, "srv-pipe");
  fs.mkdirSync(pipelineDir, { recursive: true });
  const day = "2026-11-25";
  fs.writeFileSync(path.join(pipelineDir, `${day}.jsonl`), `${JSON.stringify({
    at: "2026-11-25T02:00:00.000Z",
    event: "card_create",
    channelId: "kolvip-scan-37",
    cardId: 42,
    symbol: "ETHUSDT",
    direction: "做空",
  })}\n`);
  const svc = createTaskosLiveFeedServer({
    port: 0,
    host: "127.0.0.1",
    secret: "",
    disableCollectUi: true,
    mirrorRelay: false,
    paths: {
      pipelineDir,
      tradeDir: path.join(tmp, "missing-trade"),
      publishDir: path.join(tmp, "missing-pub"),
      pendingPath: path.join(tmp, "missing-pending.json"),
    },
    log: { info() {}, warn() {} },
  });
  await svc.start();
  const addr = svc.server.address();
  const port = addr.port;
  try {
    const sources = await (await fetch(`http://127.0.0.1:${port}/queue/priority/sources`)).json();
    assert.equal(sources.sources[0].id, AUTOSCRIPT_CARD_SOURCE.id);
    assert.equal(sources.sources.some((s) => s.id === "kolvip_binancekiller"), true);
    const queue = await (await fetch(`http://127.0.0.1:${port}/queue/priority?source=autoscript_cards&limit=50`)).json();
    assert.equal(queue.items.length, 1);
    assert.equal(queue.items[0].type, "priority_card");
    assert.equal(queue.items[0].card.symbol, "ETHUSDT");
    const ch = await (await fetch(`http://127.0.0.1:${port}/queue/priority?source=kolvip_binancekiller`)).json();
    assert.equal(ch.items.length, 1);

    const got = [];
    await new Promise((resolve, reject) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/ws/priority`);
      const timer = setTimeout(() => reject(new Error("ws timeout")), 4000);
      ws.on("open", () => {
        svc.publishNew([{
          type: "priority_card",
          id: "cdp:test:1",
          source: AUTOSCRIPT_CDP_SOURCE.id,
          createdAt: "2026-11-25T03:00:00.000Z",
          card: { title: "OKX 失败", text: "未登录", status: "fail", platform: "OKX" },
          meta: { kind: "cdp", event: "platform_fail" },
        }]);
      });
      ws.on("message", (raw) => {
        got.push(JSON.parse(String(raw)));
        clearTimeout(timer);
        ws.close();
        resolve();
      });
      ws.on("error", reject);
    });
    assert.equal(got[0].source, AUTOSCRIPT_CDP_SOURCE.id);
    assert.equal(got[0].type, "priority_card");
  } finally {
    await svc.close();
  }
});

test("publishNew does not emit another card when the same order is re-persisted", async () => {
  const svc = createTaskosLiveFeedServer({
    port: 0,
    host: "127.0.0.1",
    secret: "",
    disableCollectUi: true,
    mirrorRelay: false,
    paths: {
      pipelineDir: path.join(tmp, "missing-pipe-2"),
      tradeDir: path.join(tmp, "missing-trade-2"),
      publishDir: path.join(tmp, "missing-pub-2"),
      pendingPath: path.join(tmp, "missing-pending-2.json"),
    },
    log: { info() {}, warn() {} },
  });
  await svc.start();
  try {
    const first = mapTradeAuditRow({
      at: "2026-11-25T05:12:34.899Z",
      exchange: "bitget",
      event: "order_persist",
      cardId: 3141,
      symbol: "MMT",
      direction: "long",
      bitgetOrder: { status: "tpsl_set" },
    });
    const repeat = mapTradeAuditRow({
      at: "2026-11-25T10:44:53.536Z",
      exchange: "bitget",
      event: "order_persist",
      cardId: 3141,
      symbol: "MMT",
      direction: "long",
      bitgetOrder: { status: "tpsl_set" },
    });
    const filled = mapTradeAuditRow({
      at: "2026-11-25T10:45:00.000Z",
      exchange: "bitget",
      event: "order_persist",
      cardId: 3141,
      symbol: "MMT",
      direction: "long",
      bitgetOrder: { status: "filled" },
    });
    assert.deepEqual(svc.publishNew([first], { mirror: false }).map((it) => it.id), ["order:bitget:3141"]);
    assert.deepEqual(svc.publishNew([repeat], { mirror: false }), []);
    const orders = svc.getItems().filter((it) => it.source === AUTOSCRIPT_ORDER_SOURCE.id);
    assert.equal(orders.length, 1);
    assert.equal(orders[0].card.status, "tpsl_set");
    assert.equal(orders[0].createdAt, "2026-11-25T05:12:34.899Z");
    const updated = svc.publishNew([filled], { mirror: false });
    assert.equal(updated.length, 1);
    assert.equal(updated[0].card.status, "filled");
    assert.equal(svc.getItems().filter((it) => it.source === AUTOSCRIPT_ORDER_SOURCE.id).length, 1);
  } finally {
    await svc.close();
  }
});
