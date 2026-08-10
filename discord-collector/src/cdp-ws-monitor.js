import { Buffer } from "node:buffer";
import zlib from "node:zlib";
import { chromium } from "playwright";

import { isBlockedWsPayload, isDiscordGatewayPayload, isUnforwardableWsRawText } from "./ws-noise-filter.js";
import { formatGatewayRealtimeLog } from "./discord-gateway.js";
import { config } from "./config.js";
import {
  createDiscordGatewayZlibHub,
  isDiscordGatewayZlibStreamUrl,
  isDiscordGatewayUrl,
} from "./discord-gateway-zlib.js";

/**
 * @typedef {ReturnType<import("./logger.js").createLogger>} Logger
 */

/** @param {string} u @param {number} [max] */
function shortenUrl(u, max = 180) {
  const s = String(u ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * 注入 Discord 页：伪造始终前台，避免标签页后台时 Gateway 被节流。
 * 在文档脚本阶段执行（导航后仍生效）。
 */
const DISCORD_VISIBILITY_KEEPALIVE_SOURCE = `(() => {
  if (globalThis.__dcVisibilityKeepalive) return;
  globalThis.__dcVisibilityKeepalive = true;
  const patch = (target) => {
    try {
      Object.defineProperty(target, "hidden", {
        configurable: true,
        get: () => false,
      });
    } catch (_) {}
    try {
      Object.defineProperty(target, "visibilityState", {
        configurable: true,
        get: () => "visible",
      });
    } catch (_) {}
    try {
      Object.defineProperty(target, "webkitHidden", {
        configurable: true,
        get: () => false,
      });
    } catch (_) {}
  };
  try {
    patch(Document.prototype);
  } catch (_) {}
  try {
    if (typeof document !== "undefined") patch(document);
  } catch (_) {}
  try {
    if (typeof document !== "undefined") {
      document.hasFocus = () => true;
    }
  } catch (_) {}
  try {
    window.addEventListener(
      "visibilitychange",
      (e) => {
        try {
          e.stopImmediatePropagation();
        } catch (_) {}
      },
      true
    );
  } catch (_) {}
  try {
    document.dispatchEvent(new Event("visibilitychange"));
  } catch (_) {}
})();`;

/**
 * @param {import('playwright').CDPSession} cdp
 * @param {Logger} log
 * @param {string} [pageUrl]
 */
async function injectDiscordVisibilityKeepalive(cdp, log, pageUrl = "") {
  try {
    await cdp.send("Page.enable");
  } catch {
    /* already enabled */
  }
  try {
    await cdp.send("Page.addScriptToEvaluateOnNewDocument", {
      source: DISCORD_VISIBILITY_KEEPALIVE_SOURCE,
    });
  } catch (e) {
    log.warn(
      `CDP Visibility 保活(注册文档脚本)失败: ${/** @type {Error} */ (e).message}`
    );
  }
  try {
    await cdp.send("Runtime.evaluate", {
      expression: DISCORD_VISIBILITY_KEEPALIVE_SOURCE,
      returnByValue: true,
    });
    log.info(
      `CDP Visibility 保活已注入: ${shortenUrl(pageUrl || "(page)", 120)}`
    );
  } catch (e) {
    log.warn(
      `CDP Visibility 保活(立即执行)失败: ${/** @type {Error} */ (e).message}`
    );
  }
}

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
];

/**
 * Playwright connectOverCDP 会读进程代理环境；对本机 CDP 临时摘掉代理。
 * @template T
 * @param {() => Promise<T>} fn
 * @returns {Promise<T>}
 */
async function withLocalhostNoProxy(fn) {
  /** @type {Record<string, string | undefined>} */
  const saved = {};
  for (const k of PROXY_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  const prevNo = process.env.NO_PROXY;
  const prevNoL = process.env.no_proxy;
  process.env.NO_PROXY = "127.0.0.1,localhost,::1";
  process.env.no_proxy = process.env.NO_PROXY;
  try {
    return await fn();
  } finally {
    for (const k of PROXY_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (prevNo === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = prevNo;
    if (prevNoL === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = prevNoL;
  }
}

/**
 * http(s)://host:9222 → 直连拉取 webSocketDebuggerUrl；已是 ws:// 则原样返回。
 * @param {string} connectUrl
 * @param {Logger} log
 */
async function resolveCdpEndpoint(connectUrl, log) {
  const raw = String(connectUrl || "").trim();
  if (!raw) return raw;
  if (/^wss?:\/\//i.test(raw)) return raw;

  let base = raw.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;

  const versionUrl = `${base}/json/version`;
  try {
    const res = await withLocalhostNoProxy(async () => {
      // 强制不走全局代理（undici/fetch 在 Node 也可能读代理）
      return fetch(versionUrl, {
        signal: AbortSignal.timeout(5_000),
        // @ts-expect-error Node 18+ undici dispatcher 可选；无则忽略
        dispatcher: undefined,
      });
    });
    if (!res.ok) {
      log.warn(`CDP ${versionUrl} → HTTP ${res.status}，回退用 ${base}`);
      return base;
    }
    const j = /** @type {{ webSocketDebuggerUrl?: string }} */ (await res.json());
    const ws = String(j.webSocketDebuggerUrl || "").trim();
    if (ws) {
      log.info(`CDP 已解析浏览器端点 ${shortenUrl(ws, 120)}`);
      return ws;
    }
  } catch (e) {
    log.warn(
      `CDP 解析 ${versionUrl} 失败: ${/** @type {Error} */ (e).message}，回退 ${base}`
    );
  }
  return base;
}

/**
 * Discord 网页版频道直链：`/channels/{guildId}/{channelId}`（DM 时 guild 可为 @me）。
 * @param {string} g
 * @param {string} c
 */
export function discordChannelUrl(g, c) {
  return `https://discord.com/channels/${encodeURIComponent(g)}/${encodeURIComponent(c)}`;
}

/**
 * @param {string} url
 * @returns {{ guildId: string, channelId: string } | null}
 */
export function parseDiscordChannelUrl(url) {
  const m = String(url ?? "").match(
    /discord\.com\/channels\/([^/?#]+)\/([^/?#]+)/i
  );
  if (!m) return null;
  return { guildId: decodeURIComponent(m[1]), channelId: decodeURIComponent(m[2]) };
}

/**
 * @param {string} pageUrl
 * @param {string} targetUrl
 */
function isAlreadyOnDiscordChannel(pageUrl, targetUrl) {
  const a = parseDiscordChannelUrl(pageUrl);
  const b = parseDiscordChannelUrl(targetUrl);
  if (!a || !b) return false;
  return a.guildId === b.guildId && a.channelId === b.channelId;
}

/**
 * connectOverCDP 多标签时：优先选已在 Discord 且 URL 与目标 guild/channel 最相关的页签。
 * @param {string} url
 * @param {string} g guildId（或 @me）
 * @param {string} c channelId
 */
function scoreDiscordPageForChannelNav(url, g, c) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return -1;
  }
  const host = u.hostname.toLowerCase();
  if (!host.includes("discord.com") && !host.includes("discordapp.com")) return -1;
  let score = 0;
  const chMatch = (u.pathname || "").match(/\/channels\/([^/]+)\/([^/]+)/);
  if (chMatch) {
    const [, a, b] = chMatch;
    if (a === g && b === c) score = 5;
    else if (a === g) score = 3;
    else if (b === c) score = 2;
    else score = 1;
  } else if ((u.pathname || "").includes("/channels/")) {
    score = 1;
  }
  return score;
}

/** Document / API / WS 升级请求，便于判断页面是否真的在拉接口 */
const NET_TRACE_RESOURCE_TYPES = new Set([
  "Document",
  "XHR",
  "Fetch",
  "WebSocket",
  "EventSource",
]);

/** @param {Record<string, unknown> | undefined} h @param {number} maxKeys @param {number} maxValLen */
function truncateHeaders(h, maxKeys = 36, maxValLen = 240) {
  if (!h || typeof h !== "object") return h;
  const out = {};
  let n = 0;
  for (const [k, v] of Object.entries(h)) {
    if (n >= maxKeys) {
      out._truncated = `+${Object.keys(h).length - maxKeys} more`;
      break;
    }
    n += 1;
    const s = typeof v === "string" ? v : String(v);
    out[k] = s.length > maxValLen ? `${s.slice(0, maxValLen)}…` : s;
  }
  return out;
}

/** @param {string} post @param {number} max */
function truncateBody(post, max = 4000) {
  if (!post || typeof post !== "string") return post ?? "";
  return post.length > max ? `${post.slice(0, max)}…` : post;
}

/**
 * @typedef {{ logEvents: boolean, sink?: (evt: Record<string, unknown>) => void }} DiagOpts
 */

/** @param {unknown} init */
function summarizeInitiator(init) {
  if (!init || typeof init !== "object") return "";
  const t = /** @type {Record<string, unknown>} */ (init);
  const ty = String(t.type ?? "");
  const url = t.url ? shortenUrl(String(t.url), 72) : "";
  const line = t.lineNumber != null ? `:${String(t.lineNumber)}` : "";
  const bits = [ty, url ? `${url}${line}` : line || ""].filter(Boolean);
  return bits.join(" · ").slice(0, 160);
}

/**
 * 页面生命周期 + Network 关键事件（与 WS 帧监听共用同一条 CDP 会话）。
 * `sink` 用于 UI 等实时消费；`logEvents` 控制是否写 logger。
 *
 * @param {import('playwright').CDPSession} cdp
 * @param {import('playwright').Page} page
 * @param {Logger} log
 * @param {DiagOpts} diag
 * @param {{ urlByRequestId: Map<string, string>, zlibHub: ReturnType<typeof createDiscordGatewayZlibHub> }} [wsMeta]
 */
function wireNetworkAndPageDiagnostics(cdp, page, log, diag, wsMeta) {
  const { logEvents, sink } = diag;

  /** @param {Record<string, unknown>} evt */
  const emit = (evt) => {
    sink?.({ ...evt, pageUrl: page.url() || "" });
  };

  /** @param {'info'|'warn'|'error'} level @param {string} msg */
  const logLine = (level, msg) => {
    if (logEvents) log[level](msg);
  };

  /** @type {Map<string, { url: string, method: string }>} */
  const pendingByRequestId = new Map();

  const trimPending = () => {
    while (pendingByRequestId.size > 4000) {
      const k = pendingByRequestId.keys().next().value;
      if (k === undefined) break;
      pendingByRequestId.delete(k);
    }
  };

  page.on("framenavigated", (frame) => {
    if (frame === page.mainFrame()) {
      const u = shortenUrl(frame.url(), 200);
      logLine("info", `[page] 主导航 → ${u}`);
      emit({ kind: "page", phase: "framenavigated", url: frame.url() });
    }
  });
  page.on("domcontentloaded", () => {
    const u = shortenUrl(page.url(), 200);
    logLine("info", `[page] domcontentloaded | ${u}`);
    emit({ kind: "page", phase: "domcontentloaded", url: page.url() });
  });
  page.on("load", () => {
    const u = shortenUrl(page.url(), 200);
    logLine("info", `[page] load | ${u}`);
    emit({ kind: "page", phase: "load", url: page.url() });
  });
  page.on("close", () => {
    logLine("warn", "[page] 已关闭 (close)");
    emit({ kind: "page", phase: "close" });
  });
  page.on("crash", () => {
    logLine("error", "[page] 渲染进程崩溃 (crash)");
    emit({ kind: "page", phase: "crash" });
  });
  page.on("requestfailed", (req) => {
    const f = req.failure();
    logLine("warn", `[req 失败] ${req.method()} ${shortenUrl(req.url())} | ${f?.errorText ?? "unknown"}`);
    emit({
      kind: "playwright_request_failed",
      method: req.method(),
      url: req.url(),
      errorText: f?.errorText ?? null,
    });
  });

  cdp.on("Network.requestWillBeSent", (evt) => {
    const type = evt.type ?? "";
    if (!NET_TRACE_RESOURCE_TYPES.has(type)) return;
    const req = evt.request ?? {};
    const url = String(req.url ?? "");
    const method = String(req.method ?? "?");
    const id = evt.requestId ?? "";
    if (id) {
      pendingByRequestId.set(id, { url, method });
      trimPending();
    }
    logLine("info", `[net→] ${type} ${method} ${shortenUrl(url)}`);
    emit({
      kind: "net_request",
      requestId: id,
      resourceType: type,
      method,
      url,
      cdpTimestamp: evt.timestamp,
      initiator: summarizeInitiator(evt.initiator),
      headers: truncateHeaders(/** @type {Record<string, unknown>} */ (req.headers)),
      postData: truncateBody(String(req.postData ?? "")),
      hasPostData: Boolean(req.hasPostData),
    });
  });

  cdp.on("Network.responseReceived", (evt) => {
    const type = evt.type ?? "";
    if (!NET_TRACE_RESOURCE_TYPES.has(type)) return;
    const res = evt.response ?? {};
    const status = res.status ?? 0;
    const mime = res.mimeType ?? "";
    const url = String(res.url ?? "");
    logLine("info", `[net←] ${type} HTTP ${status} ${mime ? `(${mime}) ` : ""}${shortenUrl(url)}`);
    emit({
      kind: "net_response",
      requestId: evt.requestId ?? "",
      resourceType: type,
      status,
      statusText: res.statusText ?? "",
      mimeType: mime,
      url,
      cdpTimestamp: evt.timestamp,
      encodedDataLength: res.encodedDataLength != null ? Number(res.encodedDataLength) : null,
      headers: truncateHeaders(/** @type {Record<string, unknown>} */ (res.headers)),
    });
  });

  cdp.on("Network.loadingFailed", (evt) => {
    const id = evt.requestId ?? "";
    const meta = id ? pendingByRequestId.get(id) : undefined;
    if (id) pendingByRequestId.delete(id);
    const err = evt.errorText ?? "";
    const blocked = evt.blockedReason ? ` blocked=${evt.blockedReason}` : "";
    const where = meta ? `${meta.method} ${shortenUrl(meta.url)}` : `requestId=${id}`;
    logLine("warn", `[net✗] ${evt.type ?? "?"} ${where} | ${err}${blocked}`);
    emit({
      kind: "net_failed",
      requestId: id,
      resourceType: evt.type ?? "",
      errorText: err,
      blockedReason: evt.blockedReason ?? null,
      canceled: Boolean(evt.canceled),
      method: meta?.method,
      url: meta?.url,
      cdpTimestamp: evt.timestamp,
    });
  });

  cdp.on("Network.loadingFinished", (evt) => {
    const id = evt.requestId ?? "";
    if (id) pendingByRequestId.delete(id);
    emit({
      kind: "net_finished",
      requestId: id,
      encodedDataLength: evt.encodedDataLength != null ? Number(evt.encodedDataLength) : 0,
      cdpTimestamp: evt.timestamp,
    });

    if (!sink || !id) return;

    void (async () => {
      try {
        /** @type {{ body: string, base64Encoded: boolean }} */
        let result = null;
        let lastErr = null;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            result = /** @type {{ body: string, base64Encoded: boolean }} */ (
              await cdp.send("Network.getResponseBody", { requestId: id })
            );
            break;
          } catch (e) {
            lastErr = /** @type {Error} */ (e);
            if (attempt < 2) await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
          }
        }
        if (!result) throw lastErr ?? new Error("Network.getResponseBody failed");

        let buf;
        if (result.base64Encoded) {
          buf = Buffer.from(result.body, "base64");
        } else {
          buf = Buffer.from(String(result.body ?? ""), "utf8");
        }

        let text = buf.toString("utf8");
        if (text.length < 4 || /[\x00-\x08\x0b\x0e-\x1f]/.test(text.slice(0, Math.min(text.length, 800)))) {
          try {
            text = zlib.gunzipSync(buf).toString("utf8");
          } catch {
            try {
              text = zlib.inflateSync(buf).toString("utf8");
            } catch {
              try {
                text = zlib.inflateRawSync(buf).toString("utf8");
              } catch {
                text = buf.toString("utf8");
              }
            }
          }
        }

        const MAX = 512 * 1024;
        const truncated = text.length > MAX;
        const slice = truncated ? text.slice(0, MAX) : text;

        let bodyJson = null;
        try {
          bodyJson = JSON.parse(slice);
        } catch {
          bodyJson = null;
        }

        emit({
          kind: "net_response_body",
          requestId: id,
          bodyJson,
          bodyRawText: bodyJson == null ? slice : undefined,
          responseBodyTruncated: truncated,
          base64Encoded: Boolean(result.base64Encoded),
        });
      } catch (e) {
        const err = /** @type {Error} */ (e);
        emit({
          kind: "net_response_body",
          requestId: id,
          bodyError: err.message || String(e),
        });
      }
    })();
  });

  cdp.on("Network.webSocketCreated", (evt) => {
    const id = String(evt.requestId ?? "");
    const url = String(evt.url ?? "");
    if (id && url) wsMeta?.urlByRequestId.set(id, url);
    logLine("info", `[ws] 已创建 | ${shortenUrl(url)}`);
    emit({
      kind: "ws_created",
      requestId: id,
      url,
      cdpTimestamp: evt.timestamp,
      isGatewayZlib: isDiscordGatewayZlibStreamUrl(url),
    });
  });
  cdp.on("Network.webSocketWillSendHandshakeRequest", (evt) => {
    const req = evt.request ?? {};
    const url = String(req.url ?? "");
    const id = String(evt.requestId ?? "");
    if (id && url) wsMeta?.urlByRequestId.set(id, url);
    logLine("info", `[ws] 握手请求 → ${shortenUrl(url)}`);
    emit({
      kind: "ws_handshake_request",
      requestId: evt.requestId ?? "",
      url: String(req.url ?? ""),
      cdpTimestamp: evt.timestamp,
      headers: truncateHeaders(/** @type {Record<string, unknown>} */ (req.headers)),
    });
  });
  cdp.on("Network.webSocketHandshakeResponseReceived", (evt) => {
    const res = evt.response ?? {};
    const st = res.status ?? 0;
    const stt = res.statusText ?? "";
    logLine("info", `[ws] 握手响应 ← HTTP ${st} ${stt}`.trim());
    emit({
      kind: "ws_handshake_response",
      requestId: evt.requestId ?? "",
      status: st,
      statusText: stt,
      cdpTimestamp: evt.timestamp,
      headers: truncateHeaders(/** @type {Record<string, unknown>} */ (res.headers)),
    });
  });

  cdp.on("Network.webSocketClosed", (evt) => {
    const id = String(evt.requestId ?? "");
    if (id) {
      wsMeta?.urlByRequestId.delete(id);
      wsMeta?.gatewayRequestIds?.delete(id);
      wsMeta?.zlibProbeFrames?.delete(id);
      wsMeta?.zlibHub.remove(id);
    }
    emit({ kind: "ws_closed", requestId: id, cdpTimestamp: evt.timestamp });
  });
}

/**
 * 判断 CDP 文本 payload 是否像 Base64（opcode 非 2 时仍可能是二进制帧的 Base64 串）。
 * @param {string} s
 */
function looksLikeBase64Payload(s) {
  const t = String(s).replace(/\s/g, "");
  if (t.length < 16 || t.length % 4 !== 0) return false;
  const head = t.slice(0, Math.min(400, t.length));
  if (!/^[A-Za-z0-9+/]+=*$/.test(head)) return false;
  try {
    Buffer.from(t.slice(0, 32), "base64");
    return true;
  } catch {
    return false;
  }
}

/**
 * WebSocket 帧：UTF-8 JSON → 否则 zlib.inflateSync / inflateRawSync → UTF-8 → JSON.parse。
 * @param {Buffer} buf
 * @param {number} opcode
 */
function decodeWebSocketFramePayload(buf, opcode) {
  /** @type {{ decodePath: string, parsedJson?: unknown, parseError?: string, rawPreview?: string, hexPreview?: string }} */
  const utf8TryJson = () => {
    const t = buf.toString("utf8");
    const j = JSON.parse(t);
    return { decodePath: "json_utf8", parsedJson: j };
  };

  if (opcode === 1 || opcode === 0) {
    try {
      return utf8TryJson();
    } catch {
      /* zlib path below */
    }
  }

  if (opcode === 2 || opcode === 1 || opcode === 0) {
    for (const def of [
      { path: "zlib_inflate", fn: () => zlib.inflateSync(buf) },
      { path: "zlib_inflateRaw", fn: () => zlib.inflateRawSync(buf) },
    ]) {
      try {
        const inflated = def.fn();
        const t = inflated.toString("utf8");
        const j = JSON.parse(t);
        return { decodePath: def.path, parsedJson: j };
      } catch {
        /* next */
      }
    }
  }

  try {
    return utf8TryJson();
  } catch (e) {
    try {
      const t = buf.toString("utf8");
      return {
        decodePath: "utf8_nonjson",
        parseError: `json_parse: ${/** @type {Error} */ (e).message}`,
        rawPreview: t.slice(0, 8000),
      };
    } catch {
      return {
        decodePath: "opaque",
        parseError: "opaque_binary",
        hexPreview: buf.subarray(0, 64).toString("hex"),
      };
    }
  }
}

/** Discord Gateway 高频噪音事件（仍入库/推 UI，仅跳过终端逐帧打印）。 */
const DISCORD_GATEWAY_SKIP_CONSOLE = new Set([
  "PRESENCE_UPDATE",
  "TYPING_START",
  "MESSAGE_ACK",
  "CHANNEL_UNREAD_UPDATE",
  "GUILD_MEMBER_LIST_UPDATE",
  "THREAD_LIST_SYNC",
  "VOICE_STATE_UPDATE",
  "SESSIONS_REPLACE",
  "PASSIVE_UPDATE_V1",
]);

/**
 * 终端是否跳过打印该 WS 帧（Discord Gateway 心跳、Presence 等噪音）。
 * @param {unknown} parsedJson
 */
function shouldSkipWsFrameConsoleLog(parsedJson) {
  if (parsedJson == null || typeof parsedJson !== "object" || Array.isArray(parsedJson)) {
    return false;
  }
  const o = /** @type {Record<string, unknown>} */ (parsedJson);
  const op = o.op;
  if (op === 1 || op === 10 || op === 11) return true;
  const t = o.t;
  if (typeof t === "string" && DISCORD_GATEWAY_SKIP_CONSOLE.has(t)) return true;
  return false;
}

/**
 * @param {import('playwright').CDPSession} cdp
 * @param {Logger} log
 * @param {{
 *   onData: (buf: Buffer, meta: { requestId: string, opcode: number, isBinaryHint: boolean, pageUrl: string }) => void,
 *   diagnosticSink?: (evt: Record<string, unknown>) => void,
 *   wsFrameTrace?: boolean,
 * }} opts
 * @param {() => string} getPageUrl
 * @param {{ urlByRequestId: Map<string, string>, zlibHub: ReturnType<typeof createDiscordGatewayZlibHub> }} wsMeta
 */
function wireWebSocketFrames(cdp, log, opts, getPageUrl, wsMeta) {
  const wsFrameTrace = Boolean(opts.wsFrameTrace);
  let localSeq = 0;

  /**
   * @param {unknown} parsedJson
   * @param {{ requestId: string, opcode: number, decodePath: string, buf: Buffer, frameSeq: number }} ctx
   */
  function deliverParsedFrame(parsedJson, ctx) {
    const rawUtf8 = typeof parsedJson === "object" && parsedJson != null ? "" : String(parsedJson ?? "");
    if (isBlockedWsPayload(parsedJson, rawUtf8)) return;

    const gatewayLine = formatGatewayRealtimeLog(parsedJson);
    if (gatewayLine && config.gatewayMessageLog) {
      log.info(gatewayLine);
    }

    const skipConsole =
      !gatewayLine && (!wsFrameTrace || shouldSkipWsFrameConsoleLog(parsedJson));
    if (!skipConsole && !gatewayLine) {
      try {
        const line = JSON.stringify(parsedJson);
        log.info(
          `[WS 帧 #${ctx.frameSeq} op=${ctx.opcode} ${ctx.decodePath}] ${line.length > 2800 ? `${line.slice(0, 2800)}…` : line}`
        );
      } catch {
        log.info(`[WS 帧 #${ctx.frameSeq} op=${ctx.opcode} ${ctx.decodePath}] [object]`);
      }
    }

    opts.diagnosticSink?.({
      kind: "ws_frame_parsed",
      pageUrl: getPageUrl() || "",
      requestId: ctx.requestId,
      frameSeq: ctx.frameSeq,
      opcode: ctx.opcode,
      decodePath: ctx.decodePath,
      parsedJson,
      bodyLen: ctx.buf.length,
    });

    const outBuf = Buffer.from(JSON.stringify(parsedJson), "utf8");
    opts.onData(outBuf, {
      requestId: ctx.requestId,
      opcode: ctx.opcode,
      isBinaryHint: ctx.opcode === 2,
      pageUrl: getPageUrl(),
    });
  }

  cdp.on("Network.webSocketFrameReceived", (evt) => {
    void (async () => {
      const requestId = String(evt.requestId ?? "");
      const response = evt.response ?? {};
      const opcode = response.opcode ?? -1;
      const payloadData = response.payloadData;
      if (payloadData === undefined || payloadData === null) return;

      const rawStr = String(payloadData);
      let buf;
      try {
        if (opcode === 2) {
          buf = Buffer.from(rawStr, "base64");
        } else if (looksLikeBase64Payload(rawStr)) {
          buf = Buffer.from(rawStr.replace(/\s/g, ""), "base64");
        } else {
          buf = Buffer.from(rawStr, "utf8");
        }
      } catch (e) {
        log.warn(`帧 payload 解码失败 requestId=${requestId} opcode=${opcode}: ${e}`);
        return;
      }

      localSeq += 1;
      const wsUrl = wsMeta.urlByRequestId.get(requestId) ?? "";
      const isKnownGateway = wsMeta.gatewayRequestIds.has(requestId);
      const useGatewayZlib =
        isKnownGateway ||
        isDiscordGatewayZlibStreamUrl(wsUrl) ||
        (isDiscordGatewayUrl(wsUrl) && opcode === 2);

      /**
       * @param {unknown[]} jsons
       * @param {string} decodePath
       */
      function deliverGatewayJsons(jsons, decodePath) {
        let sawGateway = false;
        for (const parsedJson of jsons) {
          if (isDiscordGatewayPayload(parsedJson)) sawGateway = true;
          deliverParsedFrame(parsedJson, {
            requestId,
            opcode,
            decodePath,
            buf,
            frameSeq: localSeq,
          });
        }
        if (sawGateway && !isKnownGateway) {
          wsMeta.gatewayRequestIds.add(requestId);
          if (!wsUrl) {
            wsMeta.urlByRequestId.set(
              requestId,
              "wss://gateway.discord.gg/?encoding=json&compress=zlib-stream&detected=1"
            );
            log.info(
              `[ws] 自动识别 Discord Gateway zlib 流 requestId=${requestId.slice(0, 16)} page=${getPageUrl().slice(0, 96)}`
            );
          }
        }
      }

      if (useGatewayZlib) {
        try {
          const jsons = await wsMeta.zlibHub.feed(requestId, buf);
          deliverGatewayJsons(jsons, "gateway_zlib_stream");
        } catch (e) {
          log.warn(
            `[gateway zlib-stream] 解压失败 requestId=${requestId}: ${/** @type {Error} */ (e).message}`
          );
        }
        return;
      }

      const decoded = decodeWebSocketFramePayload(buf, opcode);
      const rawUtf8 =
        decoded.parsedJson === undefined ? (decoded.rawPreview ?? buf.toString("utf8")) : "";
      if (isBlockedWsPayload(decoded.parsedJson, rawUtf8)) {
        return;
      }

      if (decoded.parsedJson !== undefined) {
        if (isDiscordGatewayPayload(decoded.parsedJson)) {
          wsMeta.gatewayRequestIds.add(requestId);
        }
        deliverParsedFrame(decoded.parsedJson, {
          requestId,
          opcode,
          decodePath: decoded.decodePath,
          buf,
          frameSeq: localSeq,
        });
        return;
      }

      // 二进制帧：可能是 Gateway zlib-stream（CDP 挂载前已连接时无 ws_created URL）
      if (opcode === 2) {
        const probing =
          isKnownGateway ||
          wsMeta.zlibHub.hasSession(requestId) ||
          (wsMeta.zlibProbeFrames.get(requestId) ?? 0) < 120;

        if (probing) {
          wsMeta.zlibProbeFrames.set(requestId, (wsMeta.zlibProbeFrames.get(requestId) ?? 0) + 1);
          try {
            const jsons = await wsMeta.zlibHub.feed(requestId, buf);
            if (jsons.some((j) => isDiscordGatewayPayload(j))) {
              deliverGatewayJsons(
                jsons,
                isKnownGateway || wsUrl ? "gateway_zlib_stream" : "gateway_zlib_autodetect"
              );
              wsMeta.zlibProbeFrames.delete(requestId);
              return;
            }
            // 部分 zlib 块，保持 inflater 等待后续帧
            if (wsMeta.zlibHub.hasSession(requestId)) {
              return;
            }
          } catch {
            wsMeta.zlibHub.remove(requestId);
          }

          const probeN = wsMeta.zlibProbeFrames.get(requestId) ?? 0;
          if (probeN >= 120) {
            wsMeta.zlibProbeFrames.delete(requestId);
            wsMeta.zlibHub.remove(requestId);
          } else {
            return;
          }
        }
      }

      const rawUtf8ForDrop = decoded.rawPreview ?? buf.toString("utf8");
      if (isUnforwardableWsRawText(rawUtf8ForDrop)) {
        return;
      }

      const skipConsole = !wsFrameTrace;
      if (!skipConsole) {
        log.info(
          `[WS 帧 #${localSeq} op=${opcode} ${decoded.decodePath}] ${decoded.parseError ?? ""} ${decoded.rawPreview ? decoded.rawPreview.slice(0, 400) : decoded.hexPreview ?? ""}`
        );
      }

      opts.diagnosticSink?.({
        kind: "ws_frame_parsed",
        pageUrl: getPageUrl() || "",
        requestId,
        frameSeq: localSeq,
        opcode,
        decodePath: decoded.decodePath,
        parseError: decoded.parseError,
        rawPreview: decoded.rawPreview,
        hexPreview: decoded.hexPreview,
        bodyLen: buf.length,
      });

      if (localSeq <= 3 || localSeq % 200 === 0) {
        log.debug(
          `WS 帧 #${localSeq} opcode=${opcode} len=${buf.length} url=${getPageUrl().slice(0, 64)}…`
        );
      }

      opts.onData(buf, {
        requestId,
        opcode,
        isBinaryHint: opcode === 2,
        pageUrl: getPageUrl(),
      });
    })();
  });
}

/**
 * 使用 CDP 监听 Network.webSocketFrameReceived，将帧 payload 交给 onData(Buffer)。
 *
 * - **无头模式**（未设置 `cdpConnectUrl`）：Playwright 自启 Chromium，`goto(startUrl)`，可选定时 reload。
 * - **附加模式**（设置 `CDP_CONNECT_URL`）：`connectOverCDP` 连接你已打开的 Chrome（需带 `--remote-debugging-port`），
 *   对所有已有标签页 + 之后新开的标签页挂载 Network 监听；你在该浏览器里**刷新页面**产生的 WS 帧会被收到。
 *
 * @param {{
 *   startUrl: string,
 *   cdpConnectUrl?: string,
 *   pageReloadIntervalMs?: number,
 *   cdpAutoGoto?: boolean,
 *   cdpVisibilityKeepalive?: boolean,
 *   networkTrace?: boolean,
 *   wsFrameTrace?: boolean,
 *   diagnosticSink?: (evt: Record<string, unknown>) => void,
 *   onConnectionLost?: (info: { reason: string, connectUrl: string, message: string }) => void | Promise<void>,
 *   onReconnected?: (info: { connectUrl: string, attempt: number }) => void | Promise<void>,
 *   onData: (buf: Buffer, meta: { requestId: string, opcode: number, isBinaryHint: boolean, pageUrl?: string }) => void
 * }} opts — diagnosticSink：实时诊断（collect UI），与 networkTrace 独立；仅 sink 时也会挂 CDP 监听
 * @param {Logger} log
 */
export async function startCdpWebSocketMonitor(opts, log) {
  const networkTrace = Boolean(opts.networkTrace);
  const wantDiag = networkTrace || typeof opts.diagnosticSink === "function";
  const connectUrl = (opts.cdpConnectUrl ?? "").trim();
  /** @type {{ cdp: import('playwright').CDPSession, page: import('playwright').Page }[]} */
  const mounted = [];
  /** @type {WeakSet<import('playwright').Page>} */
  const attached = new WeakSet();
  /** 会话是否已主动 close（阻止自动重连） */
  let sessionClosed = false;

  /**
   * @param {import('playwright').Page} page
   */
  async function attachToPage(page) {
    if (attached.has(page)) return;
    attached.add(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    if (opts.cdpVisibilityKeepalive !== false) {
      let pageUrl = "";
      try {
        pageUrl = page.url();
      } catch {
        pageUrl = "";
      }
      await injectDiscordVisibilityKeepalive(cdp, log, pageUrl);
    }
    const wsMeta = {
      urlByRequestId: new Map(),
      zlibHub: createDiscordGatewayZlibHub(),
      /** @type {Set<string>} CDP 挂载前已建立的 Gateway WS（无 ws_created 时自动识别） */
      gatewayRequestIds: new Set(),
      /** @type {Map<string, number>} 候选 zlib 流：累计帧数，超阈值则放弃 */
      zlibProbeFrames: new Map(),
    };
    wireWebSocketFrames(cdp, log, opts, () => page.url() || "", wsMeta);
    if (wantDiag) {
      wireNetworkAndPageDiagnostics(cdp, page, log, {
        logEvents: networkTrace,
        sink: opts.diagnosticSink,
      }, wsMeta);
      log.info(
        `已挂载页面/网络诊断${networkTrace ? "（控制台日志）" : ""}${opts.diagnosticSink ? "（实时 sink）" : ""}: ${page.url() || "(about:blank)"}`
      );
    }
    mounted.push({ cdp, page });
    log.info(`已挂载 Network.webSocketFrameReceived: ${page.url() || "(about:blank)"}`);
  }

  /**
   * 附加模式下打开/刷新保活频道。
   * @param {import('playwright').Browser} br
   * @param {string} targetUrl
   * @param {{ forceReload?: boolean }} [navOpts]
   */
  async function openOrRefreshDiscordUrl(br, targetUrl, navOpts = {}) {
    if (!br?.isConnected?.()) throw new Error("browser disconnected");
    const url = String(targetUrl || "").trim();
    if (!url) throw new Error("empty target url");

    /** @type {import('playwright').BrowserContext} */
    let ctx = br.contexts()[0];
    if (!ctx) ctx = await br.newContext();

    /** @type {import('playwright').Page | null} */
    let page = null;
    let bestScore = -1;
    for (const c of br.contexts()) {
      for (const p of c.pages()) {
        let u = "";
        try {
          u = p.url();
        } catch {
          continue;
        }
        if (isAlreadyOnDiscordChannel(u, url)) {
          page = p;
          ctx = c;
          bestScore = 1000;
          break;
        }
        const parsed = parseDiscordChannelUrl(url);
        const sc = parsed
          ? scoreDiscordPageForChannelNav(u, parsed.guildId, parsed.channelId)
          : /discord\.com/i.test(u)
            ? 10
            : 0;
        if (sc > bestScore) {
          bestScore = sc;
          page = p;
          ctx = c;
        }
      }
      if (bestScore >= 1000) break;
    }

    if (!page) {
      page = await ctx.newPage();
      log.info(`CDP 新建标签 → ${shortenUrl(url, 160)}`);
    }

    await attachToPage(page);

    const cur = (() => {
      try {
        return page.url();
      } catch {
        return "";
      }
    })();
    const already = isAlreadyOnDiscordChannel(cur, url);
    opts.diagnosticSink?.({
      kind: "cdp_keepalive",
      phase: navOpts.forceReload ? "reload" : already ? "already_on_channel" : "goto",
      targetUrl: url,
      currentUrl: cur,
    });

    if (navOpts.forceReload && already) {
      log.info(`CDP 保活刷新 ${shortenUrl(url, 160)}`);
      await page.reload({ waitUntil: "domcontentloaded", timeout: 90_000 });
    } else if (!already || navOpts.forceReload) {
      log.info(`CDP 打开频道 ${shortenUrl(url, 160)}`);
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: 90_000 });
    } else {
      log.info(`CDP 已在目标频道 ${shortenUrl(cur, 160)}`);
    }
    return page;
  }

  /** @type {import('playwright').Browser | undefined} */
  let browser;
  /** @type {boolean} */
  let ownedBrowser;
  /** @type {import('playwright').BrowserContext | null} */
  let headlessContext = null;
  /** @type {import('playwright').Page | null} */
  let headlessPage = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let reloadTimer = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let attachRescanTimer = null;
  /** @type {ReturnType<typeof setTimeout> | null} */
  let reconnectTimer = null;
  let reconnectAttempt = 0;
  let reconnectInFlight = false;

  function clearAttachTimers() {
    if (reloadTimer) {
      clearInterval(reloadTimer);
      reloadTimer = null;
    }
    if (attachRescanTimer) {
      clearInterval(attachRescanTimer);
      attachRescanTimer = null;
    }
  }

  async function detachMountedSessions() {
    for (const { cdp } of mounted) {
      await cdp.detach().catch(() => {});
    }
    mounted.length = 0;
  }

  /**
   * 附加模式：挂载上下文 / 保活刷新 / 断线自动重连。
   * @param {import('playwright').Browser} br
   * @param {{ isReconnect?: boolean, attempt?: number }} [bindOpts]
   */
  async function bindAttachBrowser(br, bindOpts = {}) {
    const isReconnect = Boolean(bindOpts.isReconnect);
    const attempt = Number(bindOpts.attempt) || 0;
    browser = br;

    /** 挂载已有/新建页签；Discord 刷新会换 page 对象时靠 page 事件 + 定时补挂 */
    const wireContext = (/** @type {import('playwright').BrowserContext} */ ctx) => {
      ctx.on("page", (page) => {
        void attachToPage(page).catch((e) => log.warn(`新标签页挂载 CDP 失败: ${e.message}`));
      });
      for (const page of ctx.pages()) {
        void attachToPage(page).catch((e) => log.warn(`标签页挂载 CDP 失败: ${e.message}`));
      }
    };
    for (const ctx of br.contexts()) {
      wireContext(ctx);
    }
    br.on("context", (ctx) => {
      wireContext(ctx);
    });

    attachRescanTimer = setInterval(() => {
      try {
        if (!browser?.isConnected?.()) return;
        for (const ctx of browser.contexts()) {
          for (const page of ctx.pages()) {
            if (attached.has(page)) continue;
            void attachToPage(page).catch((e) =>
              log.warn(`补挂 CDP 失败: ${/** @type {Error} */ (e).message}`)
            );
          }
        }
      } catch {
        /* ignore */
      }
    }, 15_000);

    log.info(
      `已在 ${mounted.length} 个标签页上启用监听${isReconnect ? "（重连）" : ""}。保活频道: ${opts.startUrl || "（未配置）"}`
    );
    opts.diagnosticSink?.({
      kind: isReconnect ? "cdp_reconnected" : "cdp_attached",
      mode: "connectOverCDP",
      connectUrl,
      tabCount: mounted.length,
      hintStartUrl: opts.startUrl,
      attempt: isReconnect ? attempt : 0,
    });

    const autoGoto = opts.cdpAutoGoto !== false;
    const keepUrl = String(opts.startUrl || "").trim();
    if (autoGoto && keepUrl && /discord\.com\//i.test(keepUrl)) {
      try {
        // 重连时强制刷新，重建 Discord Gateway；首次仅确保在目标频道
        await openOrRefreshDiscordUrl(br, keepUrl, { forceReload: isReconnect });
      } catch (e) {
        log.warn(
          `CDP ${isReconnect ? "重连后刷新" : "自动打开"}频道失败: ${/** @type {Error} */ (e).message} — 请确认 Chrome 已登录 Discord`
        );
      }
      const reloadMs = Number(opts.pageReloadIntervalMs ?? 0);
      if (reloadMs > 0) {
        if (!isReconnect) {
          log.info(
            `CDP 保活刷新已启用：每 ${Math.round(reloadMs / 1000)}s 打开/刷新 ${shortenUrl(keepUrl, 120)}`
          );
        }
        reloadTimer = setInterval(() => {
          void openOrRefreshDiscordUrl(browser, keepUrl, { forceReload: true }).catch((e) =>
            log.warn(`CDP 保活刷新失败: ${/** @type {Error} */ (e).message}`)
          );
        }, reloadMs);
      }
    }

    br.on("disconnected", () => {
      if (sessionClosed) return;
      const message = `CDP 与 Chrome 调试连接已断开: ${connectUrl}`;
      log.error(`[CDP] ${message} — 将自动重连并刷新 Discord`);
      clearAttachTimers();
      void detachMountedSessions();
      opts.diagnosticSink?.({
        kind: "cdp_disconnected",
        connectUrl: connectUrl || null,
        reason: "browser_disconnected",
        message,
        willReconnect: true,
      });
      void opts.onConnectionLost?.({
        reason: "browser_disconnected",
        connectUrl,
        message,
      });
      scheduleAttachReconnect();
    });

    if (isReconnect) {
      reconnectAttempt = 0;
      void opts.onReconnected?.({ connectUrl, attempt });
    }
  }

  async function connectAttachOnce() {
    const endpoint = await resolveCdpEndpoint(connectUrl, log);
    return withLocalhostNoProxy(() => chromium.connectOverCDP(endpoint));
  }

  function scheduleAttachReconnect() {
    if (sessionClosed || !connectUrl || reconnectInFlight) return;
    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    reconnectAttempt += 1;
    const attempt = reconnectAttempt;
    const delay = Math.min(30_000, 1500 * 2 ** Math.min(attempt - 1, 4));
    log.warn(
      `[CDP] ${delay}ms 后尝试重连 #${attempt} → ${connectUrl}（Chrome 调试口通常仍在，将刷新 Discord）`
    );
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void (async () => {
        if (sessionClosed || reconnectInFlight) return;
        reconnectInFlight = true;
        try {
          const br = await connectAttachOnce();
          if (sessionClosed) {
            await br.close().catch(() => {});
            return;
          }
          await bindAttachBrowser(br, { isReconnect: true, attempt });
          log.info(`[CDP] 重连成功 #${attempt}，已刷新 Discord 保活页`);
        } catch (e) {
          log.warn(`[CDP] 重连失败 #${attempt}: ${/** @type {Error} */ (e).message}`);
          reconnectInFlight = false;
          scheduleAttachReconnect();
          return;
        }
        reconnectInFlight = false;
      })();
    }, delay);
  }

  /** @param {import('playwright').Browser} b */
  function wireBrowserDisconnect(b) {
    b.on("disconnected", () => {
      if (sessionClosed) return;
      const message = "CDP 浏览器连接已断开";
      log.error(`[CDP] ${message}`);
      opts.diagnosticSink?.({
        kind: "cdp_disconnected",
        connectUrl: null,
        reason: "browser_disconnected",
        message,
      });
      void opts.onConnectionLost?.({
        reason: "browser_disconnected",
        connectUrl: "",
        message,
      });
    });
  }

  if (connectUrl) {
    ownedBrowser = false;
    log.info(`connectOverCDP: ${connectUrl}（监听你在该 Chrome 里打开/刷新的页面上的 WS；断线自动重连）`);
    browser = await connectAttachOnce();
    await bindAttachBrowser(browser, { isReconnect: false });
  } else {
    ownedBrowser = true;
    log.info("启动 Chromium (headless) …");
    opts.diagnosticSink?.({ kind: "cdp_boot", mode: "headless", startUrl: opts.startUrl });
    browser = await chromium.launch({ headless: false });
    wireBrowserDisconnect(browser);
    headlessContext = await browser.newContext();
    headlessPage = await headlessContext.newPage();
    await attachToPage(headlessPage);

    opts.diagnosticSink?.({ kind: "goto_begin", targetUrl: opts.startUrl });
    log.info(`导航开始 (goto) → ${opts.startUrl}`);
    let gotoResp;
    try {
      gotoResp = await headlessPage.goto(opts.startUrl, {
        waitUntil: "domcontentloaded",
        timeout: 120_000,
      });
    } catch (e) {
      const err = /** @type {Error} */ (e);
      log.error(`goto 失败: ${err.message}`);
      opts.diagnosticSink?.({
        kind: "goto_error",
        targetUrl: opts.startUrl,
        message: err.message,
      });
      throw e;
    }
    const finalUrl = headlessPage.url();
    const httpStatus = gotoResp?.status();
    opts.diagnosticSink?.({
      kind: "goto_domcontentloaded",
      targetUrl: opts.startUrl,
      finalUrl,
      httpStatus: httpStatus ?? null,
    });
    log.info(
      `goto 已返回 domcontentloaded | 最终 URL: ${shortenUrl(finalUrl, 220)} | 导航 HTTP: ${httpStatus ?? "n/a"}`
    );
    try {
      await headlessPage.waitForLoadState("load", { timeout: 45_000 });
      log.info(`load 事件已触发（45s 内）| ${shortenUrl(headlessPage.url(), 220)}`);
      opts.diagnosticSink?.({
        kind: "goto_load",
        finalUrl: headlessPage.url(),
        ok: true,
      });
    } catch {
      log.warn(
        "45s 内未触发 load（单页应用、长轮询或无限资源常见）；若 [net→]/[ws] 仍有输出说明页面仍在跑。"
      );
      opts.diagnosticSink?.({
        kind: "goto_load",
        finalUrl: headlessPage.url(),
        ok: false,
        note: "timeout_45s",
      });
    }
    log.info("开始接收 WS 帧（Network.webSocketFrameReceived）");

    const reloadMs = Number(opts.pageReloadIntervalMs ?? 0);
    if (reloadMs > 0 && headlessPage) {
      reloadTimer = setInterval(() => {
        void (async () => {
          try {
            log.info(`定时重载无头页 (${reloadMs}ms) …`);
            const r = await headlessPage.reload({
              waitUntil: "domcontentloaded",
              timeout: 120_000,
            });
            log.info(`无头页已重载 | HTTP ${r?.status() ?? "n/a"} | ${shortenUrl(headlessPage.url(), 200)}`);
          } catch (e) {
            log.warn(`重载失败: ${/** @type {Error} */ (e).message}`);
          }
        })();
      }, reloadMs);
    }
  }

  return {
    get browser() {
      return browser;
    },
    get mounted() {
      return mounted;
    },
    /**
     * 在已挂载 CDP 的 Discord 页签里执行 `goto` 打开目标频道。
     * 使用 `https://discord.com/channels/{guildId}/{channelId}`。
     * @param {string} guildId
     * @param {string} channelId
     * @param {{ clientTraceId?: string }} [traceCtx]
     */
    async navigateDiscordChannel(guildId, channelId, traceCtx) {
      const tc = traceCtx && typeof traceCtx === "object" ? traceCtx : {};
      const clientTraceId =
        typeof tc.clientTraceId === "string" && tc.clientTraceId.trim() ? tc.clientTraceId.trim() : undefined;
      /** @type {Record<string, string>} */
      const trace = clientTraceId ? { clientTraceId } : {};

      const g = String(guildId ?? "").trim();
      const c = String(channelId ?? "").trim();
      if (!g || !c) {
        return { ok: false, error: "guildId 与 channelId 不能为空" };
      }
      if (!g || !c) {
        return { ok: false, error: "guildId 与 channelId 不能为空" };
      }
      const targetUrl = discordChannelUrl(g, c);
      if (mounted.length === 0) {
        return { ok: false, error: "尚无已挂载 CDP 的页面" };
      }
      /** @type {{ page: import("playwright").Page; score: number }[]} */
      const ranked = [];
      for (const { page } of mounted) {
        let url = "";
        try {
          url = page.url();
        } catch {
          ranked.push({ page, score: -1 });
          continue;
        }
        const sc = scoreDiscordPageForChannelNav(url, g, c);
        ranked.push({ page, score: sc >= 0 ? sc : 0 });
      }
      ranked.sort((a, b) => b.score - a.score);
      const top = ranked[0];
      const page = top?.page;
      if (!page) {
        return { ok: false, error: "无法选择浏览器标签页" };
      }
      let pickedPageUrl = "";
      try {
        pickedPageUrl = page.url();
      } catch {
        pickedPageUrl = "";
      }
      log.info(
        `[discord-channel] CDP 已选标签 score=${top?.score ?? "?"} mounted=${mounted.length} page=${shortenUrl(pickedPageUrl, 200)} → goto ${shortenUrl(targetUrl, 200)}${clientTraceId ? ` trace=${clientTraceId}` : ""}`
      );
      opts.diagnosticSink?.({
        kind: "discord_channel_pick_page",
        guildId: g,
        channelId: c,
        targetUrl,
        pickedPageUrl,
        pickScore: top?.score ?? null,
        mountedCount: mounted.length,
        ...trace,
      });
      if (isAlreadyOnDiscordChannel(pickedPageUrl, targetUrl)) {
        log.info(
          `[discord-channel] 已在目标频道，跳过 goto${clientTraceId ? ` trace=${clientTraceId}` : ""}`
        );
        return { ok: true, skipped: true, reason: "already_on_channel", finalUrl: pickedPageUrl };
      }
      try {
        log.info(`[discord-channel] page.goto 开始 …${clientTraceId ? ` trace=${clientTraceId}` : ""}`);
        opts.diagnosticSink?.({
          kind: "discord_channel_nav_begin",
          guildId: g,
          channelId: c,
          targetUrl,
          pickedPageUrl,
          ...trace,
        });
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
        const finalUrl = page.url();
        log.info(`[discord-channel] page.goto 完成 final=${shortenUrl(finalUrl, 200)}${clientTraceId ? ` trace=${clientTraceId}` : ""}`);
        opts.diagnosticSink?.({
          kind: "discord_channel_nav_done",
          guildId: g,
          channelId: c,
          targetUrl,
          finalUrl,
          ok: true,
          ...trace,
        });
        return { ok: true, finalUrl };
      } catch (e) {
        const err = /** @type {Error} */ (e);
        log.warn(`[discord-channel] page.goto 失败: ${err.message}${clientTraceId ? ` trace=${clientTraceId}` : ""}`);
        opts.diagnosticSink?.({
          kind: "discord_channel_nav_done",
          guildId: g,
          channelId: c,
          targetUrl,
          ok: false,
          error: err.message,
          ...trace,
        });
        return { ok: false, error: err.message };
      }
    },
    /**
     * 经 Playwright APIRequest 发 Webhook（非页面 fetch，避免 Discord 50067 Invalid request origin）。
     * @param {string} webhookUrl
     * @param {Record<string, unknown>} payload
     */
    async postWebhookViaBrowser(webhookUrl, payload) {
      /** @type {import("playwright").Page | null} */
      let page = null;
      for (const { page: p } of mounted) {
        try {
          if (/discord\.com/i.test(p.url())) {
            page = p;
            break;
          }
        } catch {
          /* 页面已关闭 */
        }
      }
      if (!page && mounted.length) page = mounted[0].page;
      if (!page) throw new Error("尚无已挂载 CDP 的 Discord 页面");

      const r = await page.context().request.post(webhookUrl, {
        headers: { "Content-Type": "application/json" },
        data: payload,
        timeout: config.webhookForwardTimeoutMs,
      });
      if (!r.ok()) {
        const text = await r.text().catch(() => "");
        throw new Error(`HTTP ${r.status()}${text ? `: ${text.slice(0, 300)}` : ""}`);
      }
    },
    async close() {
      log.info("正在卸载 CDP 监听 …");
      sessionClosed = true;
      if (reconnectTimer) {
        clearTimeout(reconnectTimer);
        reconnectTimer = null;
      }
      clearAttachTimers();
      await detachMountedSessions();

      if (ownedBrowser && headlessContext) {
        await headlessContext.close().catch(() => {});
        await browser?.close().catch(() => {});
        log.info("无头浏览器已关闭");
      } else if (!ownedBrowser) {
        log.info("connectOverCDP 模式：未关闭你的 Chrome，仅已 detach CDP 会话");
      }
    },
  };
}
