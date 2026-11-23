/**
 * 巨鲸 wtoken：env / 本地文件 / CDP localStorage 兜底。
 */
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "./config.js";
import { kolvipWebUrl } from "./kolvip-cdp-config.js";
import { parseCdpConnectHostPort } from "./kolvip-cdp-connect.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_TOKEN_FILE = path.join(__dirname, "..", "data", "kolvip-api-token.json");

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

/**
 * @param {unknown} raw
 * @returns {string}
 */
export function parseWtokenFromLocalStorageExport(raw) {
  if (!raw || typeof raw !== "object") return "";
  const o = /** @type {Record<string, unknown>} */ (raw);
  if (typeof o.wtoken === "string" && o.wtoken.trim()) return o.wtoken.trim();
  const direct = o["wv.wtoken"];
  if (typeof direct === "string" && direct.trim()) {
    try {
      const parsed = JSON.parse(direct);
      if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
    } catch {
      return direct.trim();
    }
  }
  if (Array.isArray(o)) {
    for (const row of o) {
      if (!row || typeof row !== "object") continue;
      const name = String(/** @type {{ name?: string }} */ (row).name ?? "");
      if (name === "wv.wtoken" || name === "wtoken") {
        const val = String(/** @type {{ value?: string }} */ (row).value ?? "").trim();
        if (!val) continue;
        try {
          const parsed = JSON.parse(val);
          if (typeof parsed === "string" && parsed.trim()) return parsed.trim();
        } catch {
          return val;
        }
      }
    }
  }
  return "";
}

/**
 * @param {string} filePath
 */
export async function readWtokenFromFile(filePath) {
  const p = filePath.trim();
  if (!p) return "";
  try {
    const raw = await fs.readFile(p, "utf8");
    const j = JSON.parse(raw);
    if (typeof j === "string" && j.trim()) return j.trim();
    if (j && typeof j === "object") {
      const fromObj = parseWtokenFromLocalStorageExport(j);
      if (fromObj) return fromObj;
      const w = String(/** @type {{ wtoken?: string }} */ (j).wtoken ?? "").trim();
      if (w) return w;
    }
  } catch {
    /* ignore */
  }
  return "";
}

/**
 * @param {string} connectUrl
 */
export async function extractWtokenFromCdp(connectUrl) {
  const url = String(connectUrl ?? "").trim();
  if (!url) return "";
  const { base } = parseCdpConnectHostPort(url);
  let endpoint = base;
  try {
    const verRes = await withLocalhostNoProxy(() =>
      fetch(`${base}/json/version`, { signal: AbortSignal.timeout(5_000) })
    );
    if (verRes.ok) {
      const j = await verRes.json();
      endpoint = String(j.webSocketDebuggerUrl || base).trim() || base;
    }
  } catch {
    /* use base */
  }
  let browser;
  try {
    const { chromium } = await import("playwright");
    browser = await withLocalhostNoProxy(() => chromium.connectOverCDP(endpoint));
    let page = null;
    for (const ctx of browser.contexts()) {
      for (const p of ctx.pages()) {
        if (/kolvip\.vip/i.test(p.url())) {
          page = p;
          break;
        }
      }
      if (page) break;
    }
    if (!page) {
      const ctx = browser.contexts()[0] || (await browser.newContext());
      page = await ctx.newPage();
      await page.goto(kolvipWebUrl(), { waitUntil: "domcontentloaded", timeout: 30_000 });
    }
    const token = await page.evaluate(() => {
      try {
        const v = localStorage.getItem("wv.wtoken");
        if (v == null) return "";
        const parsed = JSON.parse(v);
        return typeof parsed === "string" ? parsed : String(parsed ?? "");
      } catch {
        return "";
      }
    });
    return String(token ?? "").trim();
  } finally {
    await browser?.close().catch(() => {});
  }
}

/**
 * @param {ReturnType<typeof import('./logger.js').createLogger>} [log]
 */
async function readWtokenFromCdpIfEnabled(log) {
  if (!config.kolvipApiCdpTokenSync) return "";
  const connectUrl = (config.kolvipCdpConnectUrl || config.cdpConnectUrl || "").trim();
  if (!connectUrl) return "";
  try {
    const fromCdp = await extractWtokenFromCdp(connectUrl);
    if (fromCdp) {
      log?.info?.(
        `巨鲸 wtoken 已从 CDP localStorage 读取（${connectUrl}，未写入磁盘）`
      );
      return fromCdp;
    }
  } catch (e) {
    log?.warn?.(`巨鲸 CDP 取 token 失败: ${/** @type {Error} */ (e).message}`);
  }
  return "";
}

/**
 * @param {ReturnType<typeof import('./logger.js').createLogger>} [log]
 */
export async function resolveKolvipApiWtoken(log) {
  const fromEnv = String(config.kolvipApiWtoken ?? "").trim();
  if (fromEnv) return { wtoken: fromEnv, source: "env" };

  const tokenFile =
    String(config.kolvipApiTokenFile ?? "").trim() || DEFAULT_TOKEN_FILE;
  const lsFile = String(config.kolvipApiLocalStorageFile ?? "").trim();

  const readFileChain = async () => {
    const fromFile = await readWtokenFromFile(tokenFile);
    if (fromFile) return { wtoken: fromFile, source: "file" };
    if (lsFile) {
      try {
        const raw = JSON.parse(await fs.readFile(lsFile, "utf8"));
        const fromLs = parseWtokenFromLocalStorageExport(raw);
        if (fromLs) return { wtoken: fromLs, source: "localStorage-export" };
      } catch {
        /* ignore */
      }
    }
    return { wtoken: "", source: "none" };
  };

  if (config.kolvipApiWtokenPriority === "cdp-first") {
    const fromCdp = await readWtokenFromCdpIfEnabled(log);
    if (fromCdp) return { wtoken: fromCdp, source: "cdp-localStorage" };
    const fallback = await readFileChain();
    if (fallback.wtoken) {
      log?.info?.("巨鲸 wtoken 使用本地文件兜底（CDP 未取到）");
      return fallback;
    }
    return { wtoken: "", source: "none" };
  }

  const fallback = await readFileChain();
  if (fallback.wtoken) return fallback;

  const fromCdp = await readWtokenFromCdpIfEnabled(log);
  if (fromCdp) return { wtoken: fromCdp, source: "cdp-localStorage" };

  return { wtoken: "", source: "none" };
}
