/**
 * 判断 HTTP 请求是否来自本机（与 Show 布局写入策略一致）。
 * @param {import("express").Request} req
 */
export function isLocalRequest(req) {
  const ip = String(req.socket?.remoteAddress ?? req.ip ?? "");
  return (
    ip === "127.0.0.1" ||
    ip === "::1" ||
    ip === "::ffff:127.0.0.1" ||
    ip.endsWith("127.0.0.1")
  );
}

/**
 * @param {import("express").Request} req
 * @param {import("express").Response} res
 * @param {import("express").NextFunction} next
 */
export function requireLocalRequest(req, res, next) {
  if (isLocalRequest(req)) {
    next();
    return;
  }
  res.status(403).json({ ok: false, error: "仅本机可执行此操作" });
}
