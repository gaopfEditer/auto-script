/**
 * 本机对外优先队列兼容服务（与胖猫 msg-relay 协议对齐）：
 *   GET /queue/priority/sources
 *   GET /queue/priority?source=&limit=
 *   GET /health
 *   WS  /ws/priority?token=
 * 只读文件与 collect:ui，不重启、不接入第二套实盘。
 */
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import dotenv from "dotenv";
import { enqueuePriorityCard } from "./priority-queue-client.js";
import {
  DEFAULT_FEED_PORT,
  QUEUE_LIMIT,
  defaultPipelineAuditDir,
  defaultPublishLogDir,
  defaultRangePendingPath,
  defaultTradeAuditDir,
  hongKongDay,
  itemsForSource,
  loadFeedItemsFromFiles,
  loadRangePendingItems,
  mapCollectUiCard,
  mapCollectUiMessage,
  mapPipelineAuditRow,
  mapPublishLogRow,
  mapTradeAuditRow,
  mergePriorityItems,
  orderItemMeaningfullyChanged,
  queuePayload,
  readJsonlFile,
  sourcesPayload,
} from "./taskos-live-feed.js";

const __dir = path.dirname(fileURLToPath(import.meta.url));
const COLLECTOR_ROOT = path.resolve(__dir, "..");
const REPO_ROOT = path.resolve(COLLECTOR_ROOT, "..");

dotenv.config({ path: path.join(COLLECTOR_ROOT, ".env") });
dotenv.config({ path: path.join(REPO_ROOT, ".env") });

const SECRET_ENV_KEYS = ["TASKOS_LIVE_FEED_TOKEN", "PRIORITY_QUEUE_SECRET"];

function feedSecret() {
  for (const key of SECRET_ENV_KEYS) {
    const v = String(process.env[key] ?? "").trim();
    if (v) return v;
  }
  return "";
}

function feedPort() {
  const n = Number(process.env.TASKOS_LIVE_FEED_PORT ?? DEFAULT_FEED_PORT);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_FEED_PORT;
}

function collectUiBase() {
  const port = String(process.env.COLLECTOR_UI_PORT ?? "3851").trim() || "3851";
  return `http://127.0.0.1:${port}`;
}

function isLoopback(addr) {
  const s = String(addr || "");
  return s === "127.0.0.1" || s === "::1" || s === ":ffff:127.0.0.1" || s.endsWith("127.0.0.1");
}

function tokenFromRequest(req, url) {
  const header = String(req.headers.authorization ?? "").trim();
  const bearer = header.match(/^Bearer\s+(.+)$/i);
  if (bearer) return bearer[1].trim();
  const relay = String(req.headers["x-relay-secret"] ?? "").trim();
  if (relay) return relay;
  return String(url.searchParams.get("token") ?? "").trim();
}

function requestAllowed(req, url, secret) {
  const remote = req.socket && req.socket.remoteAddress;
  if (isLoopback(remote)) return true;
  if (!secret) return false;
  return tokenFromRequest(req, url) === secret;
}

function sendJson(res, status, body) {
  const text = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(text);
}

function capItems(items, limit = QUEUE_LIMIT) {
  const bySource = new Map();
  for (const item of items || []) {
    if (!item || !item.source) continue;
    if (!bySource.has(item.source)) bySource.set(item.source, []);
    bySource.get(item.source).push(item);
  }
  const out = [];
  for (const [source, rows] of bySource) {
    out.push(...itemsForSource(rows, source, limit));
  }
  return out;
}

/**
 * @param {{
 *   port?: number,
 *   host?: string,
 *   secret?: string,
 *   paths?: Record<string, string>,
 *   collectUiBase?: string,
 *   mirrorRelay?: boolean,
 *   log?: { info?: Function, warn?: Function },
 * }} [opts]
 */
export function createTaskosLiveFeedServer(opts = {}) {
  const log = opts.log || console;
  const secret = String(opts.secret ?? feedSecret()).trim();
  const disableCollect = opts.disableCollectUi === true;
  const paths = {
    pipelineDir: opts.paths?.pipelineDir || defaultPipelineAuditDir(),
    tradeDir: opts.paths?.tradeDir || defaultTradeAuditDir(),
    publishDir: opts.paths?.publishDir || defaultPublishLogDir(),
    pendingPath: opts.paths?.pendingPath || defaultRangePendingPath(),
  };
  let items = [];
  /** @type {Set<string>} */
  const knownIds = new Set();
  /** @type {Set<import("ws").WebSocket>} */
  const sockets = new Set();
  let fileOffsets = new Map();
  let closed = false;
  let timer = null;
  let lastWatchDay = "";
  let collectWs = null;
  let collectRetry = null;

  function snapshot() {
    items = capItems(loadFeedItemsFromFiles(paths), QUEUE_LIMIT);
    for (const it of items) if (it.id) knownIds.add(it.id);
    return items;
  }

  function publishNew(incoming, { mirror = true } = {}) {
    const fresh = [];
    const changed = [];
    const byId = new Map((items || []).map((it) => [it.id, it]));
    for (const it of incoming || []) {
      if (!it || !it.id) continue;
      if (!knownIds.has(it.id)) {
        knownIds.add(it.id);
        fresh.push(it);
        byId.set(it.id, it);
        continue;
      }
      const prev = byId.get(it.id);
      if (!orderItemMeaningfullyChanged(prev, it)) continue;
      changed.push(it);
      byId.set(it.id, it);
    }
    if (!fresh.length && !changed.length) return [];
    const outgoing = fresh.concat(changed);
    items = capItems(mergePriorityItems(items, outgoing), QUEUE_LIMIT);
    const payloadLines = outgoing.map((it) => JSON.stringify(it));
    for (const ws of sockets) {
      if (ws.readyState !== 1) continue;
      for (const line of payloadLines) {
        try { ws.send(line); } catch { /* ignore */ }
      }
    }
    if (mirror && opts.mirrorRelay !== false) {
      for (const it of fresh) {
        enqueuePriorityCard(
          { source: it.source, card: it.card, meta: it.meta },
          { log: { info: () => {}, warn: (m) => log.warn?.(m) } },
        ).catch(() => {});
      }
    }
    return outgoing;
  }

  function ingestNewLines(filePath, mapFn, lastSize) {
    let st;
    try { st = fs.statSync(filePath); } catch { return lastSize || 0; }
    const start = Math.min(lastSize || 0, st.size);
    if (st.size < start) return 0;
    if (st.size === start) return st.size;
    const buf = Buffer.alloc(st.size - start);
    const fd = fs.openSync(filePath, "r");
    try { fs.readSync(fd, buf, 0, buf.length, start); }
    finally { fs.closeSync(fd); }
    const chunk = buf.toString("utf8");
    const lines = chunk.split(/\n/).filter((l) => l.trim());
    const mapped = [];
    for (const line of lines) {
      try {
        const row = JSON.parse(line);
        const got = mapFn(row);
        if (Array.isArray(got)) mapped.push(...got.filter(Boolean));
        else if (got) mapped.push(got);
      } catch { /* skip */ }
    }
    publishNew(mapped);
    return st.size;
  }

  function watchFile(filePath, mapFn, key) {
    const k = key || filePath;
    try {
      const st = fs.statSync(filePath);
      fileOffsets.set(k, st.size);
    } catch {
      fileOffsets.set(k, 0);
    }
    try {
      return fs.watch(filePath, () => {
        const prev = fileOffsets.get(k) || 0;
        fileOffsets.set(k, ingestNewLines(filePath, mapFn, prev));
      });
    } catch {
      return null;
    }
  }

  const watchers = [];

  function todayFiles() {
    const day = hongKongDay();
    return [
      [path.join(paths.pipelineDir, `${day}.jsonl`), mapPipelineAuditRow],
      [path.join(paths.tradeDir, `${day}.jsonl`), mapTradeAuditRow],
      [path.join(paths.publishDir, `publish_${day}.log`), mapPublishLogRow],
    ];
  }

  function refreshWatches() {
    for (const w of watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    watchers.length = 0;
    for (const [file, mapFn] of todayFiles()) {
      const w = watchFile(file, mapFn);
      if (w) watchers.push(w);
    }
    const pending = paths.pendingPath;
    try {
      const w = fs.watch(path.dirname(pending), (_ev, name) => {
        if (name && !String(name).includes("range-entry-pending")) return;
        publishNew(loadRangePendingItems(pending));
      });
      watchers.push(w);
    } catch { /* pending dir may not exist yet */ }
  }

  async function fetchJson(url, timeoutMs = 5000) {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const res = await fetch(url, { signal: ac.signal, headers: { Accept: "application/json" } });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return await res.json();
    } finally {
      clearTimeout(t);
    }
  }

  async function pollCollectUi() {
    const base = opts.collectUiBase || collectUiBase();
    try {
      const data = await fetchJson(`${base}/api/cards?days=2&limit=200`);
      const cards = Array.isArray(data?.cards) ? data.cards : [];
      const mapped = cards.flatMap((c) => mapCollectUiCard(c));
      publishNew(mapped, { mirror: false });
    } catch { /* collect:ui may be busy */ }
    const channels = [
      "kolvip-scan-39", "kolvip-scan-13", "kolvip-scan-33",
      "kolvip-scan-31", "kolvip-scan-37", "kolvip-scan-27",
      "1444967575858581545", "1559133861617602630", "1444967547169669160",
    ];
    for (const channelId of channels) {
      try {
        const data = await fetchJson(
          `${base}/api/discord/messages?channelId=${encodeURIComponent(channelId)}&limit=80&order=desc&days=2`,
        );
        const rows = Array.isArray(data?.rows) ? data.rows : [];
        publishNew(rows.map(mapCollectUiMessage).filter(Boolean), { mirror: false });
      } catch { /* ignore per-channel */ }
    }
  }

  function openCollectWs() {
    if (closed) return;
    const base = opts.collectUiBase || collectUiBase();
    let wsUrl;
    try {
      const u = new URL("/ws", base);
      u.protocol = u.protocol === "https:" ? "wss:" : "ws:";
      wsUrl = u.toString();
    } catch { return; }
    import("ws").then(({ default: WS }) => {
      if (closed) return;
      try {
        collectWs = new WS(wsUrl);
      } catch { scheduleCollectRetry(); return; }
      collectWs.on("message", (raw) => {
        let msg;
        try { msg = JSON.parse(String(raw)); } catch { return; }
        if (!msg || typeof msg !== "object") return;
        if (msg.kind === "signal_card_created" && msg.card) {
          publishNew(mapCollectUiCard(msg.card));
        }
        if (msg.kind === "discord_message_batch" && Array.isArray(msg.rows)) {
          publishNew(msg.rows.map(mapCollectUiMessage).filter(Boolean));
        }
      });
      collectWs.on("close", () => { collectWs = null; scheduleCollectRetry(); });
      collectWs.on("error", () => { try { collectWs?.close(); } catch { /* ignore */ } });
    }).catch(() => scheduleCollectRetry());
  }

  function scheduleCollectRetry() {
    if (closed || collectRetry) return;
    collectRetry = setTimeout(() => {
      collectRetry = null;
      openCollectWs();
    }, 8000);
  }

  const server = http.createServer((req, res) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (req.method === "OPTIONS") {
      res.writeHead(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Headers": "Authorization, X-Relay-Secret, Content-Type",
        "Access-Control-Allow-Methods": "GET, OPTIONS",
      });
      res.end();
      return;
    }
    if (url.pathname === "/health") {
      sendJson(res, 200, {
        ok: true,
        sources: sourcesPayload().sources.length,
        items: items.length,
        port: feedPort(),
      });
      return;
    }
    if (!requestAllowed(req, url, secret)) {
      sendJson(res, 401, { error: "unauthorized" });
      return;
    }
    if (url.pathname === "/queue/priority/sources") {
      sendJson(res, 200, sourcesPayload());
      return;
    }
    if (url.pathname === "/queue/priority") {
      const source = String(url.searchParams.get("source") || "").trim();
      const limit = Number(url.searchParams.get("limit") || QUEUE_LIMIT);
      if (!source) {
        sendJson(res, 200, { items: capItems(items, limit) });
        return;
      }
      sendJson(res, 200, queuePayload(items, source, limit));
      return;
    }
    sendJson(res, 404, { error: "not_found" });
  });

  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "127.0.0.1"}`);
    if (url.pathname !== "/ws/priority") {
      socket.destroy();
      return;
    }
    if (!requestAllowed(req, url, secret)) {
      socket.write("HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => {
      sockets.add(ws);
      ws.on("close", () => sockets.delete(ws));
    });
  });

  function start() {
    snapshot();
    lastWatchDay = hongKongDay();
    refreshWatches();
    const host = opts.host || (secret ? "0.0.0.0" : "127.0.0.1");
    const port = opts.port ?? feedPort();
    return new Promise((resolve, reject) => {
      server.listen(port, host, () => {
        timer = setInterval(() => {
          try {
            const dayFiles = todayFiles();
            for (const [file, mapFn] of dayFiles) {
              const prev = fileOffsets.get(file);
              if (prev == null) {
                try { fileOffsets.set(file, fs.statSync(file).size); }
                catch { fileOffsets.set(file, 0); }
                watchFile(file, mapFn);
              } else {
                fileOffsets.set(file, ingestNewLines(file, mapFn, prev));
              }
            }
            publishNew(loadRangePendingItems(paths.pendingPath), { mirror: false });
          } catch (err) {
            log.warn?.(`taskos-live-feed tick: ${err && err.message ? err.message : err}`);
          }
          const day = hongKongDay();
          if (day !== lastWatchDay) {
            lastWatchDay = day;
            refreshWatches();
          }
        }, 8000);
        if (!disableCollect) {
          pollCollectUi().catch(() => {});
          setInterval(() => { if (!closed) pollCollectUi().catch(() => {}); }, 20000);
          openCollectWs();
        }
        const addr = server.address();
        log.info?.(
          `task-os live feed  http://${host === "0.0.0.0" ? "0.0.0.0" : "127.0.0.1"}:${addr.port}/` +
          `  WS ws://127.0.0.1:${addr.port}/ws/priority` +
          (secret ? " (token required for non-local)" : " (localhost only)"),
        );
        resolve(server);
      });
      server.on("error", reject);
    });
  }

  async function close() {
    closed = true;
    if (timer) clearInterval(timer);
    if (collectRetry) clearTimeout(collectRetry);
    for (const w of watchers) {
      try { w.close(); } catch { /* ignore */ }
    }
    try { collectWs?.close(); } catch { /* ignore */ }
    for (const ws of sockets) {
      try { ws.close(); } catch { /* ignore */ }
    }
    await new Promise((resolve) => wss.close(() => resolve()));
    await new Promise((resolve) => server.close(() => resolve()));
  }

  return { server, start, close, snapshot, publishNew, getItems: () => items };
}

async function main() {
  const svc = createTaskosLiveFeedServer();
  await svc.start();
  for (const sig of ["SIGINT", "SIGTERM"]) {
    process.on(sig, () => {
      svc.close().finally(() => process.exit(0));
    });
  }
}

if (process.argv[1] && path.normalize(fileURLToPath(import.meta.url)) === path.normalize(process.argv[1])) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
