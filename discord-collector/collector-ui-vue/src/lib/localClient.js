/** 浏览器是否通过 localhost / 127.0.0.1 访问（本机用户）。 */
export function isLocalClient() {
  if (typeof location === "undefined") return true;
  const host = String(location.hostname || "").toLowerCase();
  return host === "localhost" || host === "127.0.0.1" || host === "[::1]" || host === "::1";
}
