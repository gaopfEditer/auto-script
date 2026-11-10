/**
 * 本地 HTTP 代理互备。端口顺序与 oi_mornitor/proxy_resolve.py 一致（默认 7890–7894）。
 * 配置端口 TCP 不可达时改用第一个可达回退端口；全部不可达时仍返回原配置，避免误改直连。
 */
import net from "node:net";
import { createLogger } from "./logger.js";

const log = createLogger("proxy");

const DEFAULT_PORTS = [7890, 7891, 7892, 7893, 7894];

/** @type {{ url: string, expires: number } | null} */
let cache = null;
/** @type {string} */
let lastSwitch = "";

export function invalidateLocalProxyCache() {
  cache = null;
}

/** @returns {number[]} */
export function localProxyFallbackPorts() {
  const raw = String(process.env.OI_PROXY_FALLBACK_PORTS ?? "").trim();
  if (!raw) return [...DEFAULT_PORTS];
  /** @type {number[]} */
  const out = [];
  for (const part of raw.split(/[,;\s]+/)) {
    const n = Number(part);
    if (Number.isInteger(n) && n > 0 && n < 65536) out.push(n);
  }
  return out.length ? out : [...DEFAULT_PORTS];
}

/**
 * @param {string} host
 * @param {number} port
 * @param {number} [timeoutMs]
 */
export function tcpPortOpen(host, port, timeoutMs = 400) {
  return new Promise((resolve) => {
    const socket = net.connect({ host, port, family: 4 });
    let settled = false;
    const finish = (ok) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs);
    socket.once("connect", () => finish(true));
    socket.once("timeout", () => finish(false));
    socket.once("error", () => finish(false));
  });
}

/**
 * @param {string} configured
 * @returns {{ host: string, port: number } | null}
 */
function parseProxy(configured) {
  const raw = String(configured ?? "").trim();
  if (!raw) return null;
  try {
    const u = new URL(raw.includes("://") ? raw : `http://${raw}`);
    const port = u.port ? Number(u.port) : u.protocol === "https:" ? 443 : 80;
    if (!Number.isFinite(port) || port <= 0) return null;
    return { host: u.hostname || "127.0.0.1", port };
  } catch {
    return null;
  }
}

/** @param {string} host */
function isLocalHost(host) {
  const h = String(host ?? "").toLowerCase();
  return h === "127.0.0.1" || h === "localhost" || h === "::1";
}

/**
 * @param {string} [configured]
 * @param {{
 *   probe?: (host: string, port: number) => Promise<boolean> | boolean,
 *   ports?: number[],
 *   now?: () => number,
 *   ttlOkMs?: number,
 *   ttlDeadMs?: number,
 * }} [opts]
 * @returns {Promise<string>}
 */
export async function resolveReachableLocalProxy(configured, opts = {}) {
  const now = opts.now ? opts.now() : Date.now();
  const isolated = Boolean(opts.probe);
  if (!isolated && cache && now < cache.expires) return cache.url;

  const probe = opts.probe ?? ((host, port) => tcpPortOpen(host, port));
  const ports = opts.ports ?? localProxyFallbackPorts();
  const ttlOk = opts.ttlOkMs ?? 30_000;
  const ttlDead = opts.ttlDeadMs ?? 5_000;
  const configuredUrl = String(configured ?? "").trim();

  /** @param {string} url @param {boolean} verified */
  const store = (url, verified) => {
    if (!isolated) cache = { url, expires: now + (verified ? ttlOk : ttlDead) };
    return url;
  };

  const parsed = parseProxy(configuredUrl);
  if (!parsed) {
    for (const port of ports) {
      if (await probe("127.0.0.1", port)) return store(`http://127.0.0.1:${port}`, true);
    }
    return store("", false);
  }

  const host = isLocalHost(parsed.host) ? "127.0.0.1" : parsed.host;
  if (await probe(host, parsed.port)) return store(configuredUrl, true);

  if (isLocalHost(parsed.host)) {
    for (const port of ports) {
      if (port === parsed.port) continue;
      if (await probe("127.0.0.1", port)) {
        const picked = `http://127.0.0.1:${port}`;
        if (!isolated && lastSwitch !== `${configuredUrl}->${picked}`) {
          lastSwitch = `${configuredUrl}->${picked}`;
          log.warn(`本地代理 ${configuredUrl} 不可达，改用 ${picked}`);
        }
        return store(picked, true);
      }
    }
  }

  return store(configuredUrl, false);
}
