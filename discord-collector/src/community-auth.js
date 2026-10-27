/**
 * 社区认证：邮箱密码（scrypt）+ Google ID Token 校验。
 */
import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { config } from "./config.js";

const scryptAsync = promisify(scrypt);

const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;
const SCRYPT_KEYLEN = 64;

/** @param {string} email */
export function normalizeEmail(email) {
  return String(email ?? "")
    .trim()
    .toLowerCase()
    .slice(0, 255);
}

/** @param {string} email */
export function isValidEmail(email) {
  const e = normalizeEmail(email);
  // 实用校验，不追绝对 RFC
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(e) && e.length >= 5 && e.length <= 255;
}

/** 是否 Google 系邮箱（gmail / googlemail） */
export function isGoogleMail(email) {
  const e = normalizeEmail(email);
  return e.endsWith("@gmail.com") || e.endsWith("@googlemail.com");
}

/**
 * @param {string} password
 * @returns {Promise<string>}
 */
export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derived = /** @type {Buffer} */ (
    await scryptAsync(String(password), salt, SCRYPT_KEYLEN, {
      N: SCRYPT_N,
      r: SCRYPT_R,
      p: SCRYPT_P,
    })
  );
  return `scrypt$${SCRYPT_N}$${SCRYPT_R}$${SCRYPT_P}$${salt}$${derived.toString("hex")}`;
}

/**
 * @param {string} password
 * @param {string} stored
 */
export async function verifyPassword(password, stored) {
  const parts = String(stored || "").split("$");
  if (parts[0] !== "scrypt" || parts.length !== 6) return false;
  const n = Number(parts[1]);
  const r = Number(parts[2]);
  const p = Number(parts[3]);
  const salt = parts[4];
  const hashHex = parts[5];
  if (!salt || !hashHex || !Number.isFinite(n)) return false;
  const derived = /** @type {Buffer} */ (
    await scryptAsync(String(password), salt, SCRYPT_KEYLEN, { N: n, r, p })
  );
  const expected = Buffer.from(hashHex, "hex");
  if (expected.length !== derived.length) return false;
  return timingSafeEqual(expected, derived);
}

/**
 * 校验 Google Identity Services 返回的 ID Token。
 * @param {string} idToken
 * @returns {Promise<{
 *   sub: string,
 *   email: string,
 *   emailVerified: boolean,
 *   name: string,
 *   picture: string,
 * }>}
 */
export async function verifyGoogleIdToken(idToken) {
  const clientId = config.communityGoogleClientId;
  if (!clientId) {
    const err = new Error("未配置 Google 登录（COMMUNITY_GOOGLE_CLIENT_ID）");
    err.code = "BAD_REQUEST";
    throw err;
  }
  const token = String(idToken ?? "").trim();
  if (!token || token.length > 8_000) {
    const err = new Error("缺少 Google 凭证");
    err.code = "BAD_REQUEST";
    throw err;
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 8_000);
  try {
    const url = `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(token)}`;
    const res = await fetch(url, { signal: controller.signal });
    const data = /** @type {Record<string, string>} */ (await res.json().catch(() => ({})));
    if (!res.ok) {
      const err = new Error(data.error_description || data.error || "Google 凭证无效");
      err.code = "UNAUTHORIZED";
      throw err;
    }
    const aud = String(data.aud || "");
    if (aud !== clientId) {
      const err = new Error("Google 凭证与本站客户端不匹配");
      err.code = "UNAUTHORIZED";
      throw err;
    }
    const email = normalizeEmail(data.email);
    if (!email || !isValidEmail(email)) {
      const err = new Error("Google 账号未提供有效邮箱");
      err.code = "BAD_REQUEST";
      throw err;
    }
    if (String(data.email_verified) !== "true") {
      const err = new Error("请使用已验证的 Google 邮箱");
      err.code = "BAD_REQUEST";
      throw err;
    }
    const sub = String(data.sub || "").trim();
    if (!sub) {
      const err = new Error("Google 凭证缺少用户标识");
      err.code = "UNAUTHORIZED";
      throw err;
    }
    return {
      sub,
      email,
      emailVerified: true,
      name: String(data.name || data.given_name || "").trim().slice(0, 64),
      picture: String(data.picture || "").trim().slice(0, 512),
    };
  } finally {
    clearTimeout(timer);
  }
}

/** 从邮箱生成候选 handle */
export function handleFromEmail(email) {
  const local = normalizeEmail(email).split("@")[0] || "user";
  const base = local
    .replace(/[^a-z0-9_]/gi, "")
    .toLowerCase()
    .slice(0, 20);
  return base || `u${createHash("sha1").update(email).digest("hex").slice(0, 8)}`;
}
