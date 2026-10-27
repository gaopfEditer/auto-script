/**
 * 附加本机 Chrome CDP，从已登录的 X/Twitter 列表页抓取最新帖。
 * 不翻历史：只读当前时间线可见条目。
 */
import { chromium } from "playwright";

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

/** @param {string} host @param {number} port */
export function twitterCdpBaseUrl(host, port) {
  const h = String(host || "127.0.0.1").trim() || "127.0.0.1";
  const p = Number(port) || 9222;
  return `http://${h}:${p}`;
}

/**
 * @param {string} raw
 * @returns {{ id: string, url: string, label: string, kind: "list" | "user" } | null}
 */
export function parseTwitterListRef(raw) {
  const s = String(raw ?? "").trim();
  if (!s) return null;
  const listUrl = s.match(
    /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/i\/lists\/(\d+)/i
  );
  if (listUrl) {
    return {
      id: listUrl[1],
      url: `https://x.com/i/lists/${listUrl[1]}`,
      label: `列表 ${listUrl[1]}`,
      kind: "list",
    };
  }
  const namedList = s.match(
    /https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)\/lists\/([^/?#]+)/i
  );
  if (namedList) {
    const handle = namedList[1];
    const slug = namedList[2];
    return {
      id: `${handle}/${slug}`,
      url: `https://x.com/${handle}/lists/${slug}`,
      label: `${handle}/${slug}`,
      kind: "list",
    };
  }
  if (/^\d{6,}$/.test(s)) {
    return {
      id: s,
      url: `https://x.com/i/lists/${s}`,
      label: `列表 ${s}`,
      kind: "list",
    };
  }
  const userUrl = s.match(/https?:\/\/(?:www\.)?(?:x|twitter)\.com\/([^/?#]+)/i);
  let handle = "";
  if (userUrl) handle = userUrl[1];
  else handle = s.replace(/^@/, "");
  handle = handle.replace(/\/.*$/, "");
  if (
    handle &&
    !["i", "home", "explore", "search", "settings", "compose"].includes(handle.toLowerCase()) &&
    /^[A-Za-z0-9_]{1,15}$/.test(handle)
  ) {
    return {
      id: `user:${handle}`,
      url: `https://x.com/${handle}`,
      label: `@${handle}`,
      kind: "user",
    };
  }
  return null;
}

/** @param {unknown[]} raws */
export function parseTwitterListRefs(raws) {
  /** @type {Map<string, ReturnType<typeof parseTwitterListRef>>} */
  const map = new Map();
  for (const raw of raws ?? []) {
    const item = parseTwitterListRef(raw);
    if (item && !map.has(item.id)) map.set(item.id, item);
  }
  return [...map.values()];
}

/** @param {unknown} root */
export function extractTweetsFromGraphqlJson(root) {
  /** @type {Array<{ tweetId: string, handle: string, displayName: string, text: string, createdAt: string | null, url: string }>} */
  const out = [];
  const seen = new Set();
  const stack = [root];
  while (stack.length) {
    const cur = stack.pop();
    if (!cur || typeof cur !== "object") continue;
    if (Array.isArray(cur)) {
      for (const x of cur) stack.push(x);
      continue;
    }
    const rec = /** @type {Record<string, unknown>} */ (cur);
    let tweet = rec.tweet_results && typeof rec.tweet_results === "object"
      ? /** @type {Record<string, unknown>} */ (rec.tweet_results).result
      : rec.tweetResult && typeof rec.tweetResult === "object"
        ? /** @type {Record<string, unknown>} */ (rec.tweetResult).result
        : null;
    if (tweet && typeof tweet === "object") {
      const t = /** @type {Record<string, unknown>} */ (tweet);
      if (t.tweet && typeof t.tweet === "object") tweet = t.tweet;
    }
    if (tweet && typeof tweet === "object") {
      const t = /** @type {Record<string, unknown>} */ (tweet);
      const legacy =
        t.legacy && typeof t.legacy === "object"
          ? /** @type {Record<string, unknown>} */ (t.legacy)
          : {};
      const core =
        t.core && typeof t.core === "object"
          ? /** @type {Record<string, unknown>} */ (t.core)
          : {};
      const userResults =
        (core.user_results && typeof core.user_results === "object"
          ? /** @type {Record<string, unknown>} */ (core.user_results).result
          : null) ||
        (core.user_result && typeof core.user_result === "object"
          ? /** @type {Record<string, unknown>} */ (core.user_result).result
          : null);
      const user =
        userResults && typeof userResults === "object"
          ? /** @type {Record<string, unknown>} */ (userResults)
          : {};
      const userLegacy =
        user.legacy && typeof user.legacy === "object"
          ? /** @type {Record<string, unknown>} */ (user.legacy)
          : {};
      const id = String(t.rest_id ?? legacy.id_str ?? "").trim();
      if (id && !seen.has(id)) {
        seen.add(id);
        const handle = String(userLegacy.screen_name ?? "").trim();
        const authorId = String(user.rest_id ?? userLegacy.id_str ?? "").trim();
        const avatarUrl = String(
          userLegacy.profile_image_url_https ?? userLegacy.profile_image_url ?? ""
        )
          .replace("_normal.", ".")
          .trim();
        out.push({
          tweetId: id,
          handle,
          displayName: String(userLegacy.name ?? "").trim(),
          text: String(legacy.full_text ?? legacy.text ?? "").trim(),
          createdAt: legacy.created_at ? String(legacy.created_at) : null,
          url: `https://x.com/${handle || "i"}/status/${id}`,
          authorId: authorId || undefined,
          avatarUrl: avatarUrl || undefined,
        });
      }
    }
    for (const v of Object.values(rec)) {
      if (v && typeof v === "object") stack.push(v);
    }
  }
  return out;
}

/** @param {string} createdAt */
export function twitterTimeToIso(createdAt) {
  if (!createdAt) return null;
  const d = new Date(createdAt);
  return Number.isNaN(d.getTime()) ? null : d.toISOString();
}

/**
 * @param {string} host
 * @param {number} port
 */
export async function probeTwitterCdp(host, port) {
  const base = twitterCdpBaseUrl(host, port);
  const versionUrl = `${base}/json/version`;
  const listUrl = `${base}/json/list`;
  try {
    const [verRes, listRes] = await withLocalhostNoProxy(async () => {
      const ver = await fetch(versionUrl, { signal: AbortSignal.timeout(4_000) });
      const list = await fetch(listUrl, { signal: AbortSignal.timeout(4_000) });
      return [ver, list];
    });
    if (!verRes.ok) {
      return {
        ok: false,
        base,
        error: `CDP ${versionUrl} HTTP ${verRes.status}`,
        tabs: [],
      };
    }
    const version = await verRes.json().catch(() => ({}));
    /** @type {Array<Record<string, unknown>>} */
    let tabs = [];
    if (listRes.ok) {
      const raw = await listRes.json().catch(() => []);
      tabs = Array.isArray(raw) ? raw : [];
    }
    return {
      ok: true,
      base,
      browser: String(version.Browser ?? version["User-Agent"] ?? ""),
      ws: String(version.webSocketDebuggerUrl ?? ""),
      tabs: tabs.map((t) => ({
        id: String(t.id ?? ""),
        title: String(t.title ?? ""),
        url: String(t.url ?? ""),
        type: String(t.type ?? ""),
      })),
    };
  } catch (e) {
    return {
      ok: false,
      base,
      error: /** @type {Error} */ (e).message,
      tabs: [],
    };
  }
}

/**
 * @param {string} connectUrl
 */
async function resolveCdpEndpoint(connectUrl) {
  const raw = String(connectUrl || "").trim();
  if (!raw) return raw;
  if (/^wss?:\/\//i.test(raw)) return raw;
  let base = raw.replace(/\/+$/, "");
  if (!/^https?:\/\//i.test(base)) base = `http://${base}`;
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

/**
 * @param {import("playwright").Browser} browser
 */
async function findOrCreateXPage(browser) {
  for (const ctx of browser.contexts()) {
    for (const p of ctx.pages()) {
      let u = "";
      try {
        u = p.url();
      } catch {
        continue;
      }
      if (/https?:\/\/(www\.)?(x|twitter)\.com/i.test(u) && !/\/(login|i\/flow)/i.test(u)) {
        return p;
      }
    }
  }
  let ctx = browser.contexts()[0];
  if (!ctx) ctx = await browser.newContext();
  return ctx.newPage();
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * @param {import("playwright").Page} page
 * @param {string} targetUrl
 * @param {number} maxTweets
 * @param {ReturnType<typeof import("./logger.js").createLogger>} log
 */
async function scrapePageTweets(page, targetUrl, maxTweets, log) {
  /** @type {Array<ReturnType<typeof extractTweetsFromGraphqlJson>[number]>} */
  const fromNet = [];
  const onResponse = async (res) => {
    try {
      const url = res.url();
      if (!/\/i\/api\/graphql\//i.test(url)) return;
      if (
        !/ListLatestTweetsTimeline|ListTweets|UserTweets|HomeLatestTimeline|SearchTimeline/i.test(
          url
        )
      ) {
        return;
      }
      if (res.status() !== 200) return;
      const json = await res.json().catch(() => null);
      if (!json) return;
      fromNet.push(...extractTweetsFromGraphqlJson(json));
    } catch {
      /* ignore */
    }
  };
  page.on("response", onResponse);

  try {
    await page.goto(targetUrl, { waitUntil: "domcontentloaded", timeout: 25_000 });
    await sleep(1_200);
    const loc = page.url();
    if (/\/(login|i\/flow\/login)/i.test(loc)) {
      throw new Error("未登录 X：请先在该 Chrome（CDP 端口）里打开 x.com 并登录");
    }
    try {
      const latestTab = page
        .locator('[role="tab"]')
        .filter({ hasText: /Latest|最新/i })
        .first();
      if (await latestTab.count()) {
        await latestTab.click({ timeout: 2_000 }).catch(() => {});
        await sleep(800);
      }
    } catch {
      /* optional */
    }
    await page
      .waitForSelector('article[data-testid="tweet"]', { timeout: 18_000 })
      .catch(() => {});
    await page.mouse.wheel(0, 600);
    await sleep(800);
  } finally {
    page.off("response", onResponse);
  }

  /** @type {Map<string, ReturnType<typeof extractTweetsFromGraphqlJson>[number]>} */
  const map = new Map();
  for (const t of fromNet) {
    if (t.tweetId && !map.has(t.tweetId)) map.set(t.tweetId, t);
  }

  try {
    const dom = await page.evaluate(() => {
      const articles = [...document.querySelectorAll('article[data-testid="tweet"]')];
      return articles
        .map((el) => {
          const time = el.querySelector("time");
          const statusLink = [...el.querySelectorAll('a[href*="/status/"]')].find((a) =>
            /\/status\/\d+/.test(a.getAttribute("href") || "")
          );
          const href = statusLink?.getAttribute("href") || "";
          const m = href.match(/\/([^/]+)\/status\/(\d+)/);
          const textEl = el.querySelector('[data-testid="tweetText"]');
          const nameRoot = el.querySelector('[data-testid="User-Name"]');
          const displayName = nameRoot?.querySelector("span")?.textContent?.trim() || "";
          return {
            tweetId: m?.[2] || "",
            handle: m?.[1] || "",
            displayName,
            text: (textEl && "innerText" in textEl ? String(textEl.innerText) : "").trim(),
            createdAt: time?.getAttribute("datetime") || null,
            url: href ? (href.startsWith("http") ? href : `https://x.com${href}`) : "",
          };
        })
        .filter((t) => t.tweetId);
    });
    if (Array.isArray(dom)) {
      for (const t of dom) {
        const id = String(t?.tweetId ?? "");
        if (!id) continue;
        if (!map.has(id)) {
          map.set(id, {
            tweetId: id,
            handle: String(t.handle ?? ""),
            displayName: String(t.displayName ?? ""),
            text: String(t.text ?? ""),
            createdAt: t.createdAt ? String(t.createdAt) : null,
            url: String(t.url ?? `https://x.com/${t.handle || "i"}/status/${id}`),
          });
        }
      }
    }
  } catch (e) {
    log.debug(`Twitter DOM 提取失败: ${/** @type {Error} */ (e).message}`);
  }

  const list = [...map.values()].slice(0, maxTweets);
  log.info(`Twitter 抓取 ${targetUrl} graphql+dom=${list.length}`);
  return list;
}

/**
 * @param {{
 *   host: string,
 *   port: number,
 *   lists: Array<{ id: string, url: string, label: string, kind?: string }>,
 *   maxPerList: number,
 *   log: ReturnType<typeof import("./logger.js").createLogger>,
 * }} opts
 */
export async function fetchTwitterListsViaCdp(opts) {
  const host = opts.host || "127.0.0.1";
  const port = Number(opts.port) || 9222;
  const maxPerList = opts.maxPerList || 20;
  const connectUrl = twitterCdpBaseUrl(host, port);
  const endpoint = await resolveCdpEndpoint(connectUrl);
  let browser;
  try {
    browser = await withLocalhostNoProxy(() => chromium.connectOverCDP(endpoint));
  } catch (e) {
    throw new Error(
      `无法连接 CDP ${connectUrl}: ${/** @type {Error} */ (e).message}（请用 --remote-debugging-port=${port} 启动已登录 X 的 Chrome）`
    );
  }

  /** @type {Array<{ list: { id: string, url: string, label: string }, tweets: ReturnType<typeof extractTweetsFromGraphqlJson>, error?: string }>} */
  const results = [];
  try {
    const page = await findOrCreateXPage(browser);
    for (const list of opts.lists) {
      try {
        const tweets = await scrapePageTweets(page, list.url, maxPerList, opts.log);
        results.push({ list, tweets });
      } catch (e) {
        results.push({
          list,
          tweets: [],
          error: /** @type {Error} */ (e).message,
        });
      }
    }
  } finally {
    try {
      await browser.close();
    } catch {
      /* disconnect only */
    }
  }
  return results;
}
