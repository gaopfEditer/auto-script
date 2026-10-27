/**
 * 将 /api/content/* 反代到 Python content_board。
 */
import http from "node:http";

/**
 * @param {import('express').Express} app
 * @param {{ baseUrl?: string, log?: { warn: Function, error: Function } }} [opts]
 */
export function registerContentBoardProxy(app, opts = {}) {
  const base = String(opts.baseUrl || process.env.CONTENT_BOARD_BASE_URL || "http://127.0.0.1:8767").replace(
    /\/$/,
    "",
  );
  const log = opts.log || console;
  let target;
  try {
    target = new URL(base);
  } catch {
    log.error?.(`[content-proxy] 无效 CONTENT_BOARD_BASE_URL: ${base}`);
    return;
  }

  /**
   * @param {import('express').Request} req
   * @param {import('express').Response} res
   */
  function proxy(req, res) {
    const url = new URL(req.originalUrl || req.url, base);
    const headers = { ...req.headers, host: target.host };
    delete headers["content-length"]; // 让 Node 重算；multipart 需保留原始流
    // 对有 body 的请求保留 content-length / transfer-encoding
    if (req.headers["content-length"]) headers["content-length"] = req.headers["content-length"];
    if (req.headers["transfer-encoding"]) headers["transfer-encoding"] = req.headers["transfer-encoding"];

    const pReq = http.request(
      {
        protocol: target.protocol,
        hostname: target.hostname,
        port: target.port || (target.protocol === "https:" ? 443 : 80),
        path: url.pathname + url.search,
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
      log.warn?.(`[content-proxy] ${req.method} ${req.originalUrl} → ${err.message}`);
      if (!res.headersSent) {
        res.status(502).json({
          ok: false,
          error: "content_board 未就绪",
          hint: "collect:ui 会自动拉起；或手动：pnpm run content:start",
        });
      } else {
        res.end();
      }
    });

    req.pipe(pReq);
  }

  app.all("/api/content", proxy);
  app.all("/api/content/*", proxy);
}
