/**
 * 社区前端 API
 */
const TOKEN_KEY = "dc_community_token";

/** 打赏功能暂隐；改 true 可恢复入口 */
export const SHOW_COMMUNITY_TIPS = false;

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

export function fetchCommunityAuthConfig() {
  return communityFetch("/api/community/auth/config");
}

/**
 * @param {{ email: string, password: string, displayName?: string, handle?: string }} body
 */
export async function registerCommunityWithEmail(body) {
  const data = await communityFetch("/api/community/auth/register", { method: "POST", json: body });
  if (data.token) setCommunityToken(data.token);
  return data;
}

/**
 * @param {{ email: string, password: string }} body
 */
export async function loginCommunityWithEmail(body) {
  const data = await communityFetch("/api/community/auth/login", { method: "POST", json: body });
  if (data.token) setCommunityToken(data.token);
  return data;
}

/**
 * @param {string} idToken
 */
export async function loginCommunityWithGoogle(idToken) {
  const data = await communityFetch("/api/community/auth/google", {
    method: "POST",
    json: { idToken },
  });
  if (data.token) setCommunityToken(data.token);
  return data;
}

export function fetchCommunityMe() {
  return communityFetch("/api/community/me");
}

export function patchCommunityMe(body) {
  return communityFetch("/api/community/me", { method: "PATCH", json: body });
}

export function updateMyAvatar(avatarUrl) {
  return communityFetch("/api/community/me/avatar", {
    method: "PATCH",
    json: { avatarUrl },
  });
}

export function fetchAvatarPacks() {
  return communityFetch("/api/community/avatar-packs");
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

/**
 * @param {{ limit?: number, before?: number }} [opts]
 */
export function fetchChatMessages(opts = {}) {
  const q = new URLSearchParams();
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.before) q.set("before", String(opts.before));
  const qs = q.toString();
  return communityFetch(`/api/community/chat/messages${qs ? `?${qs}` : ""}`);
}

/**
 * @param {{ type: string, content?: string, mediaUrl?: string }} body
 */
export function sendChatMessage(body) {
  return communityFetch("/api/community/chat/messages", { method: "POST", json: body });
}

/**
 * @param {File} file
 */
export async function uploadChatMedia(file) {
  const fd = new FormData();
  fd.append("file", file);
  const headers = {};
  const token = getCommunityToken();
  if (token) headers["X-Community-Token"] = token;
  const res = await fetch("/api/community/chat/media", { method: "POST", headers, body: fd });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.ok === false) {
    throw new Error(data.error || `HTTP ${res.status}`);
  }
  return data;
}

export function logoutCommunity() {
  setCommunityToken("");
}

/**
 * @param {{ type?: "card"|"twitter", limit?: number, beforeId?: number }} [opts]
 */
export function fetchCommunityFeed(opts = {}) {
  const q = new URLSearchParams();
  if (opts.type) q.set("type", opts.type);
  if (opts.limit) q.set("limit", String(opts.limit));
  if (opts.beforeId) q.set("beforeId", String(opts.beforeId));
  const qs = q.toString();
  return communityFetch(`/api/community/feed${qs ? `?${qs}` : ""}`);
}

/**
 * @param {number} [limit]
 */
export function fetchTwitterAuthors(limit = 200) {
  return communityFetch(`/api/community/twitter/authors?limit=${limit}`);
}

/**
 * @param {{ authorKey: string, handle?: string, displayName?: string, avatarUrl?: string, note?: string }} body
 */
export function upsertTwitterAuthor(body) {
  return communityFetch("/api/community/twitter/authors", { method: "POST", json: body });
}
