/**
 * 将平台热点页反代到本机 news_mornitor（默认 :8770）。
 * 供公网 https://op.c.ezcoin.ink/news 的 iframe（/news/index.html）使用，
 * 避免再回退到主站 SPA /show。
 *
 * 映射：
 *   /news/index.html → /
 *   /static/*        → /static/*
 *   /api/v1/*        → /api/v1/*
 */
import http from "node:http";

/**
 * @param {import('express').Express} app
 * @param {{ baseUrl?: string, log?: { warn: Function, error: Function } }} [opts]
 */
export function registerNewsMornitorProxy(app, opts = {}) {
  const base = String(opts.baseUrl || process.env.NEWS_WEB_BASE_URL || "http://127.0.0.1:8770").replace(
    /\/$/,
    "",
  );
  const log = opts.log || console;
  let target;
  try {
    target = new URL(base);
  } catch {
    log.error?.(`[news-proxy] 无效 NEWS_WEB_BASE_URL: ${base}`);
    return;
  }

  /**
   * @param {import('express').Request} req
   * @returns {string}
   */
  function outgoingPath(req) {
    const raw = String(req.originalUrl || req.url || "/");
    const url = new URL(raw, "http://127.0.0.1");
    if (url.pathname === "/news/index.html" || url.pathname === "/news/") {
      return `/${url.search}`;
    }
    return url.pathname + url.search;
  }

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  function proxy(req, res) {
    const headers = { ...req.headers, host: target.host };
    delete headers["content-length"];
    if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];
    if (req.headers["transfer-encoding"]) headers["transfer-encoding"] = req.headers["transfer-encoding"];

    const pReq = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: outgoingPath(req),
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
      log.warn?.(`[news-proxy] ${req.method} ${req.originalUrl} → ${err.message}`);
      if (!res.headersSent) {
        if (String(req.path || "").startsWith("/api/")) {
          res.status(502).json({
            ok: false,
            error: "news_mornitor 未就绪",
            hint: "collect:ui 会自动守护 :8770；或手动：pnpm run news:start",
          });
        } else {
          res.status(502).type("text/plain").send("news_mornitor 未就绪");
        }
      } else {
        res.end();
      }
    });

    req.pipe(pReq);
  }

  app.all("/news/index.html", proxy);
  app.all("/static", proxy);
  app.all("/static/*", proxy);
  app.all("/api/v1", proxy);
  app.all("/api/v1/*", proxy);
}
