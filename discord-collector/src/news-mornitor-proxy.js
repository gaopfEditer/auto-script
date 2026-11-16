/**
 * 将平台热点页反代到本机 news_mornitor（默认 :8770）。
 * 供公网 https://op.c.ezcoin.ink/news 的 iframe（/news/index.html）使用，
 * 避免再回退到主站 SPA /show。
 *
 * 映射：
 *   /news/index.html → /
 *   /static/*        → /static/*
 *   /api/v1/{macro,hotlists,events,…} → news 子路径（勿抢 /api/v1/cards）
 */
import http from "node:http";

/** news_mornitor 自有 API；不得包含 discord-collector 的 /api/v1/cards 等 */
const NEWS_API_PREFIXES = [
  "/api/v1/health",
  "/api/v1/macro",
  "/api/v1/hotlists",
  "/api/v1/events",
  "/api/v1/refresh",
  "/api/v1/boards",
  "/api/v1/tickers",
  "/api/v1/fetch",
];

/**
 * @param {string} pathname
 */
function isNewsMornitorApiPath(pathname) {
  const p = String(pathname || "").trim() || "/";
  return NEWS_API_PREFIXES.some((prefix) => p === prefix || p.startsWith(`${prefix}/`));
}

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
  app.use((req, res, next) => {
    const url = new URL(String(req.originalUrl || req.url || "/"), "http://127.0.0.1");
    if (!isNewsMornitorApiPath(url.pathname)) return next();
    return proxy(req, res);
  });
}
