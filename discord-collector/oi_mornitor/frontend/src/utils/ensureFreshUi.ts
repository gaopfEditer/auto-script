/**
 * 对比当前页脚本 hash 与最新 index.html；过期则强制刷新。
 * 解决：父页 KeepAlive / 浏览器强缓存导致 iframe 一直跑旧包。
 */
export async function ensureFreshUi(): Promise<boolean> {
  try {
    const current = [...document.scripts]
      .map((s) => s.src)
      .find((src) => /\/assets\/index-[A-Za-z0-9_-]+\.js/.test(src));
    if (!current) return false;

    const curName = current.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1];
    if (!curName) return false;

    const r = await fetch(`/?_fresh=${Date.now()}`, { cache: "no-store" });
    if (!r.ok) return false;
    const html = await r.text();
    const latest = html.match(/\/assets\/(index-[A-Za-z0-9_-]+\.js)/)?.[1];
    if (!latest || latest === curName) return false;

    const u = new URL(window.location.href);
    u.searchParams.set("v", latest);
    window.location.replace(u.href);
    return true;
  } catch {
    return false;
  }
}
