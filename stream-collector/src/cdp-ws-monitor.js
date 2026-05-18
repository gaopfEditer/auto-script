import { Buffer } from "node:buffer";
import zlib from "node:zlib";
import { chromium } from "playwright";

/**
 * @typedef {ReturnType<import("./logger.js").createLogger>} Logger
 */

/** @param {string} u @param {number} [max] */
function shortenUrl(u, max = 180) {
  const s = String(u ?? "");
  return s.length <= max ? s : `${s.slice(0, max)}…`;
}

/**
 * 官方「打开某服务器某频道」直链（与 Kook.Net `DirectLinks.Channel` 一致），
 * 不依赖 SPA 路径是 `/app/channels/{guild}/{channel}` 还是反序。
 * @param {string} g
 * @param {string} c
 */
function kookChannelDirectUrl(g, c) {
  return `https://www.kookapp.cn/direct/channel?g=${encodeURIComponent(g)}&c=${encodeURIComponent(c)}`;
}

/**
 * connectOverCDP 多标签时：优先选已在 Kook 且 URL 与目标 guild/channel 最相关的页签。
 * 不会解析 DOM 里的 `<a href>`，只看当前 `page.url()`。
 * @param {string} url
 * @param {string} g guildId
 * @param {string} c channelId
 */
function scoreKookPageForChannelNav(url, g, c) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return -1;
  }
  const host = u.hostname.toLowerCase();
  if (!host.includes("kook")) return -1;
  let score = 0;
  const path = u.pathname || "";
  const chMatch = path.match(/\/app\/channels\/(\d+)\/(\d+)\b/);
  if (chMatch) {
    const [, a, b] = chMatch;
    if ((a === g && b === c) || (a === c && b === g)) score = 5;
    else if (a === g || b === g) score = 3;
    else if (a === c || b === c) score = 2;
    else score = 2;
  } else if (path.includes("/app/channels/")) {
    score = 2;
  } else {
    score = 1;
  }
  const qpG = u.searchParams.get("g") || u.searchParams.get("guild_id");
  const qpC = u.searchParams.get("c") || u.searchParams.get("channel_id");
  if (qpG === g && qpC === c) score = Math.max(score, 5);
  else if (qpG === g) score = Math.max(score, 3);
  else if (qpC === c) score = Math.max(score, 2);
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
 */
function wireNetworkAndPageDiagnostics(cdp, page, log, diag) {
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
        const result = /** @type {{ body: string, base64Encoded: boolean }} */ (
          await cdp.send("Network.getResponseBody", { requestId: id })
        );
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
    logLine("info", `[ws] 已创建 | ${shortenUrl(String(evt.url ?? ""))}`);
    emit({
      kind: "ws_created",
      requestId: evt.requestId ?? "",
      url: String(evt.url ?? ""),
      cdpTimestamp: evt.timestamp,
    });
  });
  cdp.on("Network.webSocketWillSendHandshakeRequest", (evt) => {
    const req = evt.request ?? {};
    logLine("info", `[ws] 握手请求 → ${shortenUrl(String(req.url ?? ""))}`);
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

/**
 * @param {import('playwright').CDPSession} cdp
 * @param {Logger} log
 * @param {{
 *   onData: (buf: Buffer, meta: { requestId: string, opcode: number, isBinaryHint: boolean, pageUrl: string }) => void,
 *   diagnosticSink?: (evt: Record<string, unknown>) => void,
 * }} opts
 * @param {() => string} getPageUrl
 */
function wireWebSocketFrames(cdp, log, opts, getPageUrl) {
  let localSeq = 0;
  cdp.on("Network.webSocketFrameReceived", (evt) => {
    const requestId = evt.requestId ?? "";
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
    const decoded = decodeWebSocketFramePayload(buf, opcode);
    if (decoded.parsedJson !== undefined) {
      let line;
      try {
        line = JSON.stringify(decoded.parsedJson);
      } catch {
        line = "[object]";
      }
      log.info(
        `[WS 帧 #${localSeq} op=${opcode} ${decoded.decodePath}] ${line.length > 2800 ? `${line.slice(0, 2800)}…` : line}`
      );
    } else {
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
      parsedJson: decoded.parsedJson,
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

    const isBinaryHint = opcode === 2;
    opts.onData(buf, { requestId, opcode, isBinaryHint, pageUrl: getPageUrl() });
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
 *   networkTrace?: boolean,
 *   diagnosticSink?: (evt: Record<string, unknown>) => void,
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

  /**
   * @param {import('playwright').Page} page
   */
  async function attachToPage(page) {
    if (attached.has(page)) return;
    attached.add(page);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send("Network.enable");
    wireWebSocketFrames(cdp, log, opts, () => page.url() || "");
    if (wantDiag) {
      wireNetworkAndPageDiagnostics(cdp, page, log, {
        logEvents: networkTrace,
        sink: opts.diagnosticSink,
      });
      log.info(
        `已挂载页面/网络诊断${networkTrace ? "（控制台日志）" : ""}${opts.diagnosticSink ? "（实时 sink）" : ""}: ${page.url() || "(about:blank)"}`
      );
    }
    mounted.push({ cdp, page });
    log.info(`已挂载 Network.webSocketFrameReceived: ${page.url() || "(about:blank)"}`);
  }

  let browser;
  /** @type {boolean} */
  let ownedBrowser;
  /** @type {import('playwright').BrowserContext | null} */
  let headlessContext = null;
  /** @type {import('playwright').Page | null} */
  let headlessPage = null;
  /** @type {ReturnType<typeof setInterval> | null} */
  let reloadTimer = null;

  if (connectUrl) {
    ownedBrowser = false;
    log.info(`connectOverCDP: ${connectUrl}（监听你在该 Chrome 里打开/刷新的页面上的 WS）`);
    browser = await chromium.connectOverCDP(connectUrl);

    for (const ctx of browser.contexts()) {
      for (const page of ctx.pages()) {
        await attachToPage(page);
      }
      ctx.on("page", (page) => {
        void attachToPage(page).catch((e) => log.warn(`新标签页挂载 CDP 失败: ${e.message}`));
      });
    }

    log.info(
      `已在 ${mounted.length} 个标签页上启用监听。请在同一 Chrome 窗口中打开并刷新: ${opts.startUrl}（或你的目标页）`
    );
    opts.diagnosticSink?.({
      kind: "cdp_attached",
      mode: "connectOverCDP",
      connectUrl,
      tabCount: mounted.length,
      hintStartUrl: opts.startUrl,
    });
  } else {
    ownedBrowser = true;
    log.info("启动 Chromium (headless) …");
    opts.diagnosticSink?.({ kind: "cdp_boot", mode: "headless", startUrl: opts.startUrl });
    browser = await chromium.launch({ headless: false });
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
    browser,
    get mounted() {
      return mounted;
    },
    /**
     * 在已挂载 CDP 的 Kook 页签里执行 `goto` 打开目标频道。
     * 使用官方直链 `https://www.kookapp.cn/direct/channel?g={guildId}&c={channelId}`，
     * 避免 SPA 路径 `/app/channels/...` 两段数字的先后顺序与侧栏不一致时跳错。
     * 多标签 connectOverCDP 时按当前 `page.url()` 打分选页（不扫 DOM 里的 `<a href>`）。
     * @param {string} guildId
     * @param {string} channelId
     * @param {{ clientTraceId?: string }} [traceCtx] 可选，会写入 diagnosticSink 便于前端与终端日志对齐
     */
    async navigateKookChannel(guildId, channelId, traceCtx) {
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
      if (!/^\d+$/.test(g) || !/^\d+$/.test(c)) {
        return { ok: false, error: "guildId、channelId 须为数字" };
      }
      const targetUrl = kookChannelDirectUrl(g, c);
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
        const sc = scoreKookPageForChannelNav(url, g, c);
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
        `[kook-channel] CDP 已选标签 score=${top?.score ?? "?"} mounted=${mounted.length} page=${shortenUrl(pickedPageUrl, 200)} → goto ${shortenUrl(targetUrl, 200)}${clientTraceId ? ` trace=${clientTraceId}` : ""}`
      );
      opts.diagnosticSink?.({
        kind: "kook_channel_pick_page",
        guildId: g,
        channelId: c,
        targetUrl,
        pickedPageUrl,
        pickScore: top?.score ?? null,
        mountedCount: mounted.length,
        ...trace,
      });
      try {
        log.info(`[kook-channel] page.goto 开始 …${clientTraceId ? ` trace=${clientTraceId}` : ""}`);
        opts.diagnosticSink?.({
          kind: "kook_channel_nav_begin",
          guildId: g,
          channelId: c,
          targetUrl,
          pickedPageUrl,
          ...trace,
        });
        await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 90_000 });
        const finalUrl = page.url();
        log.info(`[kook-channel] page.goto 完成 final=${shortenUrl(finalUrl, 200)}${clientTraceId ? ` trace=${clientTraceId}` : ""}`);
        opts.diagnosticSink?.({
          kind: "kook_channel_nav_done",
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
        log.warn(`[kook-channel] page.goto 失败: ${err.message}${clientTraceId ? ` trace=${clientTraceId}` : ""}`);
        opts.diagnosticSink?.({
          kind: "kook_channel_nav_done",
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
    async close() {
      log.info("正在卸载 CDP 监听 …");
      if (reloadTimer) {
        clearInterval(reloadTimer);
        reloadTimer = null;
      }
      for (const { cdp } of mounted) {
        await cdp.detach().catch(() => {});
      }
      mounted.length = 0;

      if (ownedBrowser && headlessContext) {
        await headlessContext.close().catch(() => {});
        await browser.close().catch(() => {});
        log.info("无头浏览器已关闭");
      } else if (!ownedBrowser) {
        log.info("connectOverCDP 模式：未关闭你的 Chrome，仅已 detach CDP 会话");
      }
    },
  };
}
