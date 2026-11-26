/**
 * task-os 气泡实时源：把 auto-script 卡片、挂单/下单、CDP 发布日志，
 * 以及 kolvip 白名单频道的消息/卡片，映射成与胖猫优先队列相同的 priority_card。
 * 只读已有审计、发布日志、pending 文件和本机 collect:ui；不改实盘跟单。
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const _dir = path.dirname(fileURLToPath(import.meta.url));

export const DISPLAY_TIME_ZONE = "Asia/Hong_Kong";
export const DEFAULT_FEED_PORT = 3852;
export const QUEUE_LIMIT = 200;

export const AUTOSCRIPT_CARD_SOURCE = Object.freeze({ id: "autoscript_cards", name: "信号卡片" });
export const AUTOSCRIPT_ORDER_SOURCE = Object.freeze({ id: "autoscript_orders", name: "自动挂单/下单" });
export const AUTOSCRIPT_CDP_SOURCE = Object.freeze({ id: "autoscript_cdp", name: "CDP 发布" });

export const KOLVIP_AUTOTRADE_CHANNELS = Object.freeze([
  Object.freeze({
    key: "huajie",
    sourceId: "kolvip_huajie",
    name: "华尔街女王",
    patterns: Object.freeze(["华尔街女王"]),
    channelIds: Object.freeze(["kolvip-scan-39", "1444967575858581545"]),
    kolvipId: "39",
  }),
  Object.freeze({
    key: "lingxia",
    sourceId: "kolvip_lingxia",
    name: "零下二度VIP禁言群",
    patterns: Object.freeze(["零下二度"]),
    channelIds: Object.freeze(["kolvip-scan-13", "1559133861617602630"]),
    kolvipId: "13",
  }),
  Object.freeze({
    key: "kacang",
    sourceId: "kolvip_kacang",
    name: "kacang-团队",
    patterns: Object.freeze(["kacang"]),
    channelIds: Object.freeze(["kolvip-scan-33"]),
    kolvipId: "33",
  }),
  Object.freeze({
    key: "fx_gold",
    sourceId: "kolvip_fxgold",
    name: "FX-黄金信号",
    patterns: Object.freeze(["FX-黄金", "黄金信号"]),
    channelIds: Object.freeze(["kolvip-scan-31"]),
    kolvipId: "31",
  }),
  Object.freeze({
    key: "binance_killer",
    sourceId: "kolvip_binancekiller",
    name: "币安杀手",
    patterns: Object.freeze(["币安杀手"]),
    channelIds: Object.freeze(["kolvip-scan-37", "1444967547169669160"]),
    kolvipId: "37",
  }),
  Object.freeze({
    key: "aoying",
    sourceId: "kolvip_aoying",
    name: "熬鹰",
    patterns: Object.freeze(["熬鹰"]),
    channelIds: Object.freeze(["kolvip-scan-27"]),
    kolvipId: "27",
  }),
]);

export const AUTOSCRIPT_FEED_SOURCES = Object.freeze([
  AUTOSCRIPT_CARD_SOURCE,
  AUTOSCRIPT_ORDER_SOURCE,
  AUTOSCRIPT_CDP_SOURCE,
]);

const SECRET_KEY = /(token|secret|api[_-]?key|cookie|password|authorization|webhook|passphrase)/i;
const CDP_KEEP = new Set([
  "platform_ok",
  "platform_fail",
  "platform_success",
  "run_end",
  "cdp_connect_fail",
]);

export function defaultPipelineAuditDir() {
  return path.join(_dir, "..", "data", "kolvip-pipeline-audit");
}

export function defaultTradeAuditDir() {
  return path.join(_dir, "..", "data", "bitget-trade-audit");
}

export function defaultRangePendingPath() {
  return path.join(_dir, "..", "data", "range-entry-pending.json");
}

export function defaultPublishLogDir() {
  return path.resolve(_dir, "..", "..", "..", "python-ai-operate", "output", "publish_logs");
}

export function hongKongDay(d = new Date()) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: DISPLAY_TIME_ZONE,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
}

export function hongKongDayOffset(days, from = new Date()) {
  return hongKongDay(new Date(from.getTime() + days * 86400000));
}

/** @param {{ channelId?: unknown, channelName?: unknown, messageId?: unknown }} row */
export function matchKolvipAutotradeChannel(row = {}) {
  const id = String(row.channelId ?? row.channel_id ?? "").trim();
  const name = String(row.channelName ?? row.channel_name ?? "").trim();
  const mid = String(row.messageId ?? row.message_id ?? "").trim();
  for (const ch of KOLVIP_AUTOTRADE_CHANNELS) {
    if (id && ch.channelIds.includes(id)) return ch;
    if (id && id === `kolvip-scan-${ch.kolvipId}`) return ch;
    if (mid && mid.startsWith(`kolvip-${ch.kolvipId}-`)) return ch;
    if (name && ch.patterns.some((p) => name.includes(p))) return ch;
  }
  return null;
}

export function isAutoscriptFeedSourceId(id) {
  const s = String(id || "");
  return AUTOSCRIPT_FEED_SOURCES.some((x) => x.id === s)
    || KOLVIP_AUTOTRADE_CHANNELS.some((x) => x.sourceId === s);
}

export function feedSourceList() {
  return [
    ...AUTOSCRIPT_FEED_SOURCES.map((s) => ({ id: s.id, name: s.name })),
    ...KOLVIP_AUTOTRADE_CHANNELS.map((s) => ({ id: s.sourceId, name: s.name })),
  ];
}

function clip(v, max = 280) {
  if (v == null) return "";
  const s = typeof v === "string" ? v : (() => {
    try { return JSON.stringify(v); } catch { return String(v); }
  })();
  return s.length > max ? `${s.slice(0, max)}…` : s;
}

function cleanFields(obj) {
  if (!obj || typeof obj !== "object" || Array.isArray(obj)) return {};
  /** @type {Record<string, unknown>} */
  const out = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v == null || v === "") continue;
    if (SECRET_KEY.test(k)) continue;
    if (typeof v === "string" && SECRET_KEY.test(v) && /https?:\/\//i.test(v)) continue;
    out[k] = typeof v === "string" ? clip(v) : v;
  }
  return out;
}

function isoOf(...vals) {
  for (const v of vals) {
    if (v == null || v === "") continue;
    if (typeof v === "number" && Number.isFinite(v)) {
      const n = v < 1e12 ? v * 1000 : v;
      const d = new Date(n);
      if (!Number.isNaN(d.getTime())) return d.toISOString();
    }
    const s = String(v).trim();
    if (!s) continue;
    const d = new Date(s);
    if (!Number.isNaN(d.getTime())) return d.toISOString();
  }
  return "";
}

function firstText(...vals) {
  for (const v of vals) {
    if (v == null) continue;
    const s = String(v).trim();
    if (s) return s;
  }
  return "";
}

/**
 * @param {string} id
 * @param {string} source
 * @param {string} createdAt
 * @param {Record<string, unknown>} card
 * @param {Record<string, unknown>} meta
 */

/**
 * Stable id for 自动挂单/下单 rows: venue + cardId (or order/client id).
 * Timestamps must not be part of the id, or each order_persist poll appends a new card.
 */
export function autoscriptOrderItemId(row = {}, extras = {}) {
  const order = (row && row.bitgetOrder && typeof row.bitgetOrder === "object")
    ? row.bitgetOrder
    : (extras.order && typeof extras.order === "object" ? extras.order : {});
  const exchange = firstText(
    extras.exchange,
    row && row.exchange,
    row && row.target,
    order.exchange,
    "bitget",
  ).toLowerCase() || "x";
  const key = firstText(
    extras.cardId,
    row && row.cardId != null ? String(row.cardId) : "",
    row && row.card_id,
    order.openOrderId,
    order.orderId,
    order.order_id,
    row && row.orderId,
    row && row.openOrderId,
    order.clientOid,
    order.client_oid,
    row && row.clientOid,
    extras.fallback,
  );
  if (!key) return "";
  return `order:${exchange}:${key}`;
}

export function orderItemFingerprint(item) {
  const card = item && item.card && typeof item.card === "object" ? item.card : {};
  const meta = item && item.meta && typeof item.meta === "object" ? item.meta : {};
  return [
    card.status, card.reason, card.title, card.text, card.entry,
    card.symbol, card.direction, card.exchange, card.cardId,
    meta.event, meta.result, meta.reason,
  ].map((v) => String(v == null ? "" : v)).join("\0");
}

export function orderItemMeaningfullyChanged(prev, next) {
  if (!prev || !next) return true;
  return orderItemFingerprint(prev) !== orderItemFingerprint(next);
}

export function preferNewerPriorityItem(prev, next) {
  if (!next) return prev;
  if (!prev) return next;
  const ta = Date.parse(next.createdAt || "") || 0;
  const tb = Date.parse(prev.createdAt || "") || 0;
  return ta >= tb ? next : prev;
}

export function priorityCard(id, source, createdAt, card, meta) {
  if (!id || !source) return null;
  return {
    type: "priority_card",
    id: String(id),
    source: String(source),
    createdAt: createdAt || "",
    card: cleanFields(card),
    meta: cleanFields(meta),
  };
}

export function mapPipelineAuditRow(row) {
  if (!row || typeof row !== "object") return [];
  const ev = String(row.event || "").trim();
  const ch = matchKolvipAutotradeChannel(row);
  const at = isoOf(row.at);
  const symbol = firstText(row.symbol);
  const direction = firstText(row.direction);
  const channelName = firstText(row.channelName, ch?.name);
  const cardId = row.cardId != null ? String(row.cardId) : "";
  const messageId = firstText(row.messageId);
  const out = [];

  if (ev === "card_create") {
    const text = [symbol, direction, channelName, cardId && `#${cardId}`].filter(Boolean).join(" · ");
    const card = {
      symbol,
      direction,
      title: cardId ? `卡片 #${cardId}` : "信号卡片",
      text: text || "已建卡",
      channel: channelName,
      cardId,
    };
    const meta = { kind: "card", via: "card", event: ev, result: row.result, messageId, channelId: row.channelId };
    out.push(priorityCard(`card:${cardId || messageId || at}`, AUTOSCRIPT_CARD_SOURCE.id, at, card, meta));
    if (ch) {
      out.push(priorityCard(`chcard:${ch.sourceId}:${cardId || messageId || at}`, ch.sourceId, at, card, { ...meta, kind: "card" }));
    }
    return out.filter(Boolean);
  }

  if ((ev === "ingest" || ev === "tg_push") && ch) {
    const result = firstText(row.result, row.reason);
    const text = firstText(row.text, row.content, row.preview)
      || [ev === "tg_push" ? "已推送" : "消息入库", result, messageId].filter(Boolean).join(" · ");
    out.push(priorityCard(
      `msg:${ch.sourceId}:${messageId || at}`,
      ch.sourceId,
      at,
      { title: ev === "tg_push" ? "推送" : "消息", text, channel: ch.name, messageId },
      { kind: "message", via: "message", event: ev, result, reason: row.reason, messageId, channelId: row.channelId },
    ));
    return out.filter(Boolean);
  }

  if (ev === "trade" || ev === "trade_gate") {
    const exchange = firstText(row.target, row.exchange);
    const status = ev === "trade_gate"
      ? firstText(row.result, "gate")
      : firstText(row.result, row.reason, "attempted");
    const reason = firstText(row.reason, row.detail);
    const title = ev === "trade_gate" ? "下单门禁" : "自动下单";
    const text = [exchange || "交易所", status, reason, symbol, direction, cardId && `#${cardId}`]
      .filter(Boolean).join(" · ");
    out.push(priorityCard(
      autoscriptOrderItemId(row, { exchange: exchange || "x", cardId, fallback: messageId || at }),
      AUTOSCRIPT_ORDER_SOURCE.id,
      at,
      { symbol, direction, title, text, status, exchange, reason, cardId, channel: channelName },
      { kind: "order", via: "order", event: ev, result: row.result, reason, exchange, cardId },
    ));
    return out.filter(Boolean);
  }

  return out;
}

export function mapTradeAuditRow(row) {
  if (!row || typeof row !== "object") return null;
  const at = isoOf(row.at);
  const exchange = firstText(row.exchange, "bitget");
  const order = row.bitgetOrder && typeof row.bitgetOrder === "object" ? row.bitgetOrder : {};
  const status = firstText(order.status, row.status, row.event, "unknown");
  const reason = firstText(order.reason, order.error, row.error, row.reason);
  const symbol = firstText(row.symbol, order.symbol);
  let direction = firstText(row.direction, order.side, order.direction);
  if (direction && direction.length > 16 && !/^(long|short|buy|sell|做多|做空|多|空)$/i.test(direction)) {
    direction = direction.slice(0, 16);
  }
  const cardId = row.cardId != null ? String(row.cardId) : "";
  const dry = row.dryRun === true ? "演练" : "";
  const margin = row.orderSizeUsdt != null ? `${row.orderSizeUsdt}U` : "";
  const title = `${exchange.toUpperCase()} ${status}`;
  const text = [dry, margin, reason, cardId && `#${cardId}`].filter(Boolean).join(" · ");
  return priorityCard(
    autoscriptOrderItemId(row, { exchange, cardId, fallback: at || firstText(row.event) }),
    AUTOSCRIPT_ORDER_SOURCE.id,
    at,
    { symbol, direction, title, text, status, exchange, reason, cardId, channel: firstText(row.channelName) },
    { kind: "order", via: "order", event: firstText(row.event, "order_persist"), result: status, reason, exchange, dryRun: row.dryRun === true },
  );
}

export function mapRangePendingItem(item) {
  if (!item || typeof item !== "object") return null;
  const statusRaw = firstText(item.status, "waiting");
  if (statusRaw !== "waiting") return null;
  const exchange = firstText(item.exchange, "bitget");
  const cardId = item.cardId != null ? String(item.cardId) : "";
  const symbol = firstText(item.symbol);
  const direction = firstText(item.direction);
  const low = item.range && item.range.low != null ? item.range.low : item.low ?? item.entryLow;
  const high = item.range && item.range.high != null ? item.range.high : item.high ?? item.entryHigh;
  const range = (low != null && high != null) ? `${low}–${high}` : firstText(item.entry, item.entryRange);
  const at = isoOf(item.updatedAt, item.createdAt);
  const text = ["待触发区间市价", range, cardId && `#${cardId}`].filter(Boolean).join(" · ");
  return priorityCard(
    autoscriptOrderItemId(item, { exchange, cardId, fallback: firstText(item.key, at) }),
    AUTOSCRIPT_ORDER_SOURCE.id,
    at,
    { symbol, direction, title: `${exchange.toUpperCase()} 待触发`, text, status: "waiting", exchange, reason: "awaiting_range_entry", cardId, entry: range },
    { kind: "order", via: "order", event: "range_pending", result: "waiting", exchange, cardId },
  );
}

export function mapPublishLogRow(row) {
  if (!row || typeof row !== "object") return null;
  const ev = firstText(row.event);
  if (!CDP_KEEP.has(ev)) return null;
  const at = isoOf(row.ts, row.at, row.time);
  const platform = firstText(row.platform_name, row.platform);
  const result = ev === "platform_ok" || ev === "platform_success" || (ev === "run_end" && Number(row.success_count) > 0)
    ? "ok"
    : ev === "run_end"
      ? (row.aborted ? "aborted" : "fail")
      : "fail";
  const message = firstText(row.message);
  const job = firstText(row.job_id, row.content_ref, at);
  const title = platform ? `${platform} ${result === "ok" ? "成功" : "失败"}` : (ev === "run_end" ? "发布结束" : ev);
  const text = message || [ev, platform, result, row.success_count != null ? `${row.success_count}/${row.total ?? "?"}` : ""]
    .filter(Boolean).join(" · ");
  return priorityCard(
    `cdp:${ev}:${job}:${firstText(row.platform, "all")}`,
    AUTOSCRIPT_CDP_SOURCE.id,
    at,
    { title, text, status: result, platform, reason: firstText(row.failure_category, row.step) },
    { kind: "cdp", via: "cdp", event: ev, result, platform, jobId: job },
  );
}

export function mapCollectUiCard(card) {
  if (!card || typeof card !== "object") return [];
  const parsed = (card.parsedJson && typeof card.parsedJson === "object") ? card.parsedJson : {};
  const cardId = card.id != null ? String(card.id) : firstText(card.uid);
  if (!cardId) return [];
  const symbol = firstText(parsed.symbol, parsed.asset, card.symbol);
  const direction = firstText(parsed.direction, card.direction);
  const ch = matchKolvipAutotradeChannel({
    channelId: card.channelId,
    channelName: card.channelName,
    messageId: card.messageId,
  });
  const at = isoOf(card.createdAt, card.created_at, card.telegramSentAt, card.updatedAt);
  const entry = firstText(parsed.entry, card.entry);
  const title = firstText(parsed.title, cardId && `卡片 #${cardId}`);
  const text = firstText(card.body, card.rawContent, [symbol, direction, entry].filter(Boolean).join(" "));
  const payload = {
    symbol,
    direction,
    title,
    text: clip(text, 200),
    entry,
    cardId,
    channel: firstText(card.channelName, ch?.name),
  };
  const meta = { kind: "card", via: "card", event: "card_create", messageId: card.messageId, channelId: card.channelId, status: card.status };
  const out = [
    priorityCard(`card:${cardId}`, AUTOSCRIPT_CARD_SOURCE.id, at, payload, meta),
  ];
  if (ch) {
    out.push(priorityCard(`chcard:${ch.sourceId}:${cardId}`, ch.sourceId, at, payload, meta));
  }
  return out.filter(Boolean);
}

export function mapCollectUiMessage(row) {
  if (!row || typeof row !== "object") return null;
  const ch = matchKolvipAutotradeChannel({
    channelId: row.channelId ?? row.channel_id,
    channelName: row.channelName ?? row.channel_name,
    messageId: row.messageId ?? row.message_id,
  });
  if (!ch) return null;
  const messageId = firstText(row.messageId, row.message_id, row.id);
  const at = isoOf(row.createdAt, row.created_at, row.createdAtMs, row.created_at_ms, row.at);
  const text = firstText(row.content, row.text, row.body, row.lastMessagePreview);
  return priorityCard(
    `msg:${ch.sourceId}:${messageId || at}`,
    ch.sourceId,
    at,
    {
      title: firstText(row.authorUsername, row.author, row.sender, "消息"),
      text: clip(text, 240) || "(无文本)",
      channel: ch.name,
      messageId,
    },
    { kind: "message", via: "message", event: "ingest", messageId, channelId: row.channelId ?? row.channel_id },
  );
}

export function readJsonlFile(filePath, mapFn) {
  const items = [];
  let raw;
  try {
    raw = fs.readFileSync(filePath, "utf8");
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return items;
    throw e;
  }
  for (const line of raw.split(/\n/)) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const mapped = mapFn(obj);
    if (!mapped) continue;
    if (Array.isArray(mapped)) items.push(...mapped.filter(Boolean));
    else items.push(mapped);
  }
  return items;
}

export function listDayFiles(dir, prefix, ext, days = 2, now = new Date()) {
  const names = [];
  for (let i = 0; i < days; i++) {
    const day = hongKongDayOffset(-i, now);
    names.push(path.join(dir, `${prefix}${day}${ext}`));
  }
  return names;
}

export function loadRangePendingItems(filePath = defaultRangePendingPath()) {
  try {
    const obj = JSON.parse(fs.readFileSync(filePath, "utf8"));
    const items = obj && obj.items && typeof obj.items === "object" ? Object.values(obj.items) : [];
    return items.map(mapRangePendingItem).filter(Boolean);
  } catch (e) {
    if (/** @type {NodeJS.ErrnoException} */ (e).code === "ENOENT") return [];
    return [];
  }
}

/**
 * @param {{
 *   pipelineDir?: string,
 *   tradeDir?: string,
 *   publishDir?: string,
 *   pendingPath?: string,
 *   now?: Date,
 *   days?: number,
 * }} [opts]
 */
export function loadFeedItemsFromFiles(opts = {}) {
  const days = Math.max(1, Number(opts.days) || 2);
  const now = opts.now || new Date();
  const items = [];
  for (const f of listDayFiles(opts.pipelineDir || defaultPipelineAuditDir(), "", ".jsonl", days, now)) {
    items.push(...readJsonlFile(f, mapPipelineAuditRow));
  }
  for (const f of listDayFiles(opts.tradeDir || defaultTradeAuditDir(), "", ".jsonl", days, now)) {
    items.push(...readJsonlFile(f, mapTradeAuditRow));
  }
  for (const f of listDayFiles(opts.publishDir || defaultPublishLogDir(), "publish_", ".log", days, now)) {
    items.push(...readJsonlFile(f, mapPublishLogRow));
  }
  items.push(...loadRangePendingItems(opts.pendingPath || defaultRangePendingPath()));
  return mergePriorityItems(items);
}

export function mergePriorityItems(existing, incoming) {
  const map = new Map();
  const order = [];
  function upsert(item) {
    if (!item || typeof item.id !== "string" || !item.id) return;
    if (!map.has(item.id)) {
      order.push(item.id);
      map.set(item.id, item);
      return;
    }
    const prev = map.get(item.id);
    if (item.source === AUTOSCRIPT_ORDER_SOURCE.id && prev && prev.source === AUTOSCRIPT_ORDER_SOURCE.id) {
      map.set(item.id, preferNewerPriorityItem(prev, item));
    } else {
      map.set(item.id, item);
    }
  }
  (existing || []).forEach(upsert);
  (incoming || []).forEach(upsert);
  return order.map((id) => map.get(id));
}

export function itemsForSource(items, sourceId, limit = QUEUE_LIMIT) {
  const rows = (items || [])
    .filter((it) => it && it.source === sourceId)
    .slice()
    .sort((a, b) => String(a.createdAt || "") < String(b.createdAt || "") ? -1 : 1);
  if (rows.length <= limit) return rows;
  return rows.slice(rows.length - limit);
}

export function queuePayload(items, sourceId, limit = QUEUE_LIMIT) {
  return { items: itemsForSource(items, sourceId, limit) };
}

export function sourcesPayload() {
  return { sources: feedSourceList() };
}
