/** 形态页带币种打开 K 线（可选自动加入监听） */
export function patternsPathForSymbol(symbol: string, opts?: { add?: boolean }): string {
  const sym = String(symbol || "").trim().toUpperCase();
  if (!sym) return "/patterns";
  const p = new URLSearchParams();
  p.set("symbol", sym);
  if (opts?.add) p.set("add", "1");
  return `/patterns?${p.toString()}`;
}
