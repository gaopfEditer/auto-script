/**
 * 巨鲸助手 Pro（kolvip.vip/web）CDP DOM 抓取与消息行转换。
 */
import { chromium } from "playwright";
import { kolvipWebUrl } from "./kolvip-cdp-config.js";

export {
  kolvipStableMessageId,
  parseKolvipMessageTimeMs,
  kolvipMessageToDiscordRow,
} from "./kolvip-cdp-message.js";

const PROXY_ENV_KEYS = [
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "ALL_PROXY",
  "http_proxy",
  "https_proxy",
  "all_proxy",
];

/**
 * @template T
 * @param {() => Promise<T>} fn
 */
async function withLocalhostNoProxy(fn) {
  /** @type {Record<string, string | undefined>} */
  const saved = {};
  for (const k of PROXY_ENV_KEYS) {
    saved[k] = process.env[k];
    delete process.env[k];
  }
  const prevNo = process.env.NO_PROXY;
  const prevNoL = process.env.no_proxy;
  process.env.NO_PROXY = "127.0.0.1,localhost,::1";
  process.env.no_proxy = process.env.NO_PROXY;
  try {
    return await fn();
  } finally {
    for (const k of PROXY_ENV_KEYS) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
    if (prevNo === undefined) delete process.env.NO_PROXY;
    else process.env.NO_PROXY = prevNo;
    if (prevNoL === undefined) delete process.env.no_proxy;
    else process.env.no_proxy = prevNoL;
  }
}

import { parseCdpConnectHostPort } from "./kolvip-cdp-connect.js";

/**
 * @param {string} connectUrl
 */
async function resolveCdpEndpoint(connectUrl) {
  const { base } = parseCdpConnectHostPort(connectUrl);
  const versionUrl = `${base}/json/version`;
  try {
    const res = await withLocalhostNoProxy(() =>
      fetch(versionUrl, { signal: AbortSignal.timeout(5_000) })
    );
    if (!res.ok) return base;
    const j = await res.json();
    const ws = String(j.webSocketDebuggerUrl || "").trim();
    return ws || base;
  } catch {
    return base;
  }
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {import("playwright").Browser} browser
 * @param {string} webUrl
 */
async function findOrCreateKolvipPage(browser, webUrl) {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      let u = "";
      try {
        u = p.url();
      } catch {
        continue;
      }
      if (/https?:\/\/(?:www\.)?kolvip\.vip/i.test(u)) {
        return p;
      }
    }
  }
  let ctx = browser.contexts()[0];
  if (!ctx) ctx = await browser.newContext();
  const page = await ctx.newPage();
  await page.goto(webUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
  return page;
}

/**
 * @param {import("playwright").Page} page
 * @param {string} kolvipChannelId
 * @param {number} maxMessages
 */
export async function scrapeKolvipChannelFeed(page, kolvipChannelId, maxMessages) {
  const ch = String(kolvipChannelId).trim();
  const opener = page.locator(`[data-open-ch="${ch}"]`).first();
  if (!(await opener.count())) {
    throw new Error(`未找到频道入口 data-open-ch="${ch}"（请确认已登录 kolvip.vip/web）`);
  }
  await opener.click({ timeout: 8_000 });
  await page
    .locator("#v-channel #feed.feed #msgs, #feed.feed #msgs, #msgs")
    .first()
    .waitFor({ state: "attached", timeout: 12_000 })
    .catch(() => {});
  await sleep(600);

  const dom = await page.evaluate((maxN) => {
    const feed =
      document.querySelector("#v-channel #feed.feed") ||
      document.querySelector("#feed.feed") ||
      document.querySelector("#msgs")?.closest(".feed");
    const msgsRoot = feed?.querySelector("#msgs") || document.querySelector("#msgs");
    if (!msgsRoot) return [];
    const rows = [...msgsRoot.querySelectorAll(":scope > .row[data-id]")];
    /** @type {Array<Record<string, string>>} */
    const out = [];
    for (const row of rows.slice(-maxN)) {
      const dataId = row.getAttribute("data-id") || "";
      if (!dataId) continue;
      const article = row.querySelector("article.msg.bmsg") || row.querySelector("article.msg");
      if (!article) continue;
      const bubble = article.querySelector(".bubble");
      const timeEl = article.querySelector(".btime");
      const who = article.querySelector(".who");
      const paras = bubble ? [...bubble.querySelectorAll("p.ft")] : [];
      const text = paras.map((p) => p.textContent?.trim() || "").filter(Boolean).join("\n");
      const frame = article.querySelector(".frame[data-src], .frame[data-full]");
      const imageUrl =
        frame?.getAttribute("data-full")?.trim() ||
        frame?.getAttribute("data-src")?.trim() ||
        "";
      out.push({
        dataId,
        text,
        author: who?.textContent?.trim() || "",
        timeText: timeEl?.textContent?.trim() || "",
        timeTitle: bubble?.getAttribute("title")?.trim() || "",
        imageUrl,
      });
    }
    return out;
  }, maxMessages);

  if (!Array.isArray(dom)) return [];
  return dom.map((d) => ({
    dataId: String(d.dataId ?? ""),
    text: String(d.text ?? ""),
    author: String(d.author ?? ""),
    timeText: String(d.timeText ?? ""),
    timeTitle: String(d.timeTitle ?? ""),
    imageUrl: String(d.imageUrl ?? ""),
  }));
}

/**
 * @param {string} connectUrl
 */
export async function probeKolvipCdp(connectUrl) {
  const { base, host, port } = parseCdpConnectHostPort(connectUrl);
  try {
    const [verRes, listRes] = await withLocalhostNoProxy(async () => {
      const ver = await fetch(`${base}/json/version`, { signal: AbortSignal.timeout(4_000) });
      const list = await fetch(`${base}/json/list`, { signal: AbortSignal.timeout(4_000) });
      return [ver, list];
    });
    const version = verRes.ok ? await verRes.json().catch(() => ({})) : {};
    const tabs = listRes.ok ? await listRes.json().catch(() => []) : [];
    const kolvipTabs = (Array.isArray(tabs) ? tabs : []).filter((t) =>
      /kolvip\.vip/i.test(String(t?.url ?? ""))
    );
    return {
      ok: verRes.ok,
      host,
      port,
      browser: String(version.Browser ?? ""),
      kolvipTabCount: kolvipTabs.length,
      tabs: kolvipTabs.slice(0, 8).map((t) => ({ title: t.title, url: t.url })),
    };
  } catch (e) {
    return {
      ok: false,
      host,
      port,
      error: /** @type {Error} */ (e).message,
      tabs: [],
    };
  }
}

/**
 * @param {{
 *   connectUrl: string,
 *   channels: Array<{ logicName: string, kolvipChannelId: string, discordChannelId: string }>,
 *   maxPerChannel: number,
 *   webUrl?: string,
 *   log: ReturnType<typeof import("./logger.js").createLogger>,
 * }} opts
 */
export async function fetchKolvipChannelsViaCdp(opts) {
  const connectUrl = String(opts.connectUrl ?? "").trim();
  if (!connectUrl) {
    throw new Error("未配置 KOLVIP_CDP_CONNECT_URL 或 CDP_CONNECT_URL");
  }
  const webUrl = opts.webUrl || kolvipWebUrl();
  const maxPerChannel = Math.min(80, Math.max(5, opts.maxPerChannel || 30));
  const endpoint = await resolveCdpEndpoint(connectUrl);
  let browser;
  try {
    browser = await withLocalhostNoProxy(() => chromium.connectOverCDP(endpoint));
  } catch (e) {
    throw new Error(
      `无法连接 CDP ${connectUrl}: ${/** @type {Error} */ (e).message}（请在 :9222 Chrome 登录 kolvip.vip/web）`
    );
  }

  /** @type {Array<{ channel: typeof opts.channels[number], messages: KolvipDomMessage[], error?: string }>} */
  const results = [];
  try {
    const page = await findOrCreateKolvipPage(browser, webUrl);
    const loc = page.url();
    if (!/kolvip\.vip/i.test(loc)) {
      await page.goto(webUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
      await sleep(800);
    }
    if (/\/login/i.test(page.url())) {
      throw new Error("未登录巨鲸：请在该 Chrome（CDP 端口）打开 kolvip.vip/web 并完成登录");
    }

    for (const channel of opts.channels) {
      try {
        const messages = await scrapeKolvipChannelFeed(
          page,
          channel.kolvipChannelId,
          maxPerChannel
        );
        log.info(
          `巨鲸 ${channel.logicName} ch=${channel.kolvipChannelId} 可见 ${messages.length} 条`
        );
        results.push({ channel, messages });
      } catch (e) {
        const error = /** @type {Error} */ (e).message;
        log.warn(`巨鲸频道 ${channel.logicName} 失败: ${error}`);
        results.push({ channel, messages: [], error });
      }
    }
  } finally {
    await browser.close().catch(() => {});
  }
  return results;
}
