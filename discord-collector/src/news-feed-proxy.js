/**
 * 平台热点 iframe：/api/news/feed/* → news_mornitor :8770 /api/v1/*
 * 使用显式 app.get/post（与 /api/news/status 同批部署，避免漏挂 app.use）
 */
import http from "node:http";
import https from "node:https";

export const NEWS_FEED_MOUNT = "/api/news/feed";
export const NEWS_FEED_ROUTES_VERSION = "explicit-v2";

/** @type {readonly [method: string, subpath: string][]} */
const FEED_ROUTES = [
  ["get", "/hotlists"],
  ["get", "/macro/timeline"],
  ["post", "/refresh"],
  ["get", "/fetch/status"],
  ["post", "/fetch/toggle"],
];

/**
 * @param {import('express').Express} app
 * @param {{ baseUrl?: string, log?: { warn: Function, error: Function, info?: Function } }} [opts]
 */
export function registerNewsFeedProxy(app, opts = {}) {
  const base = String(opts.baseUrl || "http://127.0.0.1:8770").replace(/\/$/, "");
  const log = opts.log || console;

  /** @type {URL} */
  let target;
  try {
    target = new URL(`${base}/`);
  } catch {
    log.error?.(`[news-feed-proxy] 无效 NEWS_WEB_BASE_URL: ${base}`);
    return;
  }

  const client = target.protocol === "https:" ? https : http;

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   * @param {string} v1Subpath 如 /hotlists
   */
  function forward(req, res, v1Subpath) {
    const raw = req.originalUrl || req.url || "";
    const qIdx = raw.indexOf("?");
    const qs = qIdx >= 0 ? raw.slice(qIdx) : "";
    const upstreamPath = `/api/v1${v1Subpath}${qs}`;
    const headers = { ...req.headers, host: target.host };
    delete headers["content-length"];
    if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];
    if (req.headers["transfer-encoding"]) {
      headers["transfer-encoding"] = req.headers["transfer-encoding"];
    }

    const pReq = client.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: upstreamPath,
        method: req.method,
        headers,
      },
      (pRes) => {
        res.status(pRes.statusCode || 502);
        for (const [k, v] of Object.entries(pRes.headers)) {
          if (v != null) res.setHeader(k, v);
        }
        pRes.pipe(res);
      },
    );

    pReq.on("error", (err) => {
      log.warn?.(`[news-feed-proxy] ${req.method} ${NEWS_FEED_MOUNT}${v1Subpath} → ${err.message}`);
      if (!res.headersSent) {
        res.status(502).json({
          ok: false,
          error: "news_mornitor 未就绪",
          hint: "collect:ui 会自动守护 :8770；或 pnpm run news:start",
        });
      } else {
        res.end();
      }
    });

    req.pipe(pReq);
  }

  for (const [method, sub] of FEED_ROUTES) {
    const path = `${NEWS_FEED_MOUNT}${sub}`;
    const handler = (req, res) => forward(req, res, sub);
    if (method === "get") app.get(path, handler);
    else if (method === "post") app.post(path, handler);
    else app.all(path, handler);
  }

  log.info?.(
    `[news-feed-proxy] 已注册 ${FEED_ROUTES.length} 条 ${NEWS_FEED_MOUNT} → ${base}/api/v1/* (${NEWS_FEED_ROUTES_VERSION})`,
  );
}
