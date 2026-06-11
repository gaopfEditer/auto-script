/**
 * 将 collector-ui 的 /api/youtube-fetch/* 代理到 youtube-fetch 服务。
 */

/**
 * @param {import('express').Express} app
 * @param {{ baseUrl: string, log: ReturnType<import('./logger.js').createLogger> }} opts
 */
export function registerYoutubeFetchProxyRoutes(app, opts) {
  const { baseUrl, log } = opts;
  const root = baseUrl.replace(/\/$/, "");

  /**
   * @param {string} method
   * @param {string} path
   * @param {import('express').Request} req
   */
  async function proxy(method, path, req) {
    const url = `${root}${path}`;
    const headers = { Accept: "application/json" };
    /** @type {RequestInit} */
    const init = { method, headers };
    if (method === "POST") {
      headers["Content-Type"] = "application/json";
      init.body = JSON.stringify(req.body ?? {});
    }
    const res = await fetch(url, init);
    const text = await res.text();
    let body;
    try {
      body = text.trim() ? JSON.parse(text) : {};
    } catch {
      body = { ok: false, error: `youtube-fetch 返回非 JSON（HTTP ${res.status}）` };
    }
    return { status: res.status, body };
  }

  app.get("/api/youtube-fetch/health", async (_req, res) => {
    try {
      const out = await proxy("GET", "/health", _req);
      res.status(out.status).json(out.body);
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message ?? e);
      log.warn(`youtube-fetch health: ${msg}`);
      res.status(502).json({
        ok: false,
        error: `无法连接 youtube-fetch（${root}）：${msg}`,
      });
    }
  });

  app.post("/api/youtube-fetch/queue", async (req, res) => {
    try {
      const out = await proxy("POST", "/api/queue", req);
      res.status(out.status).json(out.body);
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message ?? e);
      log.warn(`youtube-fetch queue POST: ${msg}`);
      res.status(502).json({
        ok: false,
        error: `无法连接 youtube-fetch（${root}）：${msg}`,
      });
    }
  });

  app.get("/api/youtube-fetch/queue", async (req, res) => {
    try {
      const limit = req.query.limit ? `?limit=${encodeURIComponent(String(req.query.limit))}` : "";
      const out = await proxy("GET", `/api/queue${limit}`, req);
      res.status(out.status).json(out.body);
    } catch (e) {
      const msg = String(/** @type {Error} */ (e).message ?? e);
      log.warn(`youtube-fetch queue GET: ${msg}`);
      res.status(502).json({
        ok: false,
        error: `无法连接 youtube-fetch（${root}）：${msg}`,
      });
    }
  });
}
