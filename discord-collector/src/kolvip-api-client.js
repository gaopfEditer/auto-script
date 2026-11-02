/**
 * 巨鲸 kolvip.vip 官方 HTTP API（/api-v1，x-wtoken）。
 * 端点来自 SPA 内嵌脚本（webu/*）。
 */

export const KOLVIP_API_SUCCESS = 20000;
export const KOLVIP_API_AUTH_CODE = 50008;

export class KolvipApiError extends Error {
  /** @param {string} message @param {'auth'|'net'|'biz'} kind */
  constructor(message, kind = "biz") {
    super(message);
    this.name = "KolvipApiError";
    this.kind = kind;
  }
}

/**
 * @typedef {{
 *   baseUrl: string,
 *   wtoken: string,
 *   timeoutMs?: number,
 * }} KolvipApiClientOpts
 */

/**
 * @param {KolvipApiClientOpts} client
 * @param {string} path
 * @param {{ method?: string, body?: unknown, auth?: boolean, timeoutMs?: number }} [req]
 */
export async function kolvipApiRequest(client, path, req = {}) {
  const method = req.method || "GET";
  const auth = req.auth !== false;
  const timeoutMs = req.timeoutMs ?? client.timeoutMs ?? 15_000;
  const headers = { Accept: "application/json" };
  if (req.body !== undefined && method !== "GET") {
    headers["Content-Type"] = "application/json";
  }
  if (auth && client.wtoken) {
    headers["x-wtoken"] = client.wtoken;
  }
  const base = String(client.baseUrl ?? "").replace(/\/$/, "");
  const url = `${base}${path.startsWith("/") ? path : `/${path}`}`;
  let res;
  try {
    res = await fetch(url, {
      method,
      headers,
      body: req.body !== undefined ? JSON.stringify(req.body) : undefined,
      cache: "no-store",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new KolvipApiError(
      `kolvip API 网络失败: ${/** @type {Error} */ (e).message}`,
      "net"
    );
  }
  const ct = res.headers.get("content-type") || "";
  if (!ct.includes("json")) {
    throw new KolvipApiError(`kolvip API 非 JSON 响应 (${res.status})`, "net");
  }
  const j = await res.json();
  if (j?.code === KOLVIP_API_SUCCESS) {
    return j.data;
  }
  const msg = String(j?.message ?? "请求失败");
  if (j?.code === KOLVIP_API_AUTH_CODE) {
    throw new KolvipApiError(
      msg.includes("封禁") ? msg : "登录已失效，请更新 wtoken",
      "auth"
    );
  }
  throw new KolvipApiError(msg, "biz");
}

/** @param {KolvipApiClientOpts} client */
export async function kolvipApiPing(client) {
  return kolvipApiRequest(client, "/webu/ping", { auth: false, timeoutMs: 5000 });
}

/**
 * @param {KolvipApiClientOpts} client
 * @param {{ markRead?: boolean }} [opts]
 */
export async function kolvipApiListChannels(client, opts = {}) {
  return kolvipApiRequest(client, "/webu/channels", {
    method: "POST",
    body: { read: !!opts.markRead },
  });
}

/**
 * @param {KolvipApiClientOpts} client
 * @param {string|number} channelId
 * @param {{ beforeId?: number, limit?: number }} [opts]
 */
export async function kolvipApiFetchChannelMessages(client, channelId, opts = {}) {
  const ch = encodeURIComponent(String(channelId).trim());
  const before = Math.max(0, Number(opts.beforeId) || 0);
  const limit = Math.min(150, Math.max(1, Number(opts.limit) || 40));
  const data = await kolvipApiRequest(
    client,
    `/webu/messages?channel_id=${ch}&before_id=${before}&limit=${limit}`,
    { method: "GET" }
  );
  if (Array.isArray(data)) return data;
  if (data && Array.isArray(data.messages)) return data.messages;
  return [];
}
