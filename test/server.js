/**
 * Token 鉴权测试后台（纯 Node，无第三方依赖）
 *
 * ---------------------------------------------------------------------------
 * Token 机制（自定义两段，不是标准 JWT）
 * ---------------------------------------------------------------------------
 *
 * 1) 形态：base64url(payload) + "." + 30位随机字母数字
 * 2) 签名：每次签发用 randomBytes 生成，不用 SECRET / HMAC
 * 3) 校验：本进程内存登记已签发 token；未登记 → 无效；登记但过期 → TOKEN_EXPIRED
 * 4) 刷新：已登记即可换发（过期也行）
 *
 * 启动：cd test && node server.js
 * 端口：PORT（默认 3981）  默认 TTL：TOKEN_TTL_SEC
 * ---------------------------------------------------------------------------
 */
import http from "node:http";
import { randomBytes } from "node:crypto";
import { URL } from "node:url";

const PORT = Number(process.env.PORT) || 3981;
/** 默认有效期（秒）；可用环境变量覆盖，也可用发 token 时的 ttlSeconds */
const DEFAULT_TTL_SEC = Math.max(5, Number(process.env.TOKEN_TTL_SEC) || 60);

/** 本进程已签发的完整 token（随机签名无法靠密钥复算，只能登记） */
const issuedTokens = new Set();

/**
 * @param {unknown} obj
 */
function b64urlJson(obj) {
  return Buffer.from(JSON.stringify(obj), "utf8").toString("base64url");
}

/**
 * @param {string} s
 */
function fromB64urlJson(s) {
  return JSON.parse(Buffer.from(s, "base64url").toString("utf8"));
}

/** 完全随机的 30 位字母数字（不用 SECRET） */
function randomSig30() {
  const alphabet =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  const bytes = randomBytes(30);
  let out = "";
  for (let i = 0; i < 30; i += 1) {
    out += alphabet[bytes[i] % alphabet.length];
  }
  return out;
}

/**
 * @param {{ sub?: string, ttlSeconds?: number }} [opts]
 */
function issueToken(opts = {}) {
  const ttl = Math.max(1, Number(opts.ttlSeconds) || DEFAULT_TTL_SEC);
  const now = Math.floor(Date.now() / 1000);
  const payload = {
    sub: String(opts.sub || "test-user"),
    iat: now,
    exp: now + ttl,
    jti: randomBytes(8).toString("hex"),
  };
  const payloadB64 = b64urlJson(payload);
  const token = `${payloadB64}.${randomSig30()}`;
  issuedTokens.add(token);
  return {
    token,
    expiresAt: new Date(payload.exp * 1000).toISOString(),
    expiresIn: ttl,
    payload,
  };
}

/**
 * @param {string} token
 * @returns {{ ok: true, payload: Record<string, unknown> } | { ok: false, code: string, message: string, payload?: Record<string, unknown> }}
 */
function verifyToken(token) {
  const raw = String(token || "").trim();
  if (!raw || !raw.includes(".")) {
    return { ok: false, code: "TOKEN_MISSING", message: "缺少 token" };
  }

  const parts = raw.split(".");
  if (parts.length !== 2) {
    return {
      ok: false,
      code: "TOKEN_INVALID",
      message: parts.length === 3
        ? "token 无效（疑似外部 JWT，本服只认「载荷.30位随机串」两段格式）"
        : "token 格式无效",
    };
  }
  const [payloadB64, sig] = parts;
  if (!payloadB64 || !sig || sig.length !== 30) {
    return { ok: false, code: "TOKEN_INVALID", message: "token 格式无效" };
  }

  if (!issuedTokens.has(raw)) {
    return { ok: false, code: "TOKEN_INVALID", message: "token 无效（非本服签发或已失效）" };
  }

  let payload;
  try {
    payload = fromB64urlJson(payloadB64);
  } catch {
    return { ok: false, code: "TOKEN_INVALID", message: "token 载荷无法解析" };
  }

  const exp = Number(payload.exp);
  const now = Math.floor(Date.now() / 1000);
  if (!Number.isFinite(exp) || now >= exp) {
    return {
      ok: false,
      code: "TOKEN_EXPIRED",
      message: "token 过期，请更新 token",
      payload,
    };
  }
  return { ok: true, payload };
}

/**
 * @param {http.IncomingMessage} req
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on("data", (c) => chunks.push(c));
    req.on("end", () => {
      const raw = Buffer.concat(chunks).toString("utf8");
      if (!raw) {
        resolve({});
        return;
      }
      try {
        resolve(JSON.parse(raw));
      } catch {
        reject(Object.assign(new Error("JSON 无效"), { status: 400 }));
      }
    });
    req.on("error", reject);
  });
}

/**
 * @param {http.IncomingMessage} req
 * @param {URL} url
 */
function extractToken(req, url) {
  const auth = String(req.headers.authorization || "");
  const m = auth.match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  const h = String(req.headers["x-access-token"] || "").trim();
  if (h) return h;
  const q = url.searchParams.get("token");
  return q ? String(q).trim() : "";
}

/**
 * @param {http.ServerResponse} res
 * @param {number} status
 * @param {Record<string, unknown>} body
 */
function sendJson(res, status, body) {
  const data = JSON.stringify(body, null, 2);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Headers": "Content-Type, Authorization, X-Access-Token",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  });
  res.end(data);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
  const method = (req.method || "GET").toUpperCase();

  if (method === "OPTIONS") {
    sendJson(res, 204, {});
    return;
  }

  try {
    // 健康检查
    if (method === "GET" && url.pathname === "/health") {
      sendJson(res, 200, { ok: true, service: "token-auth-test", defaultTtlSec: DEFAULT_TTL_SEC });
      return;
    }

    // 签发 token（可指定短过期，方便测过期）
    // POST /api/token  { "sub"?: "alice", "ttlSeconds"?: 5 }
    if (method === "POST" && url.pathname === "/api/token") {
      const body = /** @type {{ sub?: string, ttlSeconds?: number }} */ (await readBody(req));
      const issued = issueToken(body);
      sendJson(res, 200, {
        ok: true,
        message: "已签发 token",
        token: issued.token,
        expiresAt: issued.expiresAt,
        expiresIn: issued.expiresIn,
        tip: "请求受保护接口时请带 Authorization: Bearer <token>",
      });
      return;
    }

    // 快速签发「已过期」token，方便客户端直接测过期分支
    // POST /api/token/expired
    if (method === "POST" && url.pathname === "/api/token/expired") {
      const body = /** @type {{ sub?: string }} */ (await readBody(req));
      const now = Math.floor(Date.now() / 1000);
      const payload = {
        sub: String(body.sub || "test-user"),
        iat: now - 120,
        exp: now - 60,
        jti: randomBytes(8).toString("hex"),
      };
      const payloadB64 = b64urlJson(payload);
      const token = `${payloadB64}.${randomSig30()}`;
      issuedTokens.add(token);
      sendJson(res, 200, {
        ok: true,
        message: "已签发「已过期」token（仅用于测试）",
        token,
        expiresAt: new Date(payload.exp * 1000).toISOString(),
      });
      return;
    }

    // 受保护资源：正确 → 成功；过期 → 请更新
    // GET /api/protected
    if (method === "GET" && url.pathname === "/api/protected") {
      const token = extractToken(req, url);
      const result = verifyToken(token);
      if (result.ok) {
        sendJson(res, 200, {
          ok: true,
          message: "访问成功",
          user: result.payload.sub,
          expiresAt: new Date(Number(result.payload.exp) * 1000).toISOString(),
        });
        return;
      }
      if (result.code === "TOKEN_EXPIRED") {
        sendJson(res, 401, {
          ok: false,
          code: "TOKEN_EXPIRED",
          message: "token 过期，请更新 token",
          hint: "调用 POST /api/token/refresh（可带过期 token）或重新 POST /api/token",
        });
        return;
      }
      sendJson(res, 401, {
        ok: false,
        code: result.code,
        message: result.message,
      });
      return;
    }

    // 更新 / 刷新 token（允许用过期但签名仍正确的 token 换新）
    // POST /api/token/refresh
    if (method === "POST" && url.pathname === "/api/token/refresh") {
      const body = /** @type {{ token?: string, ttlSeconds?: number }} */ (await readBody(req));
      const token = String(body.token || extractToken(req, url) || "").trim();
      const result = verifyToken(token);

      // 签名无效 / 缺失 → 不能刷新
      if (!result.ok && result.code !== "TOKEN_EXPIRED") {
        sendJson(res, 401, {
          ok: false,
          code: result.code,
          message: result.message || "无法刷新：token 无效",
        });
        return;
      }

      let sub = "test-user";
      if (result.ok) {
        sub = String(result.payload.sub || sub);
      } else if (result.payload && typeof result.payload === "object") {
        sub = String(/** @type {Record<string, unknown>} */ (result.payload).sub || sub);
      }

      const issued = issueToken({ sub, ttlSeconds: body.ttlSeconds });
      sendJson(res, 200, {
        ok: true,
        message: result.ok ? "token 已更新" : "token 已过期，已为你签发新 token",
        token: issued.token,
        expiresAt: issued.expiresAt,
        expiresIn: issued.expiresIn,
        previousExpired: !result.ok,
      });
      return;
    }

    // 帮助页
    if (method === "GET" && (url.pathname === "/" || url.pathname === "/api")) {
      sendJson(res, 200, {
        ok: true,
        service: "token-auth-test",
        endpoints: {
          "POST /api/token": "签发有效 token（body: { ttlSeconds?, sub? }）",
          "POST /api/token/expired": "签发已过期 token（测过期分支）",
          "GET /api/protected": "Bearer token → 成功 / 过期提示",
          "POST /api/token/refresh": "用旧/过期 token 换新（body: { token?, ttlSeconds? }）",
        },
        examples: {
          issue: `curl -s -X POST http://127.0.0.1:${PORT}/api/token -H "Content-Type: application/json" -d "{\\"ttlSeconds\\":30}"`,
          access: `curl -s http://127.0.0.1:${PORT}/api/protected -H "Authorization: Bearer <token>"`,
          expired: `curl -s -X POST http://127.0.0.1:${PORT}/api/token/expired`,
          refresh: `curl -s -X POST http://127.0.0.1:${PORT}/api/token/refresh -H "Content-Type: application/json" -d "{\\"token\\":\\"<old>\\"}"`,
        },
      });
      return;
    }

    sendJson(res, 404, { ok: false, message: "not found" });
  } catch (e) {
    const err = /** @type {Error & { status?: number }} */ (e);
    sendJson(res, err.status || 500, { ok: false, message: err.message || "internal error" });
  }
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`[token-auth-test] http://127.0.0.1:${PORT}`);
  console.log(`  默认 TTL=${DEFAULT_TTL_SEC}s  签名=30位真随机（内存登记）`);
  console.log(`  文档: GET /`);
});
