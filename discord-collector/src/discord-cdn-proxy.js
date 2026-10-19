/**
 * Discord CDN 图片经本机代理（带 Referer），减轻浏览器直连 403；仅允许 Discord 域名。
 */

/** @param {string} raw */
export function isAllowedDiscordCdnUrl(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return false;
  try {
    const u = new URL(s);
    if (u.protocol !== "https:") return false;
    const h = u.hostname.toLowerCase();
    return (
      h === "cdn.discordapp.com" ||
      h === "media.discordapp.net" ||
      h.endsWith(".discordapp.net") ||
      h.endsWith(".discordapp.com")
    );
  } catch {
    return false;
  }
}

/**
 * @param {import("express").Express} app
 * @param {import("./logger.js").createLogger} log
 */
export function registerDiscordCdnProxyRoutes(app, log) {
  app.get("/api/discord/cdn-proxy", async (req, res) => {
    const u = String(req.query.u ?? req.query.url ?? "").trim();
    if (!isAllowedDiscordCdnUrl(u)) {
      res.status(400).json({ ok: false, error: "invalid url" });
      return;
    }
    try {
      const upstream = await fetch(u, {
        headers: {
          Accept: "image/*,*/*;q=0.8",
          Referer: "https://discord.com/",
          "User-Agent":
            "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        },
        redirect: "follow",
        signal: AbortSignal.timeout(20_000),
      });
      if (!upstream.ok) {
        res.status(upstream.status).end();
        return;
      }
      const ct = upstream.headers.get("content-type");
      if (ct) res.setHeader("Content-Type", ct);
      res.setHeader("Cache-Control", "private, max-age=1800");
      const buf = Buffer.from(await upstream.arrayBuffer());
      res.send(buf);
    } catch (e) {
      log.debug(`[discord-cdn-proxy] ${String(/** @type {Error} */ (e).message ?? e)}`);
      res.status(502).end();
    }
  });
}
