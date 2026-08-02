/**
 * 社区前端 API
 */
const TOKEN_KEY = "dc_community_token";

export function getCommunityToken() {
  try {
    return localStorage.getItem(TOKEN_KEY) || "";
  } catch {
    return "";
  }
}

export function setCommunityToken(token) {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    /* ignore */
  }
}

/**
 * @param {string} path
 * @param {RequestInit & { json?: unknown }} [opts]
 */
async function communityFetch(path, opts = {}) {
  const headers = {
    Accept: "application/json",
    ...(opts.headers || {}),
  };
  const token = getCommunityToken();
  if (token) headers["X-Community-Token"] = token;
  /** @type {RequestInit} */
  const init = { ...opts, headers };
  if (opts.json !== undefined) {
    headers["Content-Type"] = "application/json";
    init.body = JSON.stringify(opts.json);
    delete /** @type {any} */ (init).json;
  }
  const res = await fetch(path, init);
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    const err = new Error(data.error || `HTTP ${res.status}`);
    /** @type {any} */ (err).status = res.status;
    throw err;
  }
  return data;
}

export function fetchCommunityOverview() {
  return communityFetch("/api/community/overview");
}

export function fetchCommunityTitles() {
  return communityFetch("/api/community/titles");
}

export function fetchLeaderboard(limit = 20) {
  return communityFetch(`/api/community/leaderboard?limit=${limit}`);
}

/**
 * @param {{ displayName: string, handle?: string, avatarUrl?: string, bio?: string }} body
 */
export async function registerCommunityMember(body) {
  const data = await communityFetch("/api/community/register", { method: "POST", json: body });
  if (data.token) setCommunityToken(data.token);
  return data;
}

export function fetchCommunityMe() {
  return communityFetch("/api/community/me");
}

export function patchCommunityMe(body) {
  return communityFetch("/api/community/me", { method: "PATCH", json: body });
}

export function postCheckin() {
  return communityFetch("/api/community/checkin", { method: "POST", json: {} });
}

export function fetchCheckinHistory(limit = 30) {
  return communityFetch(`/api/community/checkin/history?limit=${limit}`);
}

export function fetchPosts(limit = 30) {
  return communityFetch(`/api/community/posts?limit=${limit}`);
}

export function createPost(content) {
  return communityFetch("/api/community/posts", { method: "POST", json: { content } });
}

export function addComment(postId, content) {
  return communityFetch(`/api/community/posts/${postId}/comments`, {
    method: "POST",
    json: { content },
  });
}

export function toggleLike(postId) {
  return communityFetch(`/api/community/posts/${postId}/like`, { method: "POST", json: {} });
}

export function fetchTips(limit = 40) {
  return communityFetch(`/api/community/tips?limit=${limit}`);
}

/**
 * @param {{ toHandle?: string, toMemberId?: number, amount: number, message?: string }} body
 */
export function sendTip(body) {
  return communityFetch("/api/community/tips", { method: "POST", json: body });
}

export function logoutCommunity() {
  setCommunityToken("");
}
