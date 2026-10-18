/**
 * 对比当前页脚本 hash 与最新 index.html；过期则强制刷新。
 * 解决：父页 KeepAlive / 浏览器强缓存导致 iframe 一直跑旧包。
 */
const FRESH_UI_RELOAD_KEY = "oi_ui_fresh_reload_ts";

export async function ensureFreshUi(): Promise<boolean> {
  try {
    // 主站 iframe 嵌入时勿 location.replace，否则周期性白屏闪一下
    if (typeof window !== "undefined" && window.self !== window.top) {
      return false;
    }

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

    const now = Date.now();
    try {
      const last = Number(sessionStorage.getItem(FRESH_UI_RELOAD_KEY) || "0");
      if (last && now - last < 15_000) return false;
      sessionStorage.setItem(FRESH_UI_RELOAD_KEY, String(now));
    } catch {
      /* ignore */
    }

    const u = new URL(window.location.href);
    u.searchParams.set("v", latest);
    window.location.replace(u.href);
    return true;
  } catch {
    return false;
  }
}
