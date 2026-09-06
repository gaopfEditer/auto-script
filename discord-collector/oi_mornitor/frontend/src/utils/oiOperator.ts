/**
 * 本机产生端 vs 生产只读端。
 * - 产生端：合并 SSE ticker、推后台、胜率核实/重拉
 * - 只读端：只拉后台展示，隐藏写操作
 */
export function isOiOperator(): boolean {
  try {
    if (String(import.meta.env.VITE_OI_OPERATOR ?? "").trim() === "1") return true;
  } catch {
    /* ignore */
  }
  try {
    if (import.meta.env.DEV) return true;
  } catch {
    /* ignore */
  }
  if (typeof location === "undefined") return false;
  const h = location.hostname;
  return h === "localhost" || h === "127.0.0.1";
}
