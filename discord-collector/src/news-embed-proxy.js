/**
 * 将 /news-embed/* 反代到 news_mornitor（:8770），避免生产 iframe 误嵌主站 SPA /news/index.html。
 */
import http from "node:http";
import https from "node:https";

/** @type {readonly string[]} */
export const NEWS_EMBED_MOUNT = "/news-embed";

/**
 * @param {import('express').Express} app
 * @param {{ baseUrl?: string, mount?: string, log?: { warn: Function, error: Function } }} [opts]
 */
export function registerNewsEmbedProxy(app, opts = {}) {
  const base = String(opts.baseUrl || "http://127.0.0.1:8770").replace(/\/$/, "");
  const mount = String(opts.mount || NEWS_EMBED_MOUNT).replace(/\/$/, "") || NEWS_EMBED_MOUNT;
  const log = opts.log || console;

  /** @type {URL} */
  let target;
  try {
    target = new URL(`${base}/`);
  } catch {
    log.error?.(`[news-embed-proxy] 无效 NEWS_WEB_BASE_URL: ${base}`);
    return;
  }

  const client = target.protocol === "https:" ? https : http;

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  function proxy(req, res) {
    const raw = req.originalUrl || req.url || "/";
    const qIdx = raw.indexOf("?");
    const pathPart = qIdx >= 0 ? raw.slice(0, qIdx) : raw;
    const qs = qIdx >= 0 ? raw.slice(qIdx) : "";
    let stripped = pathPart;
    if (stripped === mount) stripped = "/";
    else if (stripped.startsWith(`${mount}/`)) {
      stripped = stripped.slice(mount.length) || "/";
    }
    const upstreamPath = (stripped.startsWith("/") ? stripped : `/${stripped}`) + qs;
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
      log.warn?.(`[news-embed-proxy] ${req.method} ${mount}${upstreamPath} → ${err.message}`);
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

  app.get(mount, (_req, res) => {
    res.redirect(301, `${mount}/`);
  });
  app.all(`${mount}/`, proxy);
  app.all(`${mount}/*`, proxy);
}
