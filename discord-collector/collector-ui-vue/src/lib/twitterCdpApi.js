/** @param {RequestInit} [init] */
async function req(path, init) {
  const res = await fetch(path, {
    headers: { "Content-Type": "application/json", ...(init?.headers || {}) },
    ...init,
  });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || j.ok === false) throw new Error(j.error || `HTTP ${res.status}`);
  return j;
}

export async function fetchTwitterCdpStatus() {
  return req("/api/twitter-cdp/status");
}

/** @param {Record<string, unknown>} body */
export async function saveTwitterCdpConfig(body) {
  return req("/api/twitter-cdp/config", { method: "PUT", body: JSON.stringify(body) });
}

/** @param {{ port?: number, host?: string }} [body] */
export async function probeTwitterCdp(body = {}) {
  return req("/api/twitter-cdp/probe", { method: "POST", body: JSON.stringify(body) });
}

export async function runTwitterCdpFetch() {
  return req("/api/twitter-cdp/fetch", { method: "POST", body: "{}" });
}

/** @param {string} [listId] */
export async function resetTwitterCdpSeen(listId) {
  return req("/api/twitter-cdp/seen/reset", {
    method: "POST",
    body: JSON.stringify({ listId: listId || "" }),
  });
}
